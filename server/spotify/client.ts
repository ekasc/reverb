import { eq } from "drizzle-orm";
import { decryptString, encryptString } from "../lib/crypto";
import { oauthTokens } from "../db/schema";
import type { DrizzleDb } from "../types";
import { refreshSpotifyToken } from "./auth";

function hasScopes(granted: string, required: string[]) {
	const grantedSet = new Set(granted.split(/\s+/).filter(Boolean));
	return required.every((s) => grantedSet.has(s));
}

export async function getValidAccessToken(
	db: DrizzleDb,
	params: {
		userId: string;
		requiredScopes?: string[];
	},
) {
	const token = await db.query.oauthTokens.findFirst({
		where: eq(oauthTokens.userId, params.userId),
	});
	if (!token) throw new Error("No Spotify token found for user");

	const requiredScopes = params.requiredScopes ?? [];
	if (!hasScopes(token.scope, requiredScopes)) {
		throw new Error(
			`Missing required Spotify scopes: ${requiredScopes.join(", ")}`,
		);
	}

	const now = Date.now();
	const expiresAtMs = token.expiresAt.getTime();
	if (expiresAtMs - now > 30_000) {
		return decryptString(token.accessTokenEnc);
	}

	const refreshed = await refreshSpotifyToken(
		decryptString(token.refreshTokenEnc),
	);
	const newExpiresAt = new Date(now + refreshed.expires_in * 1000);

	await db
		.update(oauthTokens)
		.set({
			accessTokenEnc: encryptString(refreshed.access_token),
			expiresAt: newExpiresAt,
			scope: refreshed.scope ?? token.scope,
			updatedAt: new Date(now),
		})
		.where(eq(oauthTokens.userId, params.userId));

	return refreshed.access_token;
}

export async function spotifyJson<T>(
	db: DrizzleDb,
	params: {
		userId: string;
		path: string;
		method?: string;
		query?: Record<string, string | number | boolean | undefined>;
		body?: unknown;
		requiredScopes?: string[];
	},
): Promise<T> {
	const url = new URL(`https://api.spotify.com/v1${params.path}`);
	for (const [k, v] of Object.entries(params.query ?? {})) {
		if (v === undefined) continue;
		url.searchParams.set(k, String(v));
	}

	const accessToken = await getValidAccessToken(db, {
		userId: params.userId,
		requiredScopes: params.requiredScopes,
	});

	const doFetch = async (token: string) =>
		fetch(url, {
			method: params.method ?? "GET",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: params.body ? JSON.stringify(params.body) : undefined,
		});

	let resp = await doFetch(accessToken);
	if (resp.status === 401) {
		// Token might have expired; refresh and retry once.
		const retryToken = await getValidAccessToken(db, {
			userId: params.userId,
			requiredScopes: params.requiredScopes,
		});
		resp = await doFetch(retryToken);
	}

	if (!resp.ok) {
		const text = await resp.text();
		let insufficientScope = false;
		try {
			const parsed = JSON.parse(text) as {
				error?: { message?: unknown };
			};
			const msg = parsed?.error?.message;
			insufficientScope =
				resp.status === 403 &&
				typeof msg === "string" &&
				msg.toLowerCase().includes("insufficient client scope");
		} catch {
			// ignore JSON parse errors
		}
		if (insufficientScope) {
			throw new Error("Missing required Spotify scopes: spotify");
		}
		throw new Error(`Spotify API error (${resp.status}): ${text}`);
	}

	return (await resp.json()) as T;
}
