import { useAuth } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { apiJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
	SpotifyTimeRangeSchema,
	type SpotifyTimeRange,
	type TournamentSource,
} from "@shared/api";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";

export const Route = createFileRoute("/new")({
	component: NewTournament,
});

type PlaylistItem = {
	id: string;
	name: string;
	imageUrl: string | null;
	tracksTotal: number;
};

function timeRangeLabel(r: SpotifyTimeRange) {
	switch (r) {
		case "short_term":
			return "Last 4 weeks";
		case "medium_term":
			return "Last 6 months";
		case "long_term":
			return "Last ~year+";
	}
}

function NewTournament() {
	const { me, loading } = useAuth();
	const [sourceType, setSourceType] =
		useState<TournamentSource>("top_tracks");
	const [timeRange, setTimeRange] = useState<SpotifyTimeRange>("medium_term");
	const [bracketSize, setBracketSize] = useState(32);
	const [mesh, setMesh] = useState(false);
	const [hostPlaylistId, setHostPlaylistId] = useState<string>("");
	const [playlistQuery, setPlaylistQuery] = useState<string>("");
	const [playlists, setPlaylists] = useState<PlaylistItem[] | null>(null);
	const [playlistsErr, setPlaylistsErr] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const canCreate = useMemo(() => {
		if (sourceType === "playlist" || sourceType === "playlist_vs")
			return Boolean(hostPlaylistId.trim());
		return true;
	}, [sourceType, hostPlaylistId]);

	useEffect(() => {
		if (sourceType !== "playlist" && sourceType !== "playlist_vs") return;
		if (!me) return;
		let cancelled = false;
		(async () => {
			setPlaylistsErr(null);
			try {
				const resp = await apiJson(
					"/api/me/playlists",
					{},
					z.object({
						playlists: z.array(
							z.object({
								id: z.string(),
								name: z.string(),
								imageUrl: z.string().nullable(),
								tracksTotal: z.number().int(),
							}),
						),
					}),
				);
				if (!cancelled) setPlaylists(resp.playlists);
			} catch (e) {
				if (cancelled) return;
				setPlaylists(null);
				setPlaylistsErr(e instanceof Error ? e.message : String(e));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [sourceType, me]);

	const selectedPlaylist = useMemo(() => {
		if (!playlists) return null;
		return playlists.find((p) => p.id === hostPlaylistId) ?? null;
	}, [playlists, hostPlaylistId]);

	const effectivePlaylistBracket = useMemo(() => {
		const total = selectedPlaylist?.tracksTotal;
		if (!total) return null;
		const requested = Math.min(bracketSize, total);
		const pow2 = 2 ** Math.floor(Math.log2(requested));
		return pow2 >= 2 ? pow2 : null;
	}, [selectedPlaylist, bracketSize]);

	function extractPlaylistId(input: string) {
		const v = input.trim();
		if (!v) return "";
		const uriMatch = /^spotify:playlist:([A-Za-z0-9]+)$/.exec(v);
		if (uriMatch) return uriMatch[1];
		try {
			const url = new URL(v);
			const parts = url.pathname.split("/").filter(Boolean);
			const idx = parts.indexOf("playlist");
			if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
		} catch {
			// ignore
		}
		return /^[A-Za-z0-9]+$/.test(v) ? v : "";
	}

	useEffect(() => {
		if (sourceType !== "playlist" && sourceType !== "playlist_vs") return;
		const extracted = extractPlaylistId(playlistQuery);
		if (extracted) setHostPlaylistId(extracted);
		else if (!playlistQuery.trim()) setHostPlaylistId("");
	}, [playlistQuery, sourceType]);

	async function create() {
		setBusy(true);
		setError(null);
		try {
			const payload = {
				sourceType,
				mesh,
				hostPlaylistId:
					sourceType === "playlist" || sourceType === "playlist_vs"
						? hostPlaylistId
						: undefined,
				timeRange,
				bracketSize,
			};

			if (me) {
				const resp = await apiJson(
					"/api/tournaments",
					{ method: "POST", body: JSON.stringify(payload) },
					z.object({ tournamentId: z.string() }),
				);
				window.location.assign(`/t/${resp.tournamentId}`);
				return;
			}

			const resp = await apiJson(
				"/api/login",
				{
					method: "POST",
					body: JSON.stringify({ role: "host", ...payload }),
				},
				z.object({ message: z.string() }),
			);
			window.location.assign(resp.message);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}

	async function reconnect() {
		const resp = await apiJson(
			"/api/login",
			{
				method: "POST",
				body: JSON.stringify({ role: "signin", returnTo: "/new" }),
			},
			z.object({ message: z.string() }),
		);
		window.location.assign(resp.message);
	}

	return (
		<div className="mx-auto w-full max-w-6xl px-5 py-10">
			<div className="flex flex-col items-start justify-between gap-4 md:flex-row md:items-end">
				<div>
					<div className="text-xs font-semibold tracking-[0.22em] text-muted-foreground">
						NEW DUEL
					</div>
					<div className="mt-2 font-display text-4xl font-semibold uppercase tracking-[0.12em] sm:text-5xl">
						Tune the machine
					</div>
					<div className="mt-2 text-sm text-muted-foreground">
						Choose how tracks are selected before generating the
						invite link.
					</div>
				</div>
				<div className="flex gap-2">
					<Link to="/">
						<Button variant="ghost">Home</Button>
					</Link>
				</div>
			</div>

			{error ? (
				<div className="mt-6 rounded-2xl border border-destructive/40 bg-destructive/10 p-4 text-sm">
					{error}
				</div>
			) : null}

			<div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-3">
				<Card className="p-6 lg:col-span-2">
					<div className="text-xs font-semibold tracking-[0.22em] text-muted-foreground">
						TRACK SOURCE
					</div>
					<div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
						<SourceCard
							active={sourceType === "top_tracks"}
							onClick={() => setSourceType("top_tracks")}
							title="Top tracks"
							subtitle="Your Spotify top"
						/>
						<SourceCard
							active={sourceType === "playlist"}
							onClick={() => setSourceType("playlist")}
							title="Playlist"
							subtitle="Choose a list"
						/>
						<SourceCard
							active={sourceType === "playlist_vs"}
							onClick={() => setSourceType("playlist_vs")}
							title="Playlist vs"
							subtitle="Two playlists duel"
						/>
					</div>

					<div
						className={cn(
							"mt-6 grid grid-cols-1 gap-6",
							sourceType === "playlist" || sourceType === "playlist_vs"
								? ""
								: "md:grid-cols-2",
						)}
					>
						{sourceType === "playlist" || sourceType === "playlist_vs" ? null : (
							<Card className="p-5">
								<div className="text-xs font-semibold tracking-[0.22em] text-muted-foreground">
									TIME RANGE
								</div>
								<div className="mt-3 grid grid-cols-1 gap-2">
									{SpotifyTimeRangeSchema.options.map((r) => (
										<button
											key={r}
											onClick={() => setTimeRange(r)}
											className={cn(
												"rounded-2xl border border-white/10 bg-background/20 px-4 py-3 text-left text-sm transition",
												r === timeRange
													? "border-[hsl(var(--jukebox-cyan))]/40 bg-[hsl(var(--jukebox-cyan))]/10"
													: "hover:bg-white/5",
											)}
									>
										<div className="font-semibold">{timeRangeLabel(r)}</div>
									</button>
									))}
								</div>
							</Card>
						)}

						<Card className="p-5">
							<div className="text-xs font-semibold tracking-[0.22em] text-muted-foreground">
								BRACKET SIZE
							</div>
							<div className="mt-3 grid grid-cols-3 gap-2">
								{[16, 32, 64].map((n) => (
									<button
										key={n}
										onClick={() => setBracketSize(n)}
										className={cn(
											"rounded-2xl border border-white/10 bg-background/20 px-4 py-4 text-center text-sm font-semibold transition",
											n === bracketSize
												? "border-[hsl(var(--jukebox-amber))]/40 bg-[hsl(var(--jukebox-amber))]/10"
												: "hover:bg-white/5",
										)}
									>
										{n}
									</button>
								))}
							</div>
							<div className="mt-3 text-xs text-muted-foreground">
								{sourceType === "playlist"
									? `Tracks used: ${bracketSize}`
									: `Tracks per player: ${Math.floor(bracketSize / 2)}`}
							</div>
						</Card>
					</div>

					{sourceType === "playlist" || sourceType === "playlist_vs" ? (
						<Card className="mt-6 p-5">
							<div className="flex flex-col items-start justify-between gap-3 md:flex-row md:items-center">
								<div>
									<div className="text-xs font-semibold tracking-[0.22em] text-muted-foreground">
										SELECT YOUR PLAYLIST
									</div>
								<div className="mt-2 text-sm text-muted-foreground">
									{sourceType === "playlist_vs"
										? "You bring a playlist. Your challenger brings theirs."
										: "The bracket is generated from this playlist only."}
								</div>
								</div>
								<div className="text-xs text-muted-foreground">
									{loading
										? "Checking session…"
										: me
											? "Signed in"
											: "Will sign in on create"}
								</div>
							</div>

							<div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
								<div>
									<label className="text-xs font-semibold tracking-[0.22em] text-muted-foreground">
										Paste playlist link
									</label>
									<input
										className="mt-2 h-11 w-full rounded-full border border-white/10 bg-background/30 px-4 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
										placeholder="https://open.spotify.com/playlist/..."
										value={playlistQuery}
										onChange={(e) =>
											setPlaylistQuery(e.target.value)
										}
									/>
									<div className="mt-2 text-xs text-muted-foreground">
										{hostPlaylistId
											? `Using playlist id: ${hostPlaylistId}`
											: "No playlist selected"}
									</div>
								</div>

								<div>
									<label className="text-xs font-semibold tracking-[0.22em] text-muted-foreground">
										Or choose from your playlists
									</label>
									<select
										className="mt-2 h-11 w-full rounded-full border border-white/10 bg-background/30 px-4 text-sm outline-none focus:ring-2 focus:ring-ring"
										value={hostPlaylistId}
										onChange={(e) =>
											setHostPlaylistId(e.target.value)
										}
										disabled={!me || !playlists}
									>
										<option value="">
											{me
												? "Select a playlist"
												: "Sign in to list playlists"}
										</option>
										{playlists?.map((p) => (
											<option key={p.id} value={p.id}>
												{p.name} ({p.tracksTotal})
											</option>
										))}
									</select>
									{playlistsErr ? (
										<div className="mt-2 text-xs text-muted-foreground">
											{playlistsErr}
											{playlistsErr.includes(
												"missing_scopes",
											) ? (
												<div className="mt-2">
													<Button
														variant="secondary"
														onClick={reconnect}
													>
														Reconnect Spotify
													</Button>
												</div>
											) : null}
										</div>
									) : null}
								</div>
							</div>

							<div className="mt-4 rounded-2xl border border-white/10 bg-background/20 p-4 text-xs text-muted-foreground">
								{selectedPlaylist
									? `Playlist has ${selectedPlaylist.tracksTotal} tracks. Bracket will use ${effectivePlaylistBracket ?? "?"}.`
									: "Pick a playlist with enough tracks for your bracket size."}
							</div>
						</Card>
					) : null}

					{/* Mood mode removed (Spotify audio features deprecated) */}
				</Card>

				<Card className="p-6">
					<div className="text-xs font-semibold tracking-[0.22em] text-muted-foreground">
						EXTRAS
					</div>
					<div className="mt-4 space-y-4">
						{sourceType !== "playlist" ? (
							<label className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-background/20 p-4">
								<div>
									<div className="text-sm font-semibold">
										Mesh tracks
									</div>
									<div className="mt-1 text-xs text-muted-foreground">
										Mix both players’ tracks throughout the
										bracket (not strict left/right sides).
									</div>
								</div>
								<input
									type="checkbox"
									checked={mesh}
									onChange={(e) => setMesh(e.target.checked)}
								/>
							</label>
						) : (
							<div className="rounded-2xl border border-white/10 bg-background/20 p-4 text-xs text-muted-foreground">
								Playlist mode uses a single track pool.
							</div>
						)}
					</div>
					<div className="mt-6">
						<Button
							size="lg"
							className="w-full"
							onClick={create}
							disabled={!canCreate || busy}
						>
							{busy
								? "Creating…"
								: me
									? "Create tournament"
									: "Connect Spotify & create"}
						</Button>
						<div className="mt-3 text-xs text-muted-foreground">
							{me
								? "Invite link is generated immediately after creation."
								: "You’ll be redirected to Spotify, then we drop you into the lobby with your invite link."}
						</div>
					</div>
				</Card>
			</div>
		</div>
	);
}

function SourceCard(props: {
	active: boolean;
	onClick: () => void;
	title: string;
	subtitle: string;
}) {
	return (
		<button
			onClick={props.onClick}
			className={cn(
				"rounded-3xl border border-white/10 bg-background/20 p-4 text-left transition",
				props.active
					? "border-[hsl(var(--jukebox-amber))]/40 bg-[hsl(var(--jukebox-amber))]/10"
					: "hover:bg-white/5",
			)}
		>
			<div className="text-sm font-semibold">{props.title}</div>
			<div className="mt-1 text-xs text-muted-foreground">
				{props.subtitle}
			</div>
		</button>
	);
}
