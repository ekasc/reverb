import "dotenv/config";

import fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { z } from "zod";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { desc, eq, inArray, or } from "drizzle-orm";
import { env } from "./env";
import { createSqliteDb } from "./db/client";
import {
	oauthStates,
	oauthTokens,
	sessions,
	tournamentBracketState,
	tournamentTracks,
	tournaments,
	users,
} from "./db/schema";
import { encryptString } from "./lib/crypto";
import { buildSpotifyAuthorizeUrl, exchangeSpotifyCode } from "./spotify/auth";
import { getValidAccessToken, spotifyJson } from "./spotify/client";
import { nanoid } from "nanoid";
import {
	computeRanking,
	nextOpenMatch,
	resolveMatchParticipants,
	seededShuffle,
	totalRounds,
} from "./lib/bracket";
import {
	extractPlaylistId,
	fetchPlaylistTracks,
	fetchUserPlaylists,
	fetchUserTopTracks,
	type RankedTrack,
	type SpotifyTimeRange,
} from "./spotify/tracks";

function ensureDir(p: string) {
	fs.mkdirSync(p, { recursive: true });
}

function nowMs() {
	return Date.now();
}

type LoginRole = "host" | "challenger" | "playlist" | "signin" | "playback";

type OauthStateData = {
	role: LoginRole;
	tournamentId?: string;
	returnTo: string;
	appOrigin: string;
	redirectUri: string;
};

type StoredTrackData = {
	id: string;
	name: string;
	artists: Array<{ id: string; name: string }>;
	album: { id: string; name: string; imageUrl: string | null };
	previewUrl: string | null;
	spotifyUrl: string;
	uri: string;
	durationMs: number;
};

async function main() {
	// Ensure sqlite directory exists
	ensureDir(path.dirname(env.DATABASE_URL));

	const { db } = createSqliteDb(env.DATABASE_URL);

	const app = fastify({
		logger: {
			level: env.NODE_ENV === "production" ? "info" : "debug",
		},
	});

	await app.register(cookie, {
		secret: env.SESSION_SECRET,
		hook: "onRequest",
	});

	await app.register(cors, {
		origin: (origin, cb) => {
			// Requests like curl/postman won't send an Origin header
			if (!origin) return cb(null, true);

			if (origin === env.APP_ORIGIN) return cb(null, true);

			// Local dev convenience: allow both localhost and 127.0.0.1 (any port)
			if (
				env.NODE_ENV !== "production" &&
				/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
			) {
				return cb(null, true);
			}

			return cb(new Error(`CORS blocked origin: ${origin}`), false);
		},
		credentials: true,
		methods: ["GET", "POST", "PATCH", "DELETE"],
	});

	app.setErrorHandler((err, _req, reply) => {
		app.log.error({ err }, "request failed");

		if (err instanceof z.ZodError) {
			reply.code(400);
			return reply.send({
				error: {
					code: "bad_request",
					issues: err.issues,
				},
			});
		}

		const message = err instanceof Error ? err.message : "internal_error";
		if (message.startsWith("Missing required Spotify scopes")) {
			reply.code(403);
			return reply.send({
				error: {
					code: "missing_scopes",
					message,
				},
			});
		}

		reply.code(500);
		return reply.send({
			error: {
				code: "internal_error",
				message:
					env.NODE_ENV === "production" ? "internal_error" : message,
			},
		});
	});

	app.get("/api/health", async () => ({ ok: true }));

	app.post("/api/login", async (req, reply) => {
		const bodySchema = z
			.object({
				role: z
					.enum(["host", "challenger", "playlist", "signin", "playback"])
					.optional(),
				tournamentId: z.string().optional(),
				returnTo: z.string().optional(),
				sourceType: z
					.enum(["top_tracks", "playlist", "playlist_vs", "mood"])
					.optional(),
				mesh: z.boolean().optional(),
				mood: z.string().min(1).max(40).optional(),
				hostPlaylistId: z.string().min(1).max(128).optional(),
				timeRange: z
					.enum(["short_term", "medium_term", "long_term"])
					.optional(),
				bracketSize: z
					.number()
					.int()
					.refine((n) => (n & (n - 1)) === 0 && n >= 8 && n <= 64, {
						message: "bracketSize must be power-of-two (8..64)",
					})
					.optional(),
			})
			.default({});

		const body = bodySchema.parse(req.body);
		const role = (body.role ?? "host") satisfies LoginRole | "playback";

		const reqOrigin =
			typeof req.headers.origin === "string" ? req.headers.origin : null;
		const appOrigin =
			reqOrigin &&
			(env.NODE_ENV !== "production"
				? /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(
						reqOrigin,
					) || reqOrigin === env.APP_ORIGIN
				: reqOrigin === env.APP_ORIGIN)
				? reqOrigin
				: env.APP_ORIGIN;

		const redirectUri =
			env.NODE_ENV === "production"
				? env.SPOTIFY_REDIRECT_URI
				: typeof req.headers.host === "string"
					? `http://${req.headers.host}/api/auth/callback`
					: env.SPOTIFY_REDIRECT_URI;

		let tournamentId = body.tournamentId;
		if (role === "host") {
			tournamentId = nanoid(10);
			await db.insert(tournaments).values({
				id: tournamentId,
				sourceType: body.sourceType ?? "top_tracks",
				meshMode: body.mesh ? 1 : 0,
				mood: body.mood ?? null,
				hostPlaylistId: body.hostPlaylistId ?? null,
				challengerPlaylistId: null,
				timeRange: body.timeRange ?? "medium_term",
				bracketSize: body.bracketSize ?? 32,
				status: "waiting_for_host",
				seed: crypto.randomInt(0, 1_000_000_000),
				createdAt: new Date(nowMs()),
				updatedAt: new Date(nowMs()),
			});
		}

		if (role === "challenger" || role === "playlist") {
			if (!tournamentId) {
				reply.code(400);
				return { error: "tournamentId is required" };
			}
			const tournament = await db.query.tournaments.findFirst({
				where: eq(tournaments.id, tournamentId),
			});
			if (!tournament) {
				reply.code(404);
				return { error: "tournament not found" };
			}
			if (role === "challenger" && tournament.challengerUserId) {
				reply.code(409);
				return { error: "tournament already has a challenger" };
			}
		}

		const defaultReturnTo =
			role === "signin" || role === "playback"
				? "/tournaments"
				: tournamentId
					? role === "playlist"
						? `/t/${tournamentId}/results`
						: `/t/${tournamentId}`
					: "/";
		const sanitizeReturnTo = (v: string | undefined) => {
			if (!v) return defaultReturnTo;
			if (!v.startsWith("/")) return defaultReturnTo;
			if (v.startsWith("//")) return defaultReturnTo;
			if (v.includes("\\")) return defaultReturnTo;
			return v;
		};
		const returnTo = sanitizeReturnTo(body.returnTo);

		const readScopes = [
			"user-read-private",
			"user-read-email",
			"user-top-read",
			"playlist-read-private",
			"playlist-read-collaborative",
		];
		const playlistScopes = [
			"playlist-modify-private",
			"playlist-modify-public",
		];
		const playbackScopes = [
			"streaming",
			"user-read-playback-state",
			"user-read-currently-playing",
			"user-modify-playback-state",
		];
		const scopes =
			role === "playlist"
				? [...readScopes, ...playlistScopes]
				: role === "playback"
					? [...readScopes, ...playbackScopes]
					: readScopes;

		const state = crypto.randomBytes(16).toString("hex");
		const expiresAt = nowMs() + 10 * 60 * 1000;
		const data: OauthStateData = {
			role,
			tournamentId,
			returnTo,
			appOrigin,
			redirectUri,
		};
		await db.insert(oauthStates).values({
			state,
			dataJson: JSON.stringify(data),
			createdAt: new Date(nowMs()),
			expiresAt: new Date(expiresAt),
		});

		const authUrl = buildSpotifyAuthorizeUrl({
			state,
			scopes,
			redirectUri,
		});

		return { message: authUrl, err: null };
	});

	app.get("/api/auth/callback", async (req, reply) => {
		const querySchema = z.object({
			code: z.string().optional(),
			state: z.string().optional(),
			error: z.string().optional(),
		});
		const q = querySchema.parse(req.query);

		if (q.error) {
			reply.redirect(
				`${env.APP_ORIGIN}/?error=${encodeURIComponent(q.error)}`,
			);
			return;
		}
		if (!q.code || !q.state) {
			reply.redirect(`${env.APP_ORIGIN}/?error=missing_code_or_state`);
			return;
		}

		const stateRow = await db.query.oauthStates.findFirst({
			where: eq(oauthStates.state, q.state),
		});
		if (!stateRow) {
			reply.redirect(`${env.APP_ORIGIN}/?error=invalid_state`);
			return;
		}
		if (stateRow.expiresAt.getTime() < nowMs()) {
			await db.delete(oauthStates).where(eq(oauthStates.state, q.state));
			reply.redirect(`${env.APP_ORIGIN}/?error=state_expired`);
			return;
		}

		const rawData = JSON.parse(
			stateRow.dataJson,
		) as Partial<OauthStateData>;
		const data: OauthStateData = {
			role: rawData.role as LoginRole,
			tournamentId: rawData.tournamentId,
			returnTo: rawData.returnTo ?? "/",
			appOrigin: rawData.appOrigin ?? env.APP_ORIGIN,
			redirectUri: rawData.redirectUri ?? env.SPOTIFY_REDIRECT_URI,
		};

		try {
			const token = await exchangeSpotifyCode(q.code, data.redirectUri);

			// Fetch profile
			const meResp = await fetch("https://api.spotify.com/v1/me", {
				headers: {
					Authorization: `Bearer ${token.access_token}`,
				},
			});
			if (!meResp.ok) {
				const text = await meResp.text();
				throw new Error(
					`Spotify /me failed (${meResp.status}): ${text}`,
				);
			}
			const me = (await meResp.json()) as {
				id: string;
				display_name: string;
				email?: string;
				country?: string;
				product?: string;
				images?: { url: string }[];
			};

			const existingUser = await db.query.users.findFirst({
				where: eq(users.spotifyId, me.id),
			});
			const userId = existingUser?.id ?? crypto.randomUUID();
			const imageUrl = me.images?.[0]?.url ?? null;
			const email = me.email ?? null;
			const country = me.country ?? null;
			const product = me.product ?? null;

			if (!existingUser) {
				await db.insert(users).values({
					id: userId,
					spotifyId: me.id,
					displayName: me.display_name ?? me.id,
					imageUrl,
					email,
					country,
					product,
					createdAt: new Date(nowMs()),
					updatedAt: new Date(nowMs()),
				});
			} else {
				await db
					.update(users)
					.set({
						displayName:
							me.display_name ?? existingUser.displayName,
						imageUrl,
						email,
						country,
						product,
						updatedAt: new Date(nowMs()),
					})
					.where(eq(users.id, userId));
			}

			const expiresAt = new Date(nowMs() + token.expires_in * 1000);
			const existingTokens = await db.query.oauthTokens.findFirst({
				where: eq(oauthTokens.userId, userId),
			});

			const refreshTokenEnc = token.refresh_token
				? encryptString(token.refresh_token)
				: existingTokens?.refreshTokenEnc;
			if (!refreshTokenEnc) {
				throw new Error(
					"Spotify did not return a refresh_token and none exists",
				);
			}

			if (!existingTokens) {
				await db.insert(oauthTokens).values({
					userId,
					accessTokenEnc: encryptString(token.access_token),
					refreshTokenEnc,
					scope: token.scope,
					expiresAt,
					updatedAt: new Date(nowMs()),
				});
			} else {
				await db
					.update(oauthTokens)
					.set({
						accessTokenEnc: encryptString(token.access_token),
						refreshTokenEnc,
						scope: token.scope,
						expiresAt,
						updatedAt: new Date(nowMs()),
					})
					.where(eq(oauthTokens.userId, userId));
			}

			// Create session cookie
			const sessionId = crypto.randomUUID();
			await db.insert(sessions).values({
				id: sessionId,
				userId,
				createdAt: new Date(nowMs()),
				expiresAt: new Date(nowMs() + 1000 * 60 * 60 * 24 * 30),
			});

			reply.setCookie("sid", sessionId, {
				httpOnly: true,
				secure: env.NODE_ENV === "production",
				sameSite: "lax",
				path: "/",
				maxAge: 60 * 60 * 24 * 30,
			});

			// Attach user to tournament based on role
			if (data.role === "host" && data.tournamentId) {
				const tournament = await db.query.tournaments.findFirst({
					where: eq(tournaments.id, data.tournamentId),
				});
				const nextStatus =
					tournament?.sourceType === "playlist"
						? "ready"
						: "waiting_for_challenger";

				await db
					.update(tournaments)
					.set({
						hostUserId: userId,
						status: nextStatus,
						updatedAt: new Date(nowMs()),
					})
					.where(eq(tournaments.id, data.tournamentId));
			}
			if (data.role === "challenger" && data.tournamentId) {
				const current = await db.query.tournaments.findFirst({
					where: eq(tournaments.id, data.tournamentId),
				});
				if (!current) {
					// ignore
				} else if (
					current.status === "in_progress" ||
					current.status === "completed"
				) {
					await db
						.update(tournaments)
						.set({
							challengerUserId: userId,
							updatedAt: new Date(nowMs()),
						})
						.where(eq(tournaments.id, data.tournamentId));
				} else {
					const nextStatus =
						current.sourceType === "playlist_vs" &&
							!current.challengerPlaylistId
							? "waiting_for_challenger"
							: "ready";
					await db
						.update(tournaments)
						.set({
							challengerUserId: userId,
							status: nextStatus,
							updatedAt: new Date(nowMs()),
						})
						.where(eq(tournaments.id, data.tournamentId));
				}
			}

			await db.delete(oauthStates).where(eq(oauthStates.state, q.state));

			reply.redirect(`${data.appOrigin}${data.returnTo}`);
		} catch (err) {
			app.log.error({ err }, "OAuth callback failed");
			await db.delete(oauthStates).where(eq(oauthStates.state, q.state));
			reply.redirect(`${data.appOrigin}/?error=oauth_failed`);
		}
	});

	async function requireUser(req: FastifyRequest) {
		const sid = (req as unknown as { cookies?: Record<string, string> })
			.cookies?.sid;
		if (!sid) return null;
		const session = await db.query.sessions.findFirst({
			where: eq(sessions.id, sid),
		});
		if (!session) return null;
		if (session.expiresAt.getTime() < nowMs()) {
			await db.delete(sessions).where(eq(sessions.id, sid));
			return null;
		}
		const user = await db.query.users.findFirst({
			where: eq(users.id, session.userId),
		});
		return user;
	}

	app.get("/api/profile", async (req, reply) => {
		const user = await requireUser(req);
		if (!user) {
			reply.code(401);
			return { error: { status: 401, message: "unauthorized" } };
		}

		const me = await spotifyJson<unknown>(db, {
			userId: user.id,
			path: "/me",
			requiredScopes: ["user-read-private"],
		});

		return { message: me };
	});

	app.get("/api/me", async (req, reply) => {
		const user = await requireUser(req);
		if (!user) {
			reply.code(401);
			return { error: { status: 401, message: "unauthorized" } };
		}

		return {
			user: {
				id: user.id,
				spotifyId: user.spotifyId,
				displayName: user.displayName,
				imageUrl: user.imageUrl,
				email: user.email,
				country: user.country,
				product: user.product,
			},
		};
	});

	app.get("/api/spotify/access-token", async (req, reply) => {
		const user = await requireUser(req);
		if (!user) {
			reply.code(401);
			return { error: { status: 401, message: "unauthorized" } };
		}

		const accessToken = await getValidAccessToken(db, {
			userId: user.id,
			requiredScopes: [
				"streaming",
				"user-read-playback-state",
				"user-modify-playback-state",
			],
		});

		reply.header("Cache-Control", "no-store");
		return { accessToken };
	});

	app.post("/api/logout", async (req, reply) => {
		const sid = (req as unknown as { cookies?: Record<string, string> })
			.cookies?.sid;
		if (sid) {
			await db.delete(sessions).where(eq(sessions.id, sid));
		}

		reply.clearCookie("sid", {
			path: "/",
			httpOnly: true,
			secure: env.NODE_ENV === "production",
			sameSite: "lax",
		});

		return { ok: true };
	});

	app.get("/api/me/playlists", async (req, reply) => {
		const user = await requireUser(req);
		if (!user) {
			reply.code(401);
			return { error: { status: 401, message: "unauthorized" } };
		}

		const data = await fetchUserPlaylists(db, {
			userId: user.id,
			limit: 50,
			offset: 0,
		});
		return {
			playlists: data.items.map((p) => ({
				id: p.id,
				name: p.name,
				imageUrl: p.images?.[0]?.url ?? null,
				tracksTotal: p.tracks?.total ?? 0,
				ownerName: p.owner?.display_name ?? null,
				public: p.public,
			})),
		};
	});

	app.get("/api/me/tournaments", async (req, reply) => {
		const user = await requireUser(req);
		if (!user) {
			reply.code(401);
			return { error: { status: 401, message: "unauthorized" } };
		}

		const list = await db.query.tournaments.findMany({
			where: or(
				eq(tournaments.hostUserId, user.id),
				eq(tournaments.challengerUserId, user.id),
			),
			orderBy: [desc(tournaments.updatedAt)],
			limit: 100,
		});

		const idSet = new Set<string>();
		for (const t of list) {
			if (t.hostUserId) idSet.add(t.hostUserId);
			if (t.challengerUserId) idSet.add(t.challengerUserId);
		}
		const userIds = Array.from(idSet);
		const userRows = userIds.length
			? await db.query.users.findMany({
					where: inArray(users.id, userIds),
				})
			: [];
		const byId = new Map(userRows.map((u) => [u.id, u]));

		type UserRow = typeof users.$inferSelect;
		const toPublic = (u: UserRow | undefined) =>
			u
				? {
						id: u.id,
						spotifyId: u.spotifyId,
						displayName: u.displayName,
						imageUrl: u.imageUrl,
					}
				: null;

		return {
			tournaments: list.map((t) => ({
				id: t.id,
				status: t.status,
				sourceType: t.sourceType,
				mesh: Boolean(t.meshMode),
				mood: t.mood,
				hostPlaylistId: t.hostPlaylistId,
				challengerPlaylistId: t.challengerPlaylistId,
				timeRange: t.timeRange,
				bracketSize: t.bracketSize,
				createdAt: t.createdAt.toISOString(),
				updatedAt: t.updatedAt.toISOString(),
				host: t.hostUserId ? toPublic(byId.get(t.hostUserId)) : null,
				challenger: t.challengerUserId
					? toPublic(byId.get(t.challengerUserId))
					: null,
			})),
		};
	});

	app.delete("/api/tournaments/:id", async (req, reply) => {
		const user = await requireUser(req);
		if (!user) {
			reply.code(401);
			return { error: { status: 401, message: "unauthorized" } };
		}

		const paramsSchema = z.object({ id: z.string().min(1) });
		const { id } = paramsSchema.parse(req.params);

		const t = await db.query.tournaments.findFirst({
			where: eq(tournaments.id, id),
		});
		if (!t) {
			reply.code(404);
			return { error: "not_found" };
		}
		if (t.hostUserId !== user.id && t.challengerUserId !== user.id) {
			reply.code(403);
			return { error: "forbidden" };
		}

		await db.delete(tournaments).where(eq(tournaments.id, id));
		return { ok: true };
	});

	app.patch("/api/tournaments/:id/settings", async (req, reply) => {
		const user = await requireUser(req);
		if (!user) {
			reply.code(401);
			return { error: { status: 401, message: "unauthorized" } };
		}

		const paramsSchema = z.object({ id: z.string().min(1) });
		const { id } = paramsSchema.parse(req.params);

		const t = await db.query.tournaments.findFirst({
			where: eq(tournaments.id, id),
		});
		if (!t) {
			reply.code(404);
			return { error: "not_found" };
		}
		if (t.hostUserId !== user.id && t.challengerUserId !== user.id) {
			reply.code(403);
			return { error: "forbidden" };
		}

		const bodySchema = z.object({
			hostPlaylistId: z.string().min(1).max(200).optional(),
			challengerPlaylistId: z.string().min(1).max(200).optional(),
			mood: z.string().min(1).max(40).optional(),
		});
		const body = bodySchema.parse(req.body);

		const updates: Partial<typeof tournaments.$inferInsert> = {
			updatedAt: new Date(nowMs()),
		};

		if (body.hostPlaylistId !== undefined) {
			if (t.hostUserId !== user.id) {
				reply.code(403);
				return { error: "only_host_can_set_host_playlist" };
			}
			updates.hostPlaylistId = extractPlaylistId(body.hostPlaylistId);
			if (!updates.hostPlaylistId) {
				reply.code(400);
				return { error: "invalid_playlist_id" };
			}
		}

		if (body.challengerPlaylistId !== undefined) {
			if (t.challengerUserId !== user.id) {
				reply.code(403);
				return { error: "only_challenger_can_set_challenger_playlist" };
			}
			updates.challengerPlaylistId = extractPlaylistId(
				body.challengerPlaylistId,
			);
			if (!updates.challengerPlaylistId) {
				reply.code(400);
				return { error: "invalid_playlist_id" };
			}
		}

		if (body.mood !== undefined) {
			if (t.hostUserId !== user.id) {
				reply.code(403);
				return { error: "only_host_can_set_mood" };
			}
			updates.mood = body.mood;
		}

		await db.update(tournaments).set(updates).where(eq(tournaments.id, id));

		// Keep status sane for playlist_vs: only "ready" when both playlists exist.
		if (t.sourceType === "playlist_vs") {
			const fresh = await db.query.tournaments.findFirst({
				where: eq(tournaments.id, id),
			});
			if (fresh) {
				const ready =
					Boolean(fresh.hostUserId) &&
					Boolean(fresh.challengerUserId) &&
					Boolean(fresh.hostPlaylistId) &&
					Boolean(fresh.challengerPlaylistId);
				await db
					.update(tournaments)
					.set({
						status: ready ? "ready" : "waiting_for_challenger",
						updatedAt: new Date(nowMs()),
					})
					.where(eq(tournaments.id, id));
			}
		}
		return { ok: true };
	});

	app.post("/api/top-tracks", async (req, reply) => {
		const user = await requireUser(req);
		if (!user) {
			reply.code(401);
			return { error: { status: 401, message: "unauthorized" } };
		}

		const bodySchema = z.object({
			time_range: z.enum(["short_term", "medium_term", "long_term"]),
			limit: z.number().int().min(1).max(50).default(20),
		});
		const body = bodySchema.parse(req.body);

		const data = await spotifyJson<unknown>(db, {
			userId: user.id,
			path: "/me/top/tracks",
			query: {
				time_range: body.time_range,
				limit: body.limit,
			},
			requiredScopes: ["user-top-read"],
		});

		return { data };
	});

	app.post("/api/top-artists", async (req, reply) => {
		const user = await requireUser(req);
		if (!user) {
			reply.code(401);
			return { error: { status: 401, message: "unauthorized" } };
		}

		const bodySchema = z.object({
			type: z.literal("artists"),
			n: z.number().int().min(1).max(50).default(20),
			time_range: z.enum(["short_term", "medium_term", "long_term"]),
		});
		const body = bodySchema.parse(req.body);

		const data = await spotifyJson<unknown>(db, {
			userId: user.id,
			path: "/me/top/artists",
			query: {
				time_range: body.time_range,
				limit: body.n,
			},
			requiredScopes: ["user-top-read"],
		});

		return { data };
	});

	app.post("/api/tournaments", async (req, reply) => {
		const user = await requireUser(req);
		if (!user) {
			reply.code(401);
			return { error: { status: 401, message: "unauthorized" } };
		}

		const bodySchema = z
			.object({
				sourceType: z
					.enum(["top_tracks", "playlist", "playlist_vs", "mood"])
					.default("top_tracks"),
				mesh: z.boolean().default(false),
				mood: z.string().min(1).max(40).optional(),
				hostPlaylistId: z.string().min(1).max(128).optional(),
				timeRange: z
					.enum(["short_term", "medium_term", "long_term"])
					.default("medium_term"),
				bracketSize: z
					.number()
					.int()
					.refine((n) => (n & (n - 1)) === 0 && n >= 8 && n <= 64, {
						message: "bracketSize must be power-of-two (8..64)",
					})
					.default(32),
			})
			.default({});

		const body = bodySchema.parse(req.body);
		const tournamentId = nanoid(10);
		const status =
			body.sourceType === "playlist" ? "ready" : "waiting_for_challenger";

		await db.insert(tournaments).values({
			id: tournamentId,
			hostUserId: user.id,
			sourceType: body.sourceType,
			meshMode: body.mesh ? 1 : 0,
			mood: body.mood ?? null,
			hostPlaylistId: body.hostPlaylistId ?? null,
			challengerPlaylistId: null,
			timeRange: body.timeRange,
			bracketSize: body.bracketSize,
			status,
			seed: crypto.randomInt(0, 1_000_000_000),
			createdAt: new Date(nowMs()),
			updatedAt: new Date(nowMs()),
		});

		return { tournamentId };
	});

	app.get("/api/tournaments/:id", async (req, reply) => {
		const paramsSchema = z.object({ id: z.string().min(1) });
		const { id } = paramsSchema.parse(req.params);

		const t = await db.query.tournaments.findFirst({
			where: eq(tournaments.id, id),
		});
		if (!t) {
			reply.code(404);
			return { error: "not_found" };
		}

		const host = t.hostUserId
			? await db.query.users.findFirst({
					where: eq(users.id, t.hostUserId),
				})
			: null;
		const challenger = t.challengerUserId
			? await db.query.users.findFirst({
					where: eq(users.id, t.challengerUserId),
				})
			: null;

		return {
			tournament: {
				id: t.id,
				status: t.status,
				sourceType: t.sourceType,
				mesh: Boolean(t.meshMode),
				mood: t.mood,
				hostPlaylistId: t.hostPlaylistId,
				challengerPlaylistId: t.challengerPlaylistId,
				timeRange: t.timeRange,
				bracketSize: t.bracketSize,
				seed: t.seed,
				host: host
					? {
							id: host.id,
							spotifyId: host.spotifyId,
							displayName: host.displayName,
							imageUrl: host.imageUrl,
						}
					: null,
				challenger: challenger
					? {
							id: challenger.id,
							spotifyId: challenger.spotifyId,
							displayName: challenger.displayName,
							imageUrl: challenger.imageUrl,
						}
					: null,
			},
		};
	});

	app.post("/api/tournaments/:id/start", async (req, reply) => {
		const paramsSchema = z.object({ id: z.string().min(1) });
		const { id } = paramsSchema.parse(req.params);

		const t = await db.query.tournaments.findFirst({
			where: eq(tournaments.id, id),
		});
		if (!t) {
			reply.code(404);
			return { error: "not_found" };
		}

		// Playlist mode is share-link playable; allow starting without being a participant.
		if (t.sourceType === "playlist") {
			if (!t.hostUserId) {
				reply.code(409);
				return { error: "tournament_not_ready" };
			}
			if (t.status === "in_progress" || t.status === "completed") {
				return { ok: true };
			}
			if (!t.hostPlaylistId) {
				reply.code(409);
				return { error: "playlist_not_selected" };
			}

			const playlistTracks = await fetchPlaylistTracks(db, {
				userId: t.hostUserId,
				playlistId: t.hostPlaylistId,
				maxTracks: 200,
			});

			const seen = new Set<string>();
			const unique: RankedTrack[] = [];
			for (const rt of playlistTracks) {
				if (seen.has(rt.trk.id)) continue;
				seen.add(rt.trk.id);
				unique.push(rt);
			}

			const requested = Math.min(t.bracketSize, unique.length);
			const bracketSize = 2 ** Math.floor(Math.log2(requested));
			if (bracketSize < 8) {
				reply.code(409);
				return { error: "not_enough_tracks" };
			}

			const selected = unique.slice(0, bracketSize);
			const normalize = (trk: RankedTrack["trk"]) => ({
				id: trk.id,
				name: trk.name,
				artists: trk.artists.map((a) => ({ id: a.id, name: a.name })),
				album: {
					id: trk.album.id,
					name: trk.album.name,
					imageUrl: trk.album.images?.[0]?.url ?? null,
				},
				previewUrl: trk.preview_url,
				spotifyUrl: trk.external_urls.spotify,
				uri: trk.uri,
				durationMs: trk.duration_ms,
			});

			await db
				.delete(tournamentTracks)
				.where(eq(tournamentTracks.tournamentId, t.id));
			await db
				.delete(tournamentBracketState)
				.where(eq(tournamentBracketState.tournamentId, t.id));

			await db.insert(tournamentTracks).values(
				selected.map((rt) => ({
					tournamentId: t.id,
					trackId: rt.trk.id,
					ownerUserId: t.hostUserId as string,
					rank: rt.rank,
					dataJson: JSON.stringify(normalize(rt.trk)),
					createdAt: new Date(nowMs()),
				})),
			);

			const bracketTracks = seededShuffle(
				selected.map((t) => t.trk.id),
				t.seed ^ 0x13579bdf,
			);

			await db.insert(tournamentBracketState).values({
				tournamentId: t.id,
				tracksJson: JSON.stringify(bracketTracks),
				winnersJson: JSON.stringify({}),
				updatedAt: new Date(nowMs()),
			});

			await db
				.update(tournaments)
				.set({
					status: "in_progress",
					bracketSize,
					updatedAt: new Date(nowMs()),
				})
				.where(eq(tournaments.id, t.id));

			return { ok: true };
		}

		const user = await requireUser(req);
		if (!user) {
			reply.code(401);
			return { error: { status: 401, message: "unauthorized" } };
		}
		if (!t.hostUserId) {
			reply.code(409);
			return { error: "tournament_not_ready" };
		}
		const isHost = user.id === t.hostUserId;
		const isChallenger = t.challengerUserId
			? user.id === t.challengerUserId
			: false;
		if (!isHost && !isChallenger) {
			reply.code(403);
			return { error: "forbidden" };
		}

		if (t.sourceType === "playlist_vs") {
			if (t.status === "in_progress" || t.status === "completed") {
				return { ok: true };
			}
			if (!t.hostUserId || !t.challengerUserId) {
				reply.code(409);
				return { error: "tournament_not_ready" };
			}
			if (!t.hostPlaylistId || !t.challengerPlaylistId) {
				reply.code(409);
				return { error: "playlist_not_selected" };
			}

			const [hostCandidates, challengerCandidates] = await Promise.all([
				fetchPlaylistTracks(db, {
					userId: t.hostUserId,
					playlistId: t.hostPlaylistId,
					maxTracks: 200,
				}),
				fetchPlaylistTracks(db, {
					userId: t.challengerUserId,
					playlistId: t.challengerPlaylistId,
					maxTracks: 200,
				}),
			]);

			const uniqueById = (arr: RankedTrack[]) => {
				const seen = new Set<string>();
				const out: RankedTrack[] = [];
				for (const rt of arr) {
					if (seen.has(rt.trk.id)) continue;
					seen.add(rt.trk.id);
					out.push(rt);
				}
				return out;
			};

			const hostUnique = uniqueById(hostCandidates);
			const challengerUnique = uniqueById(challengerCandidates);

			const pickUnique = (
				tracks: RankedTrack[],
				want: number,
				seen: Set<string>,
			) => {
				const out: RankedTrack[] = [];
				for (const rt of tracks) {
					if (out.length >= want) break;
					if (seen.has(rt.trk.id)) continue;
					seen.add(rt.trk.id);
					out.push(rt);
				}
				return out;
			};

			const requestedPerUser = Math.floor(t.bracketSize / 2);
			let perUser = requestedPerUser;
			let hostTracks: RankedTrack[] = [];
			let challengerTracks: RankedTrack[] = [];
			while (true) {
				const seen = new Set<string>();
				const hostPicked = pickUnique(hostUnique, perUser, seen);
				const challengerPicked = pickUnique(
					challengerUnique,
					perUser,
					seen,
				);
				const effective = Math.min(hostPicked.length, challengerPicked.length);
				const effectivePow2 = 2 ** Math.floor(Math.log2(effective));
				if (effectivePow2 < 4) {
					reply.code(409);
					return { error: "not_enough_tracks" };
				}
				if (effectivePow2 === perUser) {
					hostTracks = hostPicked.slice(0, perUser);
					challengerTracks = challengerPicked.slice(0, perUser);
					break;
				}
				perUser = effectivePow2;
			}

			const bracketSize = perUser * 2;
			if (bracketSize < 8) {
				reply.code(409);
				return { error: "not_enough_tracks" };
			}

			const normalize = (trk: RankedTrack["trk"]) => ({
				id: trk.id,
				name: trk.name,
				artists: trk.artists.map((a) => ({ id: a.id, name: a.name })),
				album: {
					id: trk.album.id,
					name: trk.album.name,
					imageUrl: trk.album.images?.[0]?.url ?? null,
				},
				previewUrl: trk.preview_url,
				spotifyUrl: trk.external_urls.spotify,
				uri: trk.uri,
				durationMs: trk.duration_ms,
			});

			await db
				.delete(tournamentTracks)
				.where(eq(tournamentTracks.tournamentId, t.id));
			await db
				.delete(tournamentBracketState)
				.where(eq(tournamentBracketState.tournamentId, t.id));

			await db.insert(tournamentTracks).values([
				...hostTracks.map((rt) => ({
					tournamentId: t.id,
					trackId: rt.trk.id,
					ownerUserId: t.hostUserId as string,
					rank: rt.rank,
					dataJson: JSON.stringify(normalize(rt.trk)),
					createdAt: new Date(nowMs()),
				})),
				...challengerTracks.map((rt) => ({
					tournamentId: t.id,
					trackId: rt.trk.id,
					ownerUserId: t.challengerUserId as string,
					rank: rt.rank,
					dataJson: JSON.stringify(normalize(rt.trk)),
					createdAt: new Date(nowMs()),
				})),
			]);

			const hostIds = seededShuffle(
				hostTracks.map((x) => x.trk.id),
				t.seed ^ 0x13579bdf,
			);
			const challengerIds = seededShuffle(
				challengerTracks.map((x) => x.trk.id),
				t.seed ^ 0x2468ace0,
			);

			const bracketTracks: string[] = t.meshMode
				? seededShuffle(
					[...hostIds.slice(0, perUser), ...challengerIds.slice(0, perUser)],
					t.seed ^ 0x9e3779b9,
				)
				: (() => {
					const out: string[] = [];
					for (let i = 0; i < perUser; i++) {
						out.push(hostIds[i], challengerIds[i]);
					}
					return out;
				})();

			await db.insert(tournamentBracketState).values({
				tournamentId: t.id,
				tracksJson: JSON.stringify(bracketTracks),
				winnersJson: JSON.stringify({}),
				updatedAt: new Date(nowMs()),
			});

			await db
				.update(tournaments)
				.set({
					status: "in_progress",
					bracketSize,
					updatedAt: new Date(nowMs()),
				})
				.where(eq(tournaments.id, t.id));

			return { ok: true };
		}

		if (!t.challengerUserId) {
			reply.code(409);
			return { error: "tournament_not_ready" };
		}

		const timeRange = t.timeRange as SpotifyTimeRange;

		const [hostCandidates, challengerCandidates] = await Promise.all([
			fetchUserTopTracks(db, {
				userId: t.hostUserId,
				timeRange,
				limit: 50,
			}),
			fetchUserTopTracks(db, {
				userId: t.challengerUserId,
				timeRange,
				limit: 50,
			}),
		]);

		const pickUnique = (
			tracks: RankedTrack[],
			want: number,
			seen: Set<string>,
		) => {
			const out: RankedTrack[] = [];
			for (const t of tracks) {
				if (out.length >= want) break;
				if (seen.has(t.trk.id)) continue;
				seen.add(t.trk.id);
				out.push(t);
			}
			return out;
		};

		const requestedPerUser = Math.floor(t.bracketSize / 2);
		let perUser = requestedPerUser;
		let hostTracks: RankedTrack[] = [];
		let challengerTracks: RankedTrack[] = [];

		while (true) {
			const seen = new Set<string>();
			const hostPicked = pickUnique(hostCandidates, perUser, seen);
			const challengerPicked = pickUnique(
				challengerCandidates,
				perUser,
				seen,
			);

			const effective = Math.min(
				hostPicked.length,
				challengerPicked.length,
			);
			const effectivePow2 = 2 ** Math.floor(Math.log2(effective));
			if (effectivePow2 < 4) {
				reply.code(409);
				return { error: "not_enough_tracks" };
			}

			if (effectivePow2 === perUser) {
				hostTracks = hostPicked.slice(0, perUser);
				challengerTracks = challengerPicked.slice(0, perUser);
				break;
			}

			perUser = effectivePow2;
		}

		const bracketSize = perUser * 2;

		const normalize = (trk: RankedTrack["trk"]) => ({
			id: trk.id,
			name: trk.name,
			artists: trk.artists.map((a) => ({ id: a.id, name: a.name })),
			album: {
				id: trk.album.id,
				name: trk.album.name,
				imageUrl: trk.album.images?.[0]?.url ?? null,
			},
			previewUrl: trk.preview_url,
			spotifyUrl: trk.external_urls.spotify,
			uri: trk.uri,
			durationMs: trk.duration_ms,
		});

		await db
			.delete(tournamentTracks)
			.where(eq(tournamentTracks.tournamentId, t.id));
		await db
			.delete(tournamentBracketState)
			.where(eq(tournamentBracketState.tournamentId, t.id));

		await db.insert(tournamentTracks).values([
			...hostTracks.map((rt) => ({
				tournamentId: t.id,
				trackId: rt.trk.id,
				ownerUserId: t.hostUserId as string,
				rank: rt.rank,
				dataJson: JSON.stringify(normalize(rt.trk)),
				createdAt: new Date(nowMs()),
			})),
			...challengerTracks.map((rt) => ({
				tournamentId: t.id,
				trackId: rt.trk.id,
				ownerUserId: t.challengerUserId as string,
				rank: rt.rank,
				dataJson: JSON.stringify(normalize(rt.trk)),
				createdAt: new Date(nowMs()),
			})),
		]);

		const hostIds = seededShuffle(
			hostTracks.map((t) => t.trk.id),
			t.seed ^ 0x13579bdf,
		);
		const challengerIds = seededShuffle(
			challengerTracks.map((t) => t.trk.id),
			t.seed ^ 0x2468ace0,
		);

		const bracketTracks: string[] = t.meshMode
			? seededShuffle(
					[
						...hostIds.slice(0, perUser),
						...challengerIds.slice(0, perUser),
					],
					t.seed ^ 0x9e3779b9,
				)
			: (() => {
					const out: string[] = [];
					for (let i = 0; i < perUser; i++) {
						out.push(hostIds[i], challengerIds[i]);
					}
					return out;
				})();

		await db.insert(tournamentBracketState).values({
			tournamentId: t.id,
			tracksJson: JSON.stringify(bracketTracks),
			winnersJson: JSON.stringify({}),
			updatedAt: new Date(nowMs()),
		});

		await db
			.update(tournaments)
			.set({
				status: "in_progress",
				bracketSize,
				updatedAt: new Date(nowMs()),
			})
			.where(eq(tournaments.id, t.id));

		return { ok: true };
	});

	app.get("/api/tournaments/:id/state", async (req, reply) => {
		const paramsSchema = z.object({ id: z.string().min(1) });
		const { id } = paramsSchema.parse(req.params);

		const t = await db.query.tournaments.findFirst({
			where: eq(tournaments.id, id),
		});
		if (!t) {
			reply.code(404);
			return { error: "not_found" };
		}

		const bracket = await db.query.tournamentBracketState.findFirst({
			where: eq(tournamentBracketState.tournamentId, id),
		});
		if (!bracket) {
			return {
				tournament: {
					id: t.id,
					status: t.status,
					timeRange: t.timeRange,
				},
				bracket: null,
			};
		}

		const tracks = JSON.parse(bracket.tracksJson) as string[];
		const winners = JSON.parse(bracket.winnersJson) as Record<
			string,
			string
		>;
		const size = tracks.length;
		const rounds = totalRounds(size);

		const trackRows = await db.query.tournamentTracks.findMany({
			where: eq(tournamentTracks.tournamentId, id),
		});
		const trackById = new Map(
			trackRows.map((r) => [
				r.trackId,
				{
					trackId: r.trackId,
					ownerUserId: r.ownerUserId,
					rank: r.rank,
					data: JSON.parse(r.dataJson) as StoredTrackData,
				},
			]),
		);

		const next = nextOpenMatch(size, tracks, winners);
		const winnerTrackId = winners[`r${rounds - 1}m0`] ?? null;

		const tracksById = Object.fromEntries(trackById.entries());

		return {
			tournament: {
				id: t.id,
				status: t.status,
				timeRange: t.timeRange,
				bracketSize: t.bracketSize,
				hostUserId: t.hostUserId,
				challengerUserId: t.challengerUserId,
			},
			bracket: {
				size,
				tracks,
				winners,
				tracksById,
				winnerTrackId,
				nextMatch: next
					? {
							round: next.round,
							match: next.match,
							a: trackById.get(next.a) ?? null,
							b: trackById.get(next.b) ?? null,
						}
					: null,
				completedAt: bracket.completedAt,
			},
		};
	});

	app.post("/api/tournaments/:id/vote", async (req, reply) => {
		const paramsSchema = z.object({ id: z.string().min(1) });
		const { id } = paramsSchema.parse(req.params);

		const bodySchema = z.object({
			round: z.number().int().min(0),
			match: z.number().int().min(0),
			winnerTrackId: z.string().min(1),
		});
		const body = bodySchema.parse(req.body);

		const bracket = await db.query.tournamentBracketState.findFirst({
			where: eq(tournamentBracketState.tournamentId, id),
		});
		if (!bracket) {
			reply.code(409);
			return { error: "bracket_not_started" };
		}
		const tracks = JSON.parse(bracket.tracksJson) as string[];
		const winners = JSON.parse(bracket.winnersJson) as Record<
			string,
			string
		>;
		const size = tracks.length;
		const rounds = totalRounds(size);
		if (body.round >= rounds) {
			reply.code(400);
			return { error: "invalid_round" };
		}
		const matches = size / 2 ** (body.round + 1);
		if (body.match >= matches) {
			reply.code(400);
			return { error: "invalid_match" };
		}

		const key = `r${body.round}m${body.match}`;
		if (winners[key]) {
			reply.code(409);
			return { error: "match_already_voted" };
		}

		const participants = resolveMatchParticipants(
			size,
			tracks,
			winners,
			body.round,
			body.match,
		);
		if (!participants) {
			reply.code(409);
			return { error: "match_not_ready" };
		}
		if (
			body.winnerTrackId !== participants.a &&
			body.winnerTrackId !== participants.b
		) {
			reply.code(400);
			return { error: "winner_not_in_match" };
		}

		winners[key] = body.winnerTrackId;
		const finalKey = `r${rounds - 1}m0`;
		const finalWinner = winners[finalKey] ?? null;

		await db
			.update(tournamentBracketState)
			.set({
				winnersJson: JSON.stringify(winners),
				completedAt: finalWinner ? new Date(nowMs()) : null,
				updatedAt: new Date(nowMs()),
			})
			.where(eq(tournamentBracketState.tournamentId, id));

		if (finalWinner) {
			await db
				.update(tournaments)
				.set({ status: "completed", updatedAt: new Date(nowMs()) })
				.where(eq(tournaments.id, id));
		}

		return { ok: true, finalWinner };
	});

	app.get("/api/tournaments/:id/results", async (req, reply) => {
		const paramsSchema = z.object({ id: z.string().min(1) });
		const { id } = paramsSchema.parse(req.params);

		const bracket = await db.query.tournamentBracketState.findFirst({
			where: eq(tournamentBracketState.tournamentId, id),
		});
		if (!bracket) {
			reply.code(409);
			return { error: "bracket_not_started" };
		}
		const tracks = JSON.parse(bracket.tracksJson) as string[];
		const winners = JSON.parse(bracket.winnersJson) as Record<
			string,
			string
		>;
		const size = tracks.length;
		const ranking = computeRanking(size, tracks, winners);
		if (!ranking) {
			reply.code(409);
			return { error: "tournament_not_completed" };
		}

		const trackRows = await db.query.tournamentTracks.findMany({
			where: eq(tournamentTracks.tournamentId, id),
		});
		const trackById = new Map(
			trackRows.map((r) => [
				r.trackId,
				{
					trackId: r.trackId,
					ownerUserId: r.ownerUserId,
					rank: r.rank,
					data: JSON.parse(r.dataJson) as StoredTrackData,
				},
			]),
		);

		return {
			ranking: ranking.map((trackId) => trackById.get(trackId) ?? null),
		};
	});

	app.post("/api/tournaments/:id/playlist", async (req, reply) => {
		const user = await requireUser(req);
		if (!user) {
			reply.code(401);
			return { error: { status: 401, message: "unauthorized" } };
		}

		const paramsSchema = z.object({ id: z.string().min(1) });
		const { id } = paramsSchema.parse(req.params);

		const bodySchema = z.object({
			public: z.boolean().default(false),
			name: z.string().min(1).max(100).optional(),
		});
		const body = bodySchema.parse(req.body);

		const bracket = await db.query.tournamentBracketState.findFirst({
			where: eq(tournamentBracketState.tournamentId, id),
		});
		if (!bracket) {
			reply.code(409);
			return { error: "bracket_not_started" };
		}
		const tracks = JSON.parse(bracket.tracksJson) as string[];
		const winners = JSON.parse(bracket.winnersJson) as Record<
			string,
			string
		>;
		const size = tracks.length;
		const ranking = computeRanking(size, tracks, winners);
		if (!ranking) {
			reply.code(409);
			return { error: "tournament_not_completed" };
		}

		const requiredScope = body.public
			? "playlist-modify-public"
			: "playlist-modify-private";
		const tournament = await db.query.tournaments.findFirst({
			where: eq(tournaments.id, id),
		});
		const host = tournament?.hostUserId
			? await db.query.users.findFirst({
					where: eq(users.id, tournament.hostUserId),
				})
			: null;
		const challenger = tournament?.challengerUserId
			? await db.query.users.findFirst({
					where: eq(users.id, tournament.challengerUserId),
				})
			: null;

		const playlistName =
			body.name ??
			`Re:Verb - ${host?.displayName ?? "Host"} vs ${challenger?.displayName ?? "Challenger"}`;

		type SpotifyCreatePlaylistResponse = {
			id: string;
			external_urls?: { spotify?: string };
		};

		const created = await spotifyJson<SpotifyCreatePlaylistResponse>(db, {
			userId: user.id,
			path: `/users/${user.spotifyId}/playlists`,
			method: "POST",
			body: {
				name: playlistName,
				public: body.public,
				description: "Bracket-ranked tracks generated by Re:Verb.",
			},
			requiredScopes: [requiredScope],
		});

		await spotifyJson<unknown>(db, {
			userId: user.id,
			path: `/playlists/${created.id}/tracks`,
			method: "POST",
			body: {
				uris: ranking.map((tid) => `spotify:track:${tid}`),
			},
			requiredScopes: [requiredScope],
		});

		return {
			playlist: {
				id: created.id,
				url: created.external_urls?.spotify ?? null,
			},
		};
	});

	await app.listen({ port: env.PORT, host: "0.0.0.0" });
	app.log.info(`API listening on :${env.PORT}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
