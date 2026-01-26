import { Hono } from "hono";
import { handle } from "hono/cloudflare-pages";
import { z } from "zod";
import { desc, eq, inArray, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import { parseEnv, type AppEnv } from "../_lib/env";
import { getDb, type Db } from "../_lib/db";
import {
	oauthStates,
	oauthTokens,
	tournamentBracketState,
	tournamentTracks,
	tournaments,
	users,
} from "../../db/schema";
import { createSession, clearSession, requireUser } from "../_lib/session";
import { encryptString } from "../_lib/crypto";
import {
	buildSpotifyAuthorizeUrl,
	exchangeSpotifyCode,
	getValidAccessToken,
	spotifyJson,
} from "../_lib/spotify";
import {
	extractPlaylistId,
	fetchPlaylistTracks,
	fetchUserPlaylists,
	fetchUserTopTracks,
	type RankedTrack,
	type SpotifyTimeRange,
} from "../_lib/tracks";
import {
	computeRanking,
	nextOpenMatch,
	resolveMatchParticipants,
	seededShuffle,
	totalRounds,
} from "../../lib/bracket";

const app = new Hono<{
	Bindings: AppEnv;
	Variables: {
		appEnv: AppEnv;
		db: Db;
	};
}>().basePath("/api");

let cachedEnv: AppEnv | null = null;

app.onError((err, c) => {
	// Normalize errors so the frontend can reliably detect missing scopes.
	let isProd = true;
	try {
		const env = c.get("appEnv") ?? parseEnv(c.env);
		isProd = env.NODE_ENV === "production";
	} catch {
		// ignore
	}

	if (err instanceof z.ZodError) {
		return c.json(
			{ error: { code: "bad_request", issues: err.issues } },
			400,
		);
	}

	const message = err instanceof Error ? err.message : "internal_error";
	if (message.startsWith("Missing required Spotify scopes")) {
		return c.json({ error: { code: "missing_scopes", message } }, 403);
	}

	return c.json(
		{
			error: {
				code: "internal_error",
				message: isProd ? "internal_error" : message,
			},
		},
		500,
	);
});

app.use("*", async (c, next) => {
	// Ensure the DB schema exists before handling requests.
	const env = cachedEnv ?? (cachedEnv = parseEnv(c.env));
	const db = await getDb(env.DB);
	c.set("appEnv", env);
	c.set("db", db);
	await next();
});

app.get("/health", (c) => c.json({ ok: true }));

function nowMs() {
	return Date.now();
}

function randomHex(bytes: number) {
	const buf = crypto.getRandomValues(new Uint8Array(bytes));
	let out = "";
	for (const b of buf) out += b.toString(16).padStart(2, "0");
	return out;
}

type LoginRole = "host" | "challenger" | "playlist" | "signin" | "playback";
type OauthStateData = {
	role: LoginRole;
	tournamentId?: string;
	returnTo: string;
	appOrigin: string;
	redirectUri: string;
};

app.post("/login", async (c) => {
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
			timeRange: z.enum(["short_term", "medium_term", "long_term"]).optional(),
			bracketSize: z
				.number()
				.int()
				.refine((n) => (n & (n - 1)) === 0 && n >= 8 && n <= 64, {
					message: "bracketSize must be power-of-two (8..64)",
				})
				.optional(),
		})
		.default({});

	const raw = await c.req.json().catch(() => ({}));
	const body = bodySchema.parse(raw);
	const role = (body.role ?? "host") satisfies LoginRole | "playback";
	const env = c.get("appEnv");
	const db = c.get("db");

	const reqOrigin = new URL(c.req.url).origin;
	const appOrigin = reqOrigin || env.APP_ORIGIN;
	const redirectUri = env.SPOTIFY_REDIRECT_URI;

	let tournamentId = body.tournamentId;
	if (role === "host") {
		tournamentId = nanoid(10);
		const seed = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000_000;
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
			seed,
			createdAt: new Date(nowMs()),
			updatedAt: new Date(nowMs()),
		});
	}

	if (role === "challenger" || role === "playlist") {
		if (!tournamentId) return c.json({ error: "tournamentId is required" }, 400);
		const tournament = await db.query.tournaments.findFirst({
			where: eq(tournaments.id, tournamentId),
		});
		if (!tournament) return c.json({ error: "tournament not found" }, 404);
		if (role === "challenger" && tournament.challengerUserId) {
			return c.json({ error: "tournament already has a challenger" }, 409);
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
	const playlistScopes = ["playlist-modify-private", "playlist-modify-public"];
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

	const state = randomHex(16);
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
		env,
		state,
		scopes,
		redirectUri,
	});

	return c.json({ message: authUrl, err: null });
});

app.get("/auth/callback", async (c) => {
	const querySchema = z.object({
		code: z.string().optional(),
		state: z.string().optional(),
		error: z.string().optional(),
	});
	const q = querySchema.parse(c.req.query());
	const env = c.get("appEnv");
	const db = c.get("db");

	if (q.error) {
		return c.redirect(
			`${env.APP_ORIGIN}/?error=${encodeURIComponent(q.error)}`,
		);
	}
	if (!q.code || !q.state) {
		return c.redirect(`${env.APP_ORIGIN}/?error=missing_code_or_state`);
	}

	const stateRow = await db.query.oauthStates.findFirst({
		where: eq(oauthStates.state, q.state),
	});
	if (!stateRow) return c.redirect(`${env.APP_ORIGIN}/?error=invalid_state`);
	if (stateRow.expiresAt.getTime() < nowMs()) {
		await db.delete(oauthStates).where(eq(oauthStates.state, q.state));
		return c.redirect(`${env.APP_ORIGIN}/?error=state_expired`);
	}

	const rawData = JSON.parse(stateRow.dataJson) as Partial<OauthStateData>;
	const data: OauthStateData = {
		role: rawData.role as LoginRole,
		tournamentId: rawData.tournamentId,
		returnTo: rawData.returnTo ?? "/",
		appOrigin: rawData.appOrigin ?? env.APP_ORIGIN,
		redirectUri: rawData.redirectUri ?? env.SPOTIFY_REDIRECT_URI,
	};

	try {
		const token = await exchangeSpotifyCode({
			env,
			code: q.code,
			redirectUri: data.redirectUri,
		});

		const meResp = await fetch("https://api.spotify.com/v1/me", {
			headers: { Authorization: `Bearer ${token.access_token}` },
		});
		if (!meResp.ok) {
			const text = await meResp.text();
			throw new Error(`Spotify /me failed (${meResp.status}): ${text}`);
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
					displayName: me.display_name ?? existingUser.displayName,
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
			? await encryptString({ plain: token.refresh_token, key: env.TOKEN_ENC_KEY })
			: existingTokens?.refreshTokenEnc;
		if (!refreshTokenEnc) {
			throw new Error(
				"Spotify did not return a refresh_token and none exists",
			);
		}

		const accessTokenEnc = await encryptString({
			plain: token.access_token,
			key: env.TOKEN_ENC_KEY,
		});

		if (!existingTokens) {
			await db.insert(oauthTokens).values({
				userId,
				accessTokenEnc,
				refreshTokenEnc,
				scope: token.scope,
				expiresAt,
				updatedAt: new Date(nowMs()),
			});
		} else {
			await db
				.update(oauthTokens)
				.set({
					accessTokenEnc,
					refreshTokenEnc,
					scope: token.scope,
					expiresAt,
					updatedAt: new Date(nowMs()),
				})
				.where(eq(oauthTokens.userId, userId));
		}

		await createSession({ c, userId });

		if (data.role === "host" && data.tournamentId) {
			const tournament = await db.query.tournaments.findFirst({
				where: eq(tournaments.id, data.tournamentId),
			});
			const nextStatus =
				tournament?.sourceType === "playlist" ? "ready" : "waiting_for_challenger";
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
			} else if (current.status === "in_progress" || current.status === "completed") {
				await db
					.update(tournaments)
					.set({ challengerUserId: userId, updatedAt: new Date(nowMs()) })
					.where(eq(tournaments.id, data.tournamentId));
			} else {
				const nextStatus =
					current.sourceType === "playlist_vs" && !current.challengerPlaylistId
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
		return c.redirect(`${data.appOrigin}${data.returnTo}`);
	} catch {
		await db.delete(oauthStates).where(eq(oauthStates.state, q.state));
		return c.redirect(`${data.appOrigin}/?error=oauth_failed`);
	}
});

app.get("/me", async (c) => {
	const user = await requireUser(c);
	if (!user) {
		return c.json({ error: { status: 401, message: "unauthorized" } }, 401);
	}
	return c.json({
		user: {
			id: user.id,
			spotifyId: user.spotifyId,
			displayName: user.displayName,
			imageUrl: user.imageUrl ?? null,
			email: user.email ?? null,
			country: user.country ?? null,
			product: user.product ?? null,
		},
	});
});

app.post("/logout", async (c) => {
	await clearSession(c);
	return c.json({ ok: true });
});

app.get("/spotify/access-token", async (c) => {
	const user = await requireUser(c);
	if (!user) {
		return c.json({ error: { status: 401, message: "unauthorized" } }, 401);
	}
	const env = c.get("appEnv");
	const db = c.get("db");
	const accessToken = await getValidAccessToken({
		db,
		env,
		userId: user.id,
		requiredScopes: [
			"streaming",
			"user-read-playback-state",
			"user-modify-playback-state",
		],
	});
	c.header("Cache-Control", "no-store");
	return c.json({ accessToken });
});

app.get("/me/playlists", async (c) => {
	const user = await requireUser(c);
	if (!user) {
		return c.json({ error: { status: 401, message: "unauthorized" } }, 401);
	}
	const env = c.get("appEnv");
	const db = c.get("db");
	const data = await fetchUserPlaylists(db, env, {
		userId: user.id,
		limit: 50,
		offset: 0,
	});
	return c.json({
		playlists: data.items.map((p) => ({
			id: p.id,
			name: p.name,
			imageUrl: p.images?.[0]?.url ?? null,
			tracksTotal: p.tracks?.total ?? 0,
			ownerName: p.owner?.display_name ?? null,
			public: p.public,
		})),
	});
});

app.get("/me/tournaments", async (c) => {
	const user = await requireUser(c);
	if (!user) {
		return c.json({ error: { status: 401, message: "unauthorized" } }, 401);
	}

	const db = c.get("db");
	const list = await db.query.tournaments.findMany({
		where: or(eq(tournaments.hostUserId, user.id), eq(tournaments.challengerUserId, user.id)),
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
		? await db.query.users.findMany({ where: inArray(users.id, userIds) })
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

	return c.json({
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
			challenger: t.challengerUserId ? toPublic(byId.get(t.challengerUserId)) : null,
		})),
	});
});

app.post("/tournaments", async (c) => {
	const user = await requireUser(c);
	if (!user) {
		return c.json({ error: { status: 401, message: "unauthorized" } }, 401);
	}

	const bodySchema = z
		.object({
			sourceType: z
				.enum(["top_tracks", "playlist", "playlist_vs", "mood"])
				.default("top_tracks"),
			mesh: z.boolean().default(false),
			mood: z.string().min(1).max(40).optional(),
			hostPlaylistId: z.string().min(1).max(128).optional(),
			timeRange: z.enum(["short_term", "medium_term", "long_term"]).default("medium_term"),
			bracketSize: z
				.number()
				.int()
				.refine((n) => (n & (n - 1)) === 0 && n >= 8 && n <= 64, {
					message: "bracketSize must be power-of-two (8..64)",
				})
				.default(32),
		})
		.default({});
	const raw = await c.req.json().catch(() => ({}));
	const body = bodySchema.parse(raw);

	const tournamentId = nanoid(10);
	const status = body.sourceType === "playlist" ? "ready" : "waiting_for_challenger";
	const seed = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000_000;
	const db = c.get("db");
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
		seed,
		createdAt: new Date(nowMs()),
		updatedAt: new Date(nowMs()),
	});

	return c.json({ tournamentId });
});

app.get("/tournaments/:id", async (c) => {
	const id = z.object({ id: z.string().min(1) }).parse(c.req.param()).id;
	const db = c.get("db");
	const t = await db.query.tournaments.findFirst({ where: eq(tournaments.id, id) });
	if (!t) return c.json({ error: "not_found" }, 404);

	const host = t.hostUserId
		? await db.query.users.findFirst({ where: eq(users.id, t.hostUserId) })
		: null;
	const challenger = t.challengerUserId
		? await db.query.users.findFirst({ where: eq(users.id, t.challengerUserId) })
		: null;

	return c.json({
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
	});
});

app.delete("/tournaments/:id", async (c) => {
	const user = await requireUser(c);
	if (!user) {
		return c.json({ error: { status: 401, message: "unauthorized" } }, 401);
	}
	const id = z.object({ id: z.string().min(1) }).parse(c.req.param()).id;
	const db = c.get("db");
	const t = await db.query.tournaments.findFirst({ where: eq(tournaments.id, id) });
	if (!t) return c.json({ error: "not_found" }, 404);
	if (t.hostUserId !== user.id && t.challengerUserId !== user.id) {
		return c.json({ error: "forbidden" }, 403);
	}
	await db.delete(tournaments).where(eq(tournaments.id, id));
	return c.json({ ok: true });
});

app.patch("/tournaments/:id/settings", async (c) => {
	const user = await requireUser(c);
	if (!user) {
		return c.json({ error: { status: 401, message: "unauthorized" } }, 401);
	}
	const id = z.object({ id: z.string().min(1) }).parse(c.req.param()).id;
	const db = c.get("db");
	const t = await db.query.tournaments.findFirst({ where: eq(tournaments.id, id) });
	if (!t) return c.json({ error: "not_found" }, 404);
	if (t.hostUserId !== user.id && t.challengerUserId !== user.id) {
		return c.json({ error: "forbidden" }, 403);
	}

	const bodySchema = z.object({
		hostPlaylistId: z.string().min(1).max(200).optional(),
		challengerPlaylistId: z.string().min(1).max(200).optional(),
		mood: z.string().min(1).max(40).optional(),
	});
	const raw = await c.req.json().catch(() => ({}));
	const body = bodySchema.parse(raw);

	const updates: Partial<typeof tournaments.$inferInsert> = { updatedAt: new Date(nowMs()) };
	if (body.hostPlaylistId !== undefined) {
		if (t.hostUserId !== user.id) return c.json({ error: "only_host_can_set_host_playlist" }, 403);
		updates.hostPlaylistId = extractPlaylistId(body.hostPlaylistId);
		if (!updates.hostPlaylistId) return c.json({ error: "invalid_playlist_id" }, 400);
	}
	if (body.challengerPlaylistId !== undefined) {
		if (t.challengerUserId !== user.id)
			return c.json({ error: "only_challenger_can_set_challenger_playlist" }, 403);
		updates.challengerPlaylistId = extractPlaylistId(body.challengerPlaylistId);
		if (!updates.challengerPlaylistId) return c.json({ error: "invalid_playlist_id" }, 400);
	}
	if (body.mood !== undefined) {
		if (t.hostUserId !== user.id) return c.json({ error: "only_host_can_set_mood" }, 403);
		updates.mood = body.mood;
	}

	await db.update(tournaments).set(updates).where(eq(tournaments.id, id));

	if (t.sourceType === "playlist_vs" && t.status !== "in_progress" && t.status !== "completed") {
		const fresh = await db.query.tournaments.findFirst({ where: eq(tournaments.id, id) });
		if (fresh) {
			const ready =
				Boolean(fresh.hostUserId) &&
				Boolean(fresh.challengerUserId) &&
				Boolean(fresh.hostPlaylistId) &&
				Boolean(fresh.challengerPlaylistId);
			await db
				.update(tournaments)
				.set({ status: ready ? "ready" : "waiting_for_challenger", updatedAt: new Date(nowMs()) })
				.where(eq(tournaments.id, id));
		}
	}

	return c.json({ ok: true });
});

app.post("/tournaments/:id/start", async (c) => {
	const id = z.object({ id: z.string().min(1) }).parse(c.req.param()).id;
	const db = c.get("db");
	const env = c.get("appEnv");

	const t = await db.query.tournaments.findFirst({ where: eq(tournaments.id, id) });
	if (!t) return c.json({ error: "not_found" }, 404);

	if (t.sourceType === "playlist") {
		if (!t.hostUserId) return c.json({ error: "tournament_not_ready" }, 409);
		if (t.status === "in_progress" || t.status === "completed") return c.json({ ok: true });
		if (!t.hostPlaylistId) return c.json({ error: "playlist_not_selected" }, 409);

		const playlistTracks = await fetchPlaylistTracks(db, env, {
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
		if (bracketSize < 8) return c.json({ error: "not_enough_tracks" }, 409);

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

		await db.delete(tournamentTracks).where(eq(tournamentTracks.tournamentId, t.id));
		await db.delete(tournamentBracketState).where(eq(tournamentBracketState.tournamentId, t.id));

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
			selected.map((x) => x.trk.id),
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
			.set({ status: "in_progress", bracketSize, updatedAt: new Date(nowMs()) })
			.where(eq(tournaments.id, t.id));

		return c.json({ ok: true });
	}

	const user = await requireUser(c);
	if (!user) {
		return c.json({ error: { status: 401, message: "unauthorized" } }, 401);
	}
	if (!t.hostUserId) return c.json({ error: "tournament_not_ready" }, 409);
	const isHost = user.id === t.hostUserId;
	const isChallenger = t.challengerUserId ? user.id === t.challengerUserId : false;
	if (!isHost && !isChallenger) return c.json({ error: "forbidden" }, 403);

	if (t.sourceType === "playlist_vs") {
		if (t.status === "in_progress" || t.status === "completed") return c.json({ ok: true });
		if (!t.hostUserId || !t.challengerUserId) return c.json({ error: "tournament_not_ready" }, 409);
		if (!t.hostPlaylistId || !t.challengerPlaylistId) return c.json({ error: "playlist_not_selected" }, 409);

		const [hostCandidates, challengerCandidates] = await Promise.all([
			fetchPlaylistTracks(db, env, {
				userId: t.hostUserId,
				playlistId: t.hostPlaylistId,
				maxTracks: 200,
			}),
			fetchPlaylistTracks(db, env, {
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

		const pickUnique = (tracks: RankedTrack[], want: number, seen: Set<string>) => {
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
			const challengerPicked = pickUnique(challengerUnique, perUser, seen);
			const effective = Math.min(hostPicked.length, challengerPicked.length);
			const effectivePow2 = 2 ** Math.floor(Math.log2(effective));
			if (effectivePow2 < 4) return c.json({ error: "not_enough_tracks" }, 409);
			if (effectivePow2 === perUser) {
				hostTracks = hostPicked.slice(0, perUser);
				challengerTracks = challengerPicked.slice(0, perUser);
				break;
			}
			perUser = effectivePow2;
		}

		const bracketSize = perUser * 2;
		if (bracketSize < 8) return c.json({ error: "not_enough_tracks" }, 409);

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

		await db.delete(tournamentTracks).where(eq(tournamentTracks.tournamentId, t.id));
		await db.delete(tournamentBracketState).where(eq(tournamentBracketState.tournamentId, t.id));

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

		const hostIds = seededShuffle(hostTracks.map((x) => x.trk.id), t.seed ^ 0x13579bdf);
		const challengerIds = seededShuffle(challengerTracks.map((x) => x.trk.id), t.seed ^ 0x2468ace0);

		const bracketTracks: string[] = t.meshMode
			? seededShuffle(
				[...hostIds.slice(0, perUser), ...challengerIds.slice(0, perUser)],
				t.seed ^ 0x9e3779b9,
			)
			: (() => {
				const out: string[] = [];
				for (let i = 0; i < perUser; i++) out.push(hostIds[i]!, challengerIds[i]!);
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
			.set({ status: "in_progress", bracketSize, updatedAt: new Date(nowMs()) })
			.where(eq(tournaments.id, t.id));

		return c.json({ ok: true });
	}

	if (!t.challengerUserId) return c.json({ error: "tournament_not_ready" }, 409);
	const timeRange = t.timeRange as SpotifyTimeRange;
	const [hostCandidates, challengerCandidates] = await Promise.all([
		fetchUserTopTracks(db, env, { userId: t.hostUserId, timeRange, limit: 50 }),
		fetchUserTopTracks(db, env, { userId: t.challengerUserId, timeRange, limit: 50 }),
	]);

	const pickUnique = (tracks: RankedTrack[], want: number, seen: Set<string>) => {
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
		const hostPicked = pickUnique(hostCandidates, perUser, seen);
		const challengerPicked = pickUnique(challengerCandidates, perUser, seen);
		const effective = Math.min(hostPicked.length, challengerPicked.length);
		const effectivePow2 = 2 ** Math.floor(Math.log2(effective));
		if (effectivePow2 < 4) return c.json({ error: "not_enough_tracks" }, 409);
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

	await db.delete(tournamentTracks).where(eq(tournamentTracks.tournamentId, t.id));
	await db.delete(tournamentBracketState).where(eq(tournamentBracketState.tournamentId, t.id));

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

	const hostIds = seededShuffle(hostTracks.map((x) => x.trk.id), t.seed ^ 0x13579bdf);
	const challengerIds = seededShuffle(challengerTracks.map((x) => x.trk.id), t.seed ^ 0x2468ace0);
	const bracketTracks: string[] = t.meshMode
		? seededShuffle(
			[...hostIds.slice(0, perUser), ...challengerIds.slice(0, perUser)],
			t.seed ^ 0x9e3779b9,
		)
		: (() => {
			const out: string[] = [];
			for (let i = 0; i < perUser; i++) out.push(hostIds[i]!, challengerIds[i]!);
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
		.set({ status: "in_progress", bracketSize, updatedAt: new Date(nowMs()) })
		.where(eq(tournaments.id, t.id));

	return c.json({ ok: true });
});

app.get("/tournaments/:id/state", async (c) => {
	const id = z.object({ id: z.string().min(1) }).parse(c.req.param()).id;
	const db = c.get("db");
	const t = await db.query.tournaments.findFirst({ where: eq(tournaments.id, id) });
	if (!t) return c.json({ error: "not_found" }, 404);

	const bracket = await db.query.tournamentBracketState.findFirst({
		where: eq(tournamentBracketState.tournamentId, id),
	});
	if (!bracket) {
		return c.json({
			tournament: { id: t.id, status: t.status, timeRange: t.timeRange },
			bracket: null,
		});
	}

	const tracks = JSON.parse(bracket.tracksJson) as string[];
	const winners = JSON.parse(bracket.winnersJson) as Record<string, string>;
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
				data: JSON.parse(r.dataJson),
			},
		]),
	);

	const next = nextOpenMatch(size, tracks, winners);
	const winnerTrackId = winners[`r${rounds - 1}m0`] ?? null;
	const tracksById = Object.fromEntries(trackById.entries());

	return c.json({
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
	});
});

app.post("/tournaments/:id/vote", async (c) => {
	const id = z.object({ id: z.string().min(1) }).parse(c.req.param()).id;
	const bodySchema = z.object({
		round: z.number().int().min(0),
		match: z.number().int().min(0),
		winnerTrackId: z.string().min(1),
	});
	const raw = await c.req.json().catch(() => ({}));
	const body = bodySchema.parse(raw);

	const db = c.get("db");
	const bracket = await db.query.tournamentBracketState.findFirst({
		where: eq(tournamentBracketState.tournamentId, id),
	});
	if (!bracket) return c.json({ error: "bracket_not_started" }, 409);

	const tracks = JSON.parse(bracket.tracksJson) as string[];
	const winners = JSON.parse(bracket.winnersJson) as Record<string, string>;
	const size = tracks.length;
	const rounds = totalRounds(size);
	if (body.round >= rounds) return c.json({ error: "invalid_round" }, 400);
	const matches = size / 2 ** (body.round + 1);
	if (body.match >= matches) return c.json({ error: "invalid_match" }, 400);

	const key = `r${body.round}m${body.match}`;
	if (winners[key]) return c.json({ error: "match_already_voted" }, 409);
	const participants = resolveMatchParticipants(size, tracks, winners, body.round, body.match);
	if (!participants) return c.json({ error: "match_not_ready" }, 409);
	if (body.winnerTrackId !== participants.a && body.winnerTrackId !== participants.b) {
		return c.json({ error: "winner_not_in_match" }, 400);
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

	return c.json({ ok: true, finalWinner });
});

app.get("/tournaments/:id/results", async (c) => {
	const id = z.object({ id: z.string().min(1) }).parse(c.req.param()).id;
	const db = c.get("db");
	const bracket = await db.query.tournamentBracketState.findFirst({
		where: eq(tournamentBracketState.tournamentId, id),
	});
	if (!bracket) return c.json({ error: "bracket_not_started" }, 409);

	const tracks = JSON.parse(bracket.tracksJson) as string[];
	const winners = JSON.parse(bracket.winnersJson) as Record<string, string>;
	const size = tracks.length;
	const ranking = computeRanking(size, tracks, winners);
	if (!ranking) return c.json({ error: "tournament_not_completed" }, 409);

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
				data: JSON.parse(r.dataJson),
			},
		]),
	);

	return c.json({ ranking: ranking.map((trackId) => trackById.get(trackId) ?? null) });
});

app.post("/tournaments/:id/playlist", async (c) => {
	const user = await requireUser(c);
	if (!user) {
		return c.json({ error: { status: 401, message: "unauthorized" } }, 401);
	}
	const id = z.object({ id: z.string().min(1) }).parse(c.req.param()).id;
	const bodySchema = z.object({
		public: z.boolean().default(false),
		name: z.string().min(1).max(100).optional(),
	});
	const raw = await c.req.json().catch(() => ({}));
	const body = bodySchema.parse(raw);

	const db = c.get("db");
	const env = c.get("appEnv");
	const bracket = await db.query.tournamentBracketState.findFirst({
		where: eq(tournamentBracketState.tournamentId, id),
	});
	if (!bracket) return c.json({ error: "bracket_not_started" }, 409);

	const tracks = JSON.parse(bracket.tracksJson) as string[];
	const winners = JSON.parse(bracket.winnersJson) as Record<string, string>;
	const size = tracks.length;
	const ranking = computeRanking(size, tracks, winners);
	if (!ranking) return c.json({ error: "tournament_not_completed" }, 409);

	const requiredScope = body.public ? "playlist-modify-public" : "playlist-modify-private";
	const tournament = await db.query.tournaments.findFirst({ where: eq(tournaments.id, id) });
	const host = tournament?.hostUserId
		? await db.query.users.findFirst({ where: eq(users.id, tournament.hostUserId) })
		: null;
	const challenger = tournament?.challengerUserId
		? await db.query.users.findFirst({ where: eq(users.id, tournament.challengerUserId) })
		: null;

	const playlistName =
		body.name ??
		`Re:Verb - ${host?.displayName ?? "Host"} vs ${challenger?.displayName ?? "Challenger"}`;

	type SpotifyCreatePlaylistResponse = { id: string; external_urls?: { spotify?: string } };
	const created = await spotifyJson<SpotifyCreatePlaylistResponse>({
		db,
		env,
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

	await spotifyJson<unknown>({
		db,
		env,
		userId: user.id,
		path: `/playlists/${created.id}/tracks`,
		method: "POST",
		body: {
			uris: ranking.map((tid) => `spotify:track:${tid}`),
		},
		requiredScopes: [requiredScope],
	});

	return c.json({
		playlist: {
			id: created.id,
			url: created.external_urls?.spotify ?? null,
		},
	});
});

export const onRequest = handle(app);
