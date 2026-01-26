type SpotifyPlayerConstructor = new (opts: {
	name: string;
	getOAuthToken: (cb: (token: string) => void) => void;
	volume?: number;
}) => SpotifyPlayer;

type SpotifyPlayer = {
	connect: () => Promise<boolean>;
	disconnect: () => void;
	activateElement?: () => Promise<void>;
	addListener: (
		event:
			| "ready"
			| "not_ready"
			| "initialization_error"
			| "authentication_error"
			| "account_error"
			| "playback_error",
		cb: (payload: any) => void,
	) => boolean;
	removeListener: (
		event:
			| "ready"
			| "not_ready"
			| "initialization_error"
			| "authentication_error"
			| "account_error"
			| "playback_error",
		cb?: (payload: any) => void,
	) => boolean;
};

type SpotifySdkGlobal = {
	Player: SpotifyPlayerConstructor;
};

declare global {
	interface Window {
		Spotify?: SpotifySdkGlobal;
		onSpotifyWebPlaybackSDKReady?: () => void;
	}
}

function loadSpotifySdk(): Promise<void> {
	if (typeof window === "undefined") return Promise.reject();
	if (window.Spotify?.Player) return Promise.resolve();

	return new Promise((resolve, reject) => {
		const existing = document.querySelector(
			"script[data-spotify-web-playback]",
		);
		if (existing) {
			// Another part of the app is loading it; wait for ready.
			const check = () => {
				if (window.Spotify?.Player) resolve();
				else setTimeout(check, 50);
			};
			check();
			return;
		}

		const script = document.createElement("script");
		script.src = "https://sdk.scdn.co/spotify-player.js";
		script.async = true;
		script.dataset.spotifyWebPlayback = "true";
		script.onerror = () => reject(new Error("spotify_sdk_load_failed"));

		window.onSpotifyWebPlaybackSDKReady = () => resolve();
		document.head.appendChild(script);
	});
}

export type WebPlaybackClient = {
	ready: boolean;
	deviceId: string | null;
	error: string | null;
	subscribe: (cb: () => void) => () => void;
	play: (params: { uri: string; clipMs: number; positionMs?: number }) => Promise<void>;
	pause: () => Promise<void>;
	destroy: () => void;
};

export async function createWebPlaybackClient(params: {
	getAccessToken: () => Promise<string>;
	name?: string;
}): Promise<WebPlaybackClient> {
	await loadSpotifySdk();
	if (!window.Spotify?.Player) throw new Error("spotify_sdk_missing");

	let deviceId: string | null = null;
	let ready = false;
	let lastError: string | null = null;
	let clipTimeout: number | null = null;
	let transferred = false;
	let op: Promise<void> = Promise.resolve();
	const subs = new Set<() => void>();
	const notify = () => {
		for (const cb of subs) cb();
	};
	const run = async <T,>(fn: () => Promise<T>): Promise<T> => {
		const next = op.then(fn, fn);
		op = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	};

	const player = new window.Spotify.Player({
		name: params.name ?? "Re:Verb",
		getOAuthToken: (cb) => {
			void params
				.getAccessToken()
				.then((t) => cb(t))
				.catch(() => cb(""));
		},
		volume: 0.7,
	});

	player.addListener("ready", (e: { device_id?: string }) => {
		deviceId = e?.device_id ?? null;
		ready = Boolean(deviceId);
		transferred = false;
		notify();
	});
	player.addListener("not_ready", () => {
		ready = false;
		transferred = false;
		notify();
	});

	const onErr = (e: { message?: string }) => {
		lastError = e?.message ?? "spotify_player_error";
		notify();
	};
	player.addListener("initialization_error", onErr);
	player.addListener("authentication_error", onErr);
	player.addListener("account_error", onErr);
	player.addListener("playback_error", onErr);

	const ok = await player.connect();
	if (!ok) throw new Error("spotify_player_connect_failed");

	async function transferPlayback() {
		const did = deviceId;
		if (!did) throw new Error("spotify_device_not_ready");
		const token = await params.getAccessToken();
		const resp = await fetch("https://api.spotify.com/v1/me/player", {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ device_ids: [did], play: false }),
		});
		if (!resp.ok && resp.status !== 204) {
			const text = await resp.text().catch(() => "");
			throw new Error(`spotify_transfer_failed_${resp.status}: ${text}`);
		}
		transferred = true;
	}

	async function spotifyErrorMessage(resp: Response) {
		try {
			const j = (await resp.json()) as any;
			const msg = j?.error?.message;
			if (typeof msg === "string") return msg;
		} catch {
			// ignore
		}
		return resp.statusText || `spotify_http_${resp.status}`;
	}

	async function pause() {
		await run(async () => {
			if (clipTimeout) {
				window.clearTimeout(clipTimeout);
				clipTimeout = null;
			}
			if (!deviceId) return;
			const token = await params.getAccessToken();
			await fetch(
				`https://api.spotify.com/v1/me/player/pause?device_id=${encodeURIComponent(deviceId)}`,
				{
					method: "PUT",
					headers: { Authorization: `Bearer ${token}` },
				},
			);
		});
	}

	async function play(p: { uri: string; clipMs: number; positionMs?: number }) {
		await run(async () => {
			if (clipTimeout) {
				window.clearTimeout(clipTimeout);
				clipTimeout = null;
			}
			if (!deviceId) throw new Error("spotify_device_not_ready");
			const did = deviceId;

			// Some browsers require this to be called from a user gesture
			await player.activateElement?.();

			if (!transferred) await transferPlayback();

			const doPlay = async () => {
				const token = await params.getAccessToken();
				return fetch(
					`https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(did)}`,
					{
						method: "PUT",
						headers: {
							Authorization: `Bearer ${token}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							uris: [p.uri],
							position_ms: Math.max(0, p.positionMs ?? 0),
						}),
					},
				);
			};

			let resp = await doPlay();
			if (!resp.ok) {
				const msg = await spotifyErrorMessage(resp);
				if (
					resp.status === 404 &&
					msg.toLowerCase().includes("device not found")
				) {
					transferred = false;
					await transferPlayback();
					await new Promise((r) => setTimeout(r, 200));
					resp = await doPlay();
				}
			}
			if (!resp.ok) {
				const msg = await spotifyErrorMessage(resp);
				throw new Error(`spotify_play_failed_${resp.status}: ${msg}`);
			}

			clipTimeout = window.setTimeout(() => {
				void pause();
			}, p.clipMs);
		});
	}

	function destroy() {
		if (clipTimeout) {
			window.clearTimeout(clipTimeout);
			clipTimeout = null;
		}
		subs.clear();
		player.disconnect();
	}

	return {
		get ready() {
			return ready;
		},
		get deviceId() {
			return deviceId;
		},
		get error() {
			return lastError;
		},
		subscribe: (cb) => {
			subs.add(cb);
			return () => subs.delete(cb);
		},
		play,
		pause,
		destroy,
	};
}
