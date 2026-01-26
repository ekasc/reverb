import { env } from "../env";

export type SpotifyTokenResponse = {
	access_token: string;
	token_type: "Bearer";
	scope: string;
	expires_in: number;
	refresh_token?: string;
};

export function buildSpotifyAuthorizeUrl(params: {
	state: string;
	scopes: string[];
	redirectUri: string;
	showDialog?: boolean;
}) {
	const url = new URL("https://accounts.spotify.com/authorize");
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", env.SPOTIFY_CLIENT_ID);
	url.searchParams.set("redirect_uri", params.redirectUri);
	url.searchParams.set("state", params.state);
	url.searchParams.set("scope", params.scopes.join(" "));
	if (params.showDialog) url.searchParams.set("show_dialog", "true");
	return url.toString();
}

export async function exchangeSpotifyCode(code: string, redirectUri: string) {
	const body = new URLSearchParams();
	body.set("grant_type", "authorization_code");
	body.set("code", code);
	body.set("redirect_uri", redirectUri);

	const basic = Buffer.from(
		`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`,
		"utf8",
	).toString("base64");

	const resp = await fetch("https://accounts.spotify.com/api/token", {
		method: "POST",
		headers: {
			Authorization: `Basic ${basic}`,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body,
	});

	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(
			`Spotify token exchange failed (${resp.status}): ${text}`,
		);
	}

	return (await resp.json()) as SpotifyTokenResponse;
}

export async function refreshSpotifyToken(refreshToken: string) {
	const body = new URLSearchParams();
	body.set("grant_type", "refresh_token");
	body.set("refresh_token", refreshToken);

	const basic = Buffer.from(
		`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`,
		"utf8",
	).toString("base64");

	const resp = await fetch("https://accounts.spotify.com/api/token", {
		method: "POST",
		headers: {
			Authorization: `Basic ${basic}`,
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
