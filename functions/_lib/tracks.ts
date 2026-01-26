import type { Db } from "./db";
import type { AppEnv } from "./env";
import { spotifyJson } from "./spotify";

export type SpotifyTrackItem = {
	id: string;
	name: string;
	artists: Array<{ id: string; name: string }>;
	album: {
		id: string;
		name: string;
		images: Array<{ url: string; height: number | null; width: number | null }>;
	};
	preview_url: string | null;
	external_urls: { spotify: string };
	uri: string;
	duration_ms: number;
};

export type RankedTrack = {
	trk: SpotifyTrackItem;
	rank: number;
};

export type SpotifyTimeRange = "short_term" | "medium_term" | "long_term";

export function extractPlaylistId(input: string) {
	const trimmed = input.trim();
	if (!trimmed) return null;

	const uriMatch = /^spotify:playlist:([A-Za-z0-9]+)$/.exec(trimmed);
	if (uriMatch) return uriMatch[1];

	try {
		const url = new URL(trimmed);
		if (url.hostname.endsWith("spotify.com")) {
			const parts = url.pathname.split("/").filter(Boolean);
			const idx = parts.indexOf("playlist");
			if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
		}
	} catch {
		// ignore
	}

	if (/^[A-Za-z0-9]+$/.test(trimmed)) return trimmed;
	return null;
}

export async function fetchUserTopTracks(
	db: Db,
	env: AppEnv,
	params: { userId: string; timeRange: SpotifyTimeRange; limit?: number },
): Promise<RankedTrack[]> {
	const limit = Math.min(50, Math.max(1, params.limit ?? 50));
	const data = await spotifyJson<{ items: SpotifyTrackItem[] }>({
		db,
		env,
		userId: params.userId,
		path: "/me/top/tracks",
		query: {
			time_range: params.timeRange,
			limit,
		},
		requiredScopes: ["user-top-read"],
	});
	return data.items
		.filter((t) => Boolean(t?.id))
		.map((trk, i) => ({ trk, rank: i + 1 }));
}

export async function fetchUserPlaylists(
	db: Db,
	env: AppEnv,
	params: { userId: string; limit?: number; offset?: number },
): Promise<{
	items: Array<{
		id: string;
		name: string;
		images: Array<{ url: string; height: number | null; width: number | null }>;
		tracks: { total: number };
		owner: { display_name?: string };
		public: boolean | null;
	}>;
}> {
	return spotifyJson({
		db,
		env,
		userId: params.userId,
		path: "/me/playlists",
		query: {
			limit: Math.min(50, Math.max(1, params.limit ?? 50)),
			offset: Math.max(0, params.offset ?? 0),
		},
		requiredScopes: ["playlist-read-private"],
	});
}

export async function fetchPlaylistTracks(
	db: Db,
	env: AppEnv,
	params: { userId: string; playlistId: string; maxTracks?: number },
): Promise<RankedTrack[]> {
	const playlistId = extractPlaylistId(params.playlistId) ?? params.playlistId;
	const want = Math.min(200, Math.max(1, params.maxTracks ?? 200));

	const out: RankedTrack[] = [];
	let offset = 0;
	while (out.length < want) {
		const page = await spotifyJson<{
			items: Array<{ track: SpotifyTrackItem | null }>;
			next: string | null;
		}>({
			db,
			env,
			userId: params.userId,
			path: `/playlists/${playlistId}/tracks`,
			query: { limit: 100, offset },
			requiredScopes: ["playlist-read-private"],
		});

		for (const item of page.items) {
			if (out.length >= want) break;
			const trk = item.track;
			if (!trk?.id) continue;
			out.push({ trk, rank: out.length + 1 });
		}

		if (!page.next) break;
		offset += 100;
	}

	return out;
}
