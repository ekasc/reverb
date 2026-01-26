import { NeonGradientCard } from "@/components/magicui/neon-gradient-card";
import { useAuth } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { apiJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import { TournamentSchema, type SpotifyTimeRange } from "@shared/api";
import {
	createFileRoute,
	Link,
	Outlet,
	useRouterState,
} from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";

export const Route = createFileRoute("/t/$id")({
	component: TournamentLobby,
});

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

function TournamentLobby() {
	const { id } = Route.useParams();
	const { me, loading: authLoading } = useAuth();
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const [tournament, setTournament] = useState<ReturnType<
		typeof TournamentSchema.parse
	> | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [starting, setStarting] = useState(false);
	const [needsReauth, setNeedsReauth] = useState(false);
	const [copied, setCopied] = useState(false);
	const [playlistInput, setPlaylistInput] = useState("");
	const [challengerPlaylistInput, setChallengerPlaylistInput] =
		useState("");
	const [savingPlaylist, setSavingPlaylist] = useState(false);
	const [savingChallengerPlaylist, setSavingChallengerPlaylist] =
		useState(false);
	const [challengerPlaylists, setChallengerPlaylists] = useState<
		Array<{ id: string; name: string; tracksTotal: number }> | null
	>(null);
	const [challengerPlaylistsErr, setChallengerPlaylistsErr] = useState<
		string | null
	>(null);
	const isHost = Boolean(me && tournament?.host?.id === me.id);
	const isChallenger = Boolean(me && tournament?.challenger?.id === me.id);

	const joinUrl = useMemo(() => {
		return `${window.location.origin}/t/${id}/join`;
	}, [id]);
	const playUrl = useMemo(() => {
		return `${window.location.origin}/t/${id}/play`;
	}, [id]);

	useEffect(() => {
		let cancelled = false;

		const load = async () => {
			try {
				const resp = await apiJson(
					`/api/tournaments/${id}`,
					{},
					z.object({ tournament: TournamentSchema }),
				);
				if (!cancelled) {
					setTournament(resp.tournament);
					setError(null);
				}
			} catch (e) {
				if (!cancelled)
					setError(e instanceof Error ? e.message : String(e));
			}
		};

		void load();
		const interval = window.setInterval(load, 2000);

		return () => {
			cancelled = true;
			window.clearInterval(interval);
		};
	}, [id]);

	useEffect(() => {
		if (tournament?.sourceType !== "playlist_vs") return;
		if (!me) return;
		if (!isChallenger) return;
		let cancelled = false;
		(async () => {
			setChallengerPlaylistsErr(null);
			try {
				const resp = await apiJson(
					"/api/me/playlists",
					{},
					z.object({
						playlists: z.array(
							z.object({
								id: z.string(),
								name: z.string(),
								tracksTotal: z.number().int(),
							}),
						),
					}),
				);
				if (!cancelled) setChallengerPlaylists(resp.playlists);
			} catch (e) {
				if (cancelled) return;
				setChallengerPlaylists(null);
				setChallengerPlaylistsErr(
					e instanceof Error ? e.message : String(e),
				);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [tournament?.sourceType, me?.id, isChallenger]);

	async function copyLink(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			setTimeout(() => setCopied(false), 1200);
		} catch {
			// ignore
		}
	}

	async function startBracket() {
		setStarting(true);
		setActionError(null);
		setNeedsReauth(false);
		try {
			await apiJson(`/api/tournaments/${id}/start`, {
				method: "POST",
			});
			window.location.assign(`/t/${id}/play`);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			setActionError(msg);
			if (msg.includes("missing_scopes")) setNeedsReauth(true);
		} finally {
			setStarting(false);
		}
	}

	async function reconnect() {
		const resp = await apiJson(
			"/api/login",
			{
				method: "POST",
				body: JSON.stringify({ role: "signin", returnTo: `/t/${id}` }),
			},
			z.object({ message: z.string() }),
		);
		window.location.assign(resp.message);
	}

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

	async function saveHostPlaylist() {
		const playlistId = extractPlaylistId(playlistInput);
		if (!playlistId) {
			setActionError("Please paste a valid Spotify playlist link or id.");
			return;
		}

		setSavingPlaylist(true);
		setActionError(null);
		try {
			await apiJson(`/api/tournaments/${id}/settings`, {
				method: "PATCH",
				body: JSON.stringify({ hostPlaylistId: playlistId }),
			});
			setPlaylistInput("");
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			setActionError(msg);
			if (msg.includes("missing_scopes")) setNeedsReauth(true);
		} finally {
			setSavingPlaylist(false);
		}
	}

	async function saveChallengerPlaylistId(raw: string) {
		const playlistId = extractPlaylistId(raw);
		if (!playlistId) {
			setActionError("Please paste a valid Spotify playlist link or id.");
			return;
		}

		setSavingChallengerPlaylist(true);
		setActionError(null);
		try {
			await apiJson(`/api/tournaments/${id}/settings`, {
				method: "PATCH",
				body: JSON.stringify({ challengerPlaylistId: playlistId }),
			});
			setChallengerPlaylistInput("");
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			setActionError(msg);
			if (msg.includes("missing_scopes")) setNeedsReauth(true);
		} finally {
			setSavingChallengerPlaylist(false);
		}
	}

	async function saveChallengerPlaylist() {
		return saveChallengerPlaylistId(challengerPlaylistInput);
	}

	const basePath = `/t/${id}`;
	if (pathname !== basePath && pathname !== `${basePath}/`) {
		return <Outlet />;
	}

	if (error) {
		return (
			<div className="mx-auto w-full max-w-3xl px-5 py-10">
				<Card className="p-6">
					<div className="text-xl font-semibold">
						Tournament not found
					</div>
					<div className="mt-2 text-sm text-muted-foreground">
						{error}
					</div>
					<div className="mt-6">
						<Link to="/">
							<Button>Back Home</Button>
						</Link>
					</div>
				</Card>
			</div>
		);
	}

	if (!tournament) {
		return (
			<div className="mx-auto w-full max-w-3xl px-5 py-10">
				<Card className="p-6">
					<div className="text-xl font-semibold">Loading lobby…</div>
					<div className="mt-2 text-sm text-muted-foreground">
						Fetching tournament state.
					</div>
				</Card>
			</div>
		);
	}

	const shareUrl = tournament.sourceType === "playlist" ? playUrl : joinUrl;
	const shareLabel =
		tournament.sourceType === "playlist" ? "Play link" : "Invite link";

	const canStart =
		tournament.status === "ready" ||
		tournament.status === "in_progress" ||
		tournament.status === "completed";

	const playlistsReady =
		tournament.sourceType === "playlist"
			? Boolean(tournament.hostPlaylistId)
			: tournament.sourceType === "playlist_vs"
				? Boolean(
						tournament.hostPlaylistId &&
							tournament.challengerPlaylistId,
					)
				: true;
	const hasPlayers =
		tournament.sourceType === "playlist"
			? true
			: Boolean(tournament.host) && Boolean(tournament.challenger);
	const readyToStart = canStart && playlistsReady && hasPlayers;

	return (
		<div className="mx-auto w-full max-w-6xl px-5 py-10">
			<div className="flex flex-col gap-6">
				<div className="flex items-end justify-between gap-4">
					<div>
						<div className="text-xs font-semibold tracking-[0.22em] text-muted-foreground">
							DUEL LOBBY
						</div>
						<div className="mt-2 font-display text-4xl font-semibold uppercase tracking-[0.12em] sm:text-5xl">
							{tournament.host?.displayName ?? "Host"} vs{" "}
							{tournament.challenger?.displayName ?? "Challenger"}
						</div>
						<div className="mt-2 text-sm text-muted-foreground">
							{tournament.sourceType === "playlist" ||
							tournament.sourceType === "playlist_vs"
								? `${tournament.bracketSize}-song bracket`
								: `${timeRangeLabel(tournament.timeRange)} · ${tournament.bracketSize}-song bracket`}
						</div>
					</div>

					<div className="flex items-center gap-2">
						{tournament.status === "completed" ? (
							<Link to="/t/$id/results" params={{ id }}>
								<Button className="text-lg">
									View Results
								</Button>
							</Link>
						) : tournament.status === "in_progress" ? (
							<Link to="/t/$id/play" params={{ id }}>
								<Button className="text-lg">Continue</Button>
							</Link>
						) : canStart ? (
							<Button
								className="text-lg"
								onClick={startBracket}
								disabled={starting || !readyToStart}
							>
								Start Bracket
							</Button>
						) : null}
					</div>
				</div>

				{actionError ? (
					<Card className="p-4">
						<div className="text-sm font-semibold">
							Could not start
						</div>
						<div className="mt-2 text-sm text-muted-foreground">
							{actionError}
						</div>
						{needsReauth ? (
							<div className="mt-4">
								<Button variant="secondary" onClick={reconnect}>
									Reconnect Spotify
								</Button>
							</div>
						) : null}
					</Card>
				) : null}

				{tournament.sourceType === "playlist" ||
					tournament.sourceType === "playlist_vs" ? (
					<Card className="p-6">
						<div className="text-xs font-semibold tracking-[0.22em] text-muted-foreground">
							PLAYLIST SETUP
						</div>
						<div className="mt-3 text-sm text-muted-foreground">
							{tournament.sourceType === "playlist_vs"
								? "Both players bring a playlist. Tracks compete head-to-head."
								: "This tournament is generated from the host’s playlist."}
						</div>
						<div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
							<div className="rounded-2xl border border-white/10 bg-background/20 p-4">
								<div className="text-xs font-semibold tracking-[0.22em] text-muted-foreground">
									HOST PLAYLIST
								</div>
								<div className="mt-2 text-sm">
									{tournament.hostPlaylistId
										? "Selected"
										: "Not selected"}
								</div>
							</div>
							<div className="rounded-2xl border border-white/10 bg-background/20 p-4">
								<div className="text-xs font-semibold tracking-[0.22em] text-muted-foreground">
									{tournament.sourceType === "playlist_vs"
										? "CHALLENGER PLAYLIST"
										: "TRACK POOL"}
								</div>
								<div className="mt-2 text-sm">
									{tournament.sourceType === "playlist_vs"
										? tournament.challengerPlaylistId
											? "Selected"
											: "Not selected"
										: "Host playlist only"}
								</div>
							</div>
						</div>

						{isHost ? (
							<div className="mt-5">
								<div className="text-xs font-semibold tracking-[0.22em] text-muted-foreground">
									HOST PLAYLIST
								</div>
								<div className="mt-2 flex flex-col gap-2 md:flex-row">
									<input
										className="h-11 w-full rounded-full border border-white/10 bg-background/30 px-4 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
										placeholder="Paste playlist link or id"
										value={playlistInput}
										onChange={(e) =>
											setPlaylistInput(e.target.value)
										}
									/>
									<Button
										variant="secondary"
										disabled={savingPlaylist}
										onClick={() => void saveHostPlaylist()}
									>
										{savingPlaylist ? "Saving…" : "Save"}
									</Button>
								</div>
								<div className="mt-2 text-xs text-muted-foreground">
									If you don’t know the id, open Spotify →
									Share → Copy link.
								</div>
							</div>
						) : null}

						{tournament.sourceType === "playlist_vs" && tournament.challenger ? (
							<div className="mt-5">
								<div className="text-xs font-semibold tracking-[0.22em] text-muted-foreground">
									CHALLENGER PLAYLIST
								</div>
								<div className="mt-2 flex flex-col gap-2 md:flex-row">
									<input
										className="h-11 w-full rounded-full border border-white/10 bg-background/30 px-4 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
										placeholder="Paste playlist link or id"
										value={challengerPlaylistInput}
										onChange={(e) =>
											setChallengerPlaylistInput(e.target.value)
										}
										disabled={authLoading || !isChallenger}
									/>
									<Button
										variant="secondary"
										disabled={
											authLoading ||
											!isChallenger ||
											savingChallengerPlaylist
										}
										onClick={() => void saveChallengerPlaylist()}
									>
										{savingChallengerPlaylist ? "Saving…" : "Save"}
									</Button>
								</div>
								<div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
									<div className="rounded-2xl border border-white/10 bg-background/20 p-4">
										<div className="text-xs font-semibold tracking-[0.22em] text-muted-foreground">
											Or choose from your playlists
										</div>
									<select
										className="mt-3 h-11 w-full rounded-full border border-white/10 bg-background/30 px-4 text-sm outline-none focus:ring-2 focus:ring-ring"
										onChange={(e) => {
											const v = e.target.value;
											setChallengerPlaylistInput(v);
											if (v) void saveChallengerPlaylistId(v);
										}}
										value={
											challengerPlaylists?.some((p) => p.id === challengerPlaylistInput)
												? challengerPlaylistInput
												: ""
										}
										disabled={authLoading || !isChallenger || !challengerPlaylists}
									>
											<option value="">
												{authLoading
													? "Checking session…"
													: isChallenger
														? "Select a playlist"
														: "Join as challenger to select"}
											</option>
											{challengerPlaylists?.map((p) => (
												<option key={p.id} value={p.id}>
													{p.name} ({p.tracksTotal})
												</option>
											))}
										</select>
										{challengerPlaylistsErr ? (
											<div className="mt-2 text-xs text-muted-foreground">
												{challengerPlaylistsErr}
												{challengerPlaylistsErr.includes("missing_scopes") ? (
													<div className="mt-2">
														<Button variant="secondary" onClick={reconnect}>
															Reconnect Spotify
														</Button>
													</div>
												) : null}
											</div>
										) : null}
									</div>
									<div className="rounded-2xl border border-white/10 bg-background/20 p-4 text-xs text-muted-foreground">
										{authLoading
											? "Checking your session…"
											: isChallenger
												? "Dropdown selection auto-saves. Paste + Save also works."
												: "Only the challenger account can set this playlist."}
									</div>
								</div>
							</div>
						) : null}
					</Card>
				) : null}

				<div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
					<NeonGradientCard
						className="h-full"
						neonColors={{
							firstColor: "#ff2da4",
							secondColor: "#00e5ff",
						}}
					>
						<div className="flex flex-col gap-4">
							<div className="text-xs font-semibold tracking-[0.22em] text-muted-foreground">
								Players
							</div>
							<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
								<PlayerCard
									label="Host"
									displayName={
										tournament.host?.displayName ??
										"Not connected"
									}
									imageUrl={tournament.host?.imageUrl ?? null}
									ready={Boolean(tournament.host)}
								/>
								<PlayerCard
									label="Challenger"
									displayName={
										tournament.challenger?.displayName ??
										"Waiting on link"
									}
									imageUrl={
										tournament.challenger?.imageUrl ?? null
									}
									ready={Boolean(tournament.challenger)}
								/>
							</div>

							<div className="mt-2 rounded-2xl border border-white/10 bg-background/40 p-4">
								<div className="flex items-center justify-between gap-3">
									<div className="min-w-0">
										<div className="text-xs font-semibold tracking-[0.22em] text-muted-foreground">
											{shareLabel}
										</div>
										<div className="mt-1 truncate font-mono text-sm">
											{shareUrl}
										</div>
									</div>
									<Button
										variant="secondary"
										onClick={() => copyLink(shareUrl)}
									>
										{copied ? "Copied" : "Copy"}
									</Button>
								</div>
								<div className="mt-3 text-xs text-muted-foreground">
									{tournament.sourceType === "playlist"
										? "Anyone can play from the play link. Spotify is optional for the challenger."
										: "Challenger must connect Spotify once to load their top tracks."}
								</div>
								<div className="mt-2">
									<Link to="/t/$id/join" params={{ id }}>
										<Button
											className="w-full"
											variant="outline"
										>
											{tournament.sourceType ===
											"playlist"
												? "Connect Spotify (optional)"
												: "Join as Challenger (this device)"}
										</Button>
									</Link>
								</div>
							</div>
						</div>
					</NeonGradientCard>

					<Card className="p-6">
						<div className="text-sm font-semibold tracking-wide text-muted-foreground">
							What happens next
						</div>
						<div className="mt-4 space-y-3 text-sm">
							<Step
								n={1}
								text="Host connects Spotify (done when you land here)."
								done={Boolean(tournament.host)}
							/>
							<Step
								n={2}
								text="Challenger connects Spotify via invite link."
								done={Boolean(tournament.challenger)}
							/>
							<Step
								n={3}
								text="Start the bracket and pick winners match by match."
								done={tournament.status === "in_progress"}
							/>
							<Step
								n={4}
								text="Generate a playlist of the final ranking (optional)."
								done={tournament.status === "completed"}
							/>
						</div>
						<div className="mt-6 flex flex-wrap gap-2">
							<Link to="/t/$id/play" params={{ id }}>
								<Button
									variant="secondary"
									disabled={!canStart}
								>
									Go to Play
								</Button>
							</Link>
							<Link to="/">
								<Button variant="ghost">Home</Button>
							</Link>
						</div>
					</Card>
				</div>
			</div>
		</div>
	);
}

function PlayerCard(props: {
	label: string;
	displayName: string;
	imageUrl: string | null;
	ready: boolean;
}) {
	return (
		<div
			className={cn(
				"flex items-center gap-3 rounded-2xl border border-white/10 p-4",
				props.ready ? "bg-background/40" : "bg-muted/20",
			)}
		>
			<div
				className={cn(
					"h-11 w-11 overflow-hidden rounded-xl border border-white/10",
					props.ready
						? "shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_0_30px_rgba(0,229,255,0.12)]"
						: "opacity-70",
				)}
			>
				{props.imageUrl ? (
					<img
						alt=""
						src={props.imageUrl}
						className="h-full w-full object-cover"
					/>
				) : (
					<div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
						—
					</div>
				)}
			</div>
			<div className="min-w-0">
				<div className="text-xs font-semibold text-muted-foreground">
					{props.label}
				</div>
				<div className="truncate text-lg font-semibold">
					{props.displayName}
				</div>
			</div>
		</div>
	);
}

function Step(props: { n: number; text: string; done: boolean }) {
	return (
		<div className="flex items-start gap-3">
			<div
				className={cn(
					"mt-0.5 flex h-6 w-6 items-center justify-center rounded-full border text-xs font-semibold",
					props.done
						? "border-spotify/40 bg-spotify/10 text-spotify"
						: "border-border text-muted-foreground",
				)}
			>
				{props.n}
			</div>
			<div className="text-sm text-muted-foreground">{props.text}</div>
		</div>
	);
}
