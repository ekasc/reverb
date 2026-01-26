import { eq } from "drizzle-orm";
import { oauthTokens } from "../../db/schema";
import type { Db } from "./db";
import type { AppEnv } from "./env";
import { decryptString, encryptString } from "./crypto";

export type SpotifyTokenResponse = {
	access_token: string;
	token_type: "Bearer";
	scope: string;
	expires_in: number;
	refresh_token?: string;
};

function hasScopes(granted: string, required: string[]) {
	const grantedSet = new Set(granted.split(/\s+/).filter(Boolean));
	return required.every((s) => grantedSet.has(s));
}

function basicAuthHeader(env: AppEnv) {
	// Spotify client id/secret are ASCII; btoa is fine here.
	return `Basic ${btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)}`;
}

export function buildSpotifyAuthorizeUrl(params: {
	env: AppEnv;
	state: string;
	scopes: string[];
	redirectUri: string;
	showDialog?: boolean;
}) {
	const url = new URL("https://accounts.spotify.com/authorize");
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", params.env.SPOTIFY_CLIENT_ID);
	url.searchParams.set("redirect_uri", params.redirectUri);
	url.searchParams.set("state", params.state);
	url.searchParams.set("scope", params.scopes.join(" "));
	if (params.showDialog) url.searchParams.set("show_dialog", "true");
	return url.toString();
}

export async function exchangeSpotifyCode(params: {
	env: AppEnv;
	code: string;
	redirectUri: string;
}) {
	const body = new URLSearchParams();
	body.set("grant_type", "authorization_code");
	body.set("code", params.code);
	body.set("redirect_uri", params.redirectUri);

	const resp = await fetch("https://accounts.spotify.com/api/token", {
		method: "POST",
		headers: {
			Authorization: basicAuthHeader(params.env),
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body,
	});

	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`Spotify token exchange failed (${resp.status}): ${text}`);
	}

	return (await resp.json()) as SpotifyTokenResponse;
}

export async function refreshSpotifyToken(params: {
	env: AppEnv;
	refreshToken: string;
}) {
	const body = new URLSearchParams();
	body.set("grant_type", "refresh_token");
	body.set("refresh_token", params.refreshToken);

	const resp = await fetch("https://accounts.spotify.com/api/token", {
		method: "POST",
		headers: {
			Authorization: basicAuthHeader(params.env),
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body,
	});

	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`Spotify token refresh failed (${resp.status}): ${text}`);
	}

	return (await resp.json()) as SpotifyTokenResponse;
}

export async function getValidAccessToken(params: {
	db: Db;
	env: AppEnv;
	userId: string;
	requiredScopes?: string[];
}) {
	const token = await params.db.query.oauthTokens.findFirst({
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
		return decryptString({ enc: token.accessTokenEnc, key: params.env.TOKEN_ENC_KEY });
	}

	const refreshed = await refreshSpotifyToken({
		env: params.env,
		refreshToken: await decryptString({
			enc: token.refreshTokenEnc,
			key: params.env.TOKEN_ENC_KEY,
		}),
	});
	const newExpiresAt = new Date(now + refreshed.expires_in * 1000);

	await params.db
		.update(oauthTokens)
		.set({
			accessTokenEnc: await encryptString({
				plain: refreshed.access_token,
				key: params.env.TOKEN_ENC_KEY,
			}),
			expiresAt: newExpiresAt,
			scope: refreshed.scope ?? token.scope,
			updatedAt: new Date(now),
		})
		.where(eq(oauthTokens.userId, params.userId));

	return refreshed.access_token;
}

export async function spotifyJson<T>(params: {
	db: Db;
	env: AppEnv;
	userId: string;
	path: string;
	method?: string;
	query?: Record<string, string | number | boolean | undefined>;
	body?: unknown;
	requiredScopes?: string[];
}): Promise<T> {
	const url = new URL(`https://api.spotify.com/v1${params.path}`);
	for (const [k, v] of Object.entries(params.query ?? {})) {
		if (v === undefined) continue;
		url.searchParams.set(k, String(v));
	}

	const doFetch = async (token: string) =>
		fetch(url, {
			method: params.method ?? "GET",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: params.body ? JSON.stringify(params.body) : undefined,
		});

	let accessToken = await getValidAccessToken({
		db: params.db,
		env: params.env,
		userId: params.userId,
		requiredScopes: params.requiredScopes,
	});
	let resp = await doFetch(accessToken);
	if (resp.status === 401) {
		accessToken = await getValidAccessToken({
			db: params.db,
			env: params.env,
			userId: params.userId,
			requiredScopes: params.requiredScopes,
		});
		resp = await doFetch(accessToken);
	}

	if (!resp.ok) {
		const text = await resp.text();
		let insufficientScope = false;
		try {
			const parsed = JSON.parse(text) as { error?: { message?: unknown } };
			const msg = parsed?.error?.message;
			insufficientScope =
				resp.status === 403 &&
				typeof msg === "string" &&
				msg.toLowerCase().includes("insufficient client scope");
		} catch {
			// ignore
		}
		if (insufficientScope) {
			throw new Error("Missing required Spotify scopes: spotify");
		}
		throw new Error(`Spotify API error (${resp.status}): ${text}`);
	}

	return (await resp.json()) as T;
}
