import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { apiJson } from "@/lib/api";
import { useAuth } from "@/components/auth-provider";
import { pickDuelRemark } from "@/lib/duel-remarks";
import { createWebPlaybackClient } from "@/lib/spotify-web-playback";
import { cn } from "@/lib/utils";
import {
	TournamentSchema,
	TournamentStateSchema,
	type TournamentState,
} from "@shared/api";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

export const Route = createFileRoute("/t/$id/play")({
	component: PlayTournament,
});

function PlayTournament() {
	const { id } = Route.useParams();
	const { me, loading: authLoading } = useAuth();
	const [state, setState] = useState<TournamentState | null>(null);
	const [tournament, setTournament] = useState<ReturnType<
		typeof TournamentSchema.parse
	> | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [needsReauth, setNeedsReauth] = useState(false);
	const [busy, setBusy] = useState(false);
	const [playingId, setPlayingId] = useState<string | null>(null);
	const [blindMode, setBlindMode] = useState(true);
	// Hide track metadata until after each pick.
	const [queuedRemark, setQueuedRemark] = useState<{
		matchKey: string;
		winner: MatchTrack;
		loser: MatchTrack;
		remark: string;
	} | null>(null);
	const [lastRemark, setLastRemark] = useState<{
		remark: string;
		winnerName: string;
		loserName: string;
		winnerRank: number;
		loserRank: number;
	} | null>(null);
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const clipTimeoutRef = useRef<number | null>(null);
	const [webPlaybackErr, setWebPlaybackErr] = useState<string | null>(null);
	const [webPlaybackTick, setWebPlaybackTick] = useState(0);
	const webPlaybackRef = useRef<Awaited<
		ReturnType<typeof createWebPlaybackClient>
	> | null>(null);
	const preloadedAudioRef = useRef(new Map<string, HTMLAudioElement>());
	const accessTokenCacheRef = useRef<{
		token: string;
		expiresAt: number;
	} | null>(null);

	const CLIP_MS = 6500;
	const PREMIUM_CLIP_MS = 27_000;
	const [hotkeysEnabled, setHotkeysEnabled] = useState(true);
	const premium = !authLoading && me?.product === "premium";
	const canUseWebPlayback =
		premium &&
		webPlaybackTick >= 0 &&
		Boolean(webPlaybackRef.current?.ready) &&
		!webPlaybackErr;

	const labels = useMemo(() => {
		const byId = new Map<string, string>();
		if (tournament?.host)
			byId.set(tournament.host.id, tournament.host.displayName);
		if (tournament?.challenger)
			byId.set(
				tournament.challenger.id,
				tournament.challenger.displayName,
			);
		return byId;
	}, [tournament]);

	async function refresh() {
		const [tResp, sResp] = await Promise.all([
			apiJson(
				`/api/tournaments/${id}`,
				{},
				z.object({ tournament: TournamentSchema }),
			),
			apiJson(`/api/tournaments/${id}/state`, {}, TournamentStateSchema),
		]);
		setTournament(tResp.tournament);
		setState(sResp);
	}

	useEffect(() => {
		refresh().catch((e) =>
			setError(e instanceof Error ? e.message : String(e)),
		);
	}, [id]);

	useEffect(() => {
		if (!hotkeysEnabled) return;
		if (!state?.bracket?.nextMatch) return;
		const a = state.bracket.nextMatch.a;
		const b = state.bracket.nextMatch.b;
		if (!a || !b) return;

		const onKeyDown = (e: KeyboardEvent) => {
			const tag = (document.activeElement?.tagName ?? "").toLowerCase();
			if (tag === "input" || tag === "textarea" || tag === "select")
				return;
			if (busy) return;
			if (e.key === "1") void vote(a.trackId);
			if (e.key === "2") void vote(b.trackId);
			if (e.key.toLowerCase() === "q") togglePlay(a);
			if (e.key.toLowerCase() === "w") togglePlay(b);
		};

		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [hotkeysEnabled, state?.bracket?.nextMatch, busy]);

	useEffect(() => {
		const a = state?.bracket?.nextMatch?.a;
		const b = state?.bracket?.nextMatch?.b;
		const candidates = [a, b].filter(Boolean) as Array<{
			trackId: string;
			data: { previewUrl: string | null };
		}>;

		for (const t of candidates) {
			const url = t.data.previewUrl;
			if (!url) continue;
			if (preloadedAudioRef.current.has(t.trackId)) continue;
			const audio = new Audio(url);
			audio.preload = "auto";
			try {
				audio.load();
			} catch {
				// ignore
			}
			preloadedAudioRef.current.set(t.trackId, audio);
		}

		// Keep the cache small (current matchup + a little slack)
		if (preloadedAudioRef.current.size > 8) {
			const keep = new Set(candidates.map((t) => t.trackId));
			for (const k of preloadedAudioRef.current.keys()) {
				if (preloadedAudioRef.current.size <= 8) break;
				if (keep.has(k)) continue;
				preloadedAudioRef.current.delete(k);
			}
		}
	}, [
		state?.bracket?.nextMatch?.a?.trackId,
		state?.bracket?.nextMatch?.b?.trackId,
	]);

	function stopPlayback() {
		if (clipTimeoutRef.current) {
			window.clearTimeout(clipTimeoutRef.current);
			clipTimeoutRef.current = null;
		}
		void webPlaybackRef.current?.pause();
		audioRef.current?.pause();
		audioRef.current = null;
		setPlayingId(null);
	}

	useEffect(() => {
		return () => {
			stopPlayback();
			webPlaybackRef.current?.destroy();
			webPlaybackRef.current = null;
		};
	}, []);

	useEffect(() => {
		if (!queuedRemark) return;
		const next = state?.bracket?.nextMatch;
		const nextKey = next ? `r${next.round}m${next.match}` : "completed";
		if (nextKey === queuedRemark.matchKey) return;

		setLastRemark({
			remark: queuedRemark.remark,
			winnerName: queuedRemark.winner.data.name,
			loserName: queuedRemark.loser.data.name,
			winnerRank: queuedRemark.winner.rank,
			loserRank: queuedRemark.loser.rank,
		});
		setQueuedRemark(null);
	}, [
		queuedRemark,
		state?.bracket?.nextMatch?.round,
		state?.bracket?.nextMatch?.match,
		state?.bracket?.nextMatch ? 1 : 0,
	]);

	useEffect(() => {
		if (authLoading || !premium) {
			webPlaybackRef.current?.destroy();
			webPlaybackRef.current = null;
			setWebPlaybackErr(null);
			setWebPlaybackTick((t) => t + 1);
			return;
		}

		let cancelled = false;
		(async () => {
			try {
				setNeedsReauth(false);
				accessTokenCacheRef.current = null;
				const client = await createWebPlaybackClient({
					name: "Re:Verb",
					getAccessToken: async () => {
						const cached = accessTokenCacheRef.current;
						if (cached && cached.expiresAt > Date.now())
							return cached.token;
						const resp = await apiJson(
							"/api/spotify/access-token",
							{},
							z.object({ accessToken: z.string().min(1) }),
						);
						// Token lifetime varies; keep a short-lived cache to avoid extra RTTs.
						accessTokenCacheRef.current = {
							token: resp.accessToken,
							expiresAt: Date.now() + 25_000,
						};
						return resp.accessToken;
					},
				});

				if (cancelled) {
					client.destroy();
					return;
				}

				webPlaybackRef.current?.destroy();
				webPlaybackRef.current = client;
				setWebPlaybackErr(null);
				client.subscribe(() => setWebPlaybackTick((t) => t + 1));
				setWebPlaybackTick((t) => t + 1);
			} catch (e) {
				if (cancelled) return;
				const msg = e instanceof Error ? e.message : String(e);
				setWebPlaybackErr(msg);
				if (msg.includes("missing_scopes")) setNeedsReauth(true);
				webPlaybackRef.current?.destroy();
				webPlaybackRef.current = null;
				setWebPlaybackTick((t) => t + 1);
			}
		})();

		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [premium]);

	async function startBracket() {
		setBusy(true);
		setError(null);
		setNeedsReauth(false);
		try {
			await apiJson(`/api/tournaments/${id}/start`, { method: "POST" });
			await refresh();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			setError(msg);
			if (msg.includes("missing_scopes")) setNeedsReauth(true);
		} finally {
			setBusy(false);
		}
	}

	async function reconnect() {
		const resp = (await apiJson("/api/login", {
			method: "POST",
			body: JSON.stringify({ role: "playback", returnTo: `/t/${id}/play` }),
		})) as { message: string };
		window.location.assign(resp.message);
	}

	async function vote(winnerTrackId: string) {
		if (!state?.bracket?.nextMatch) return;
		const matchSnap = state.bracket.nextMatch;
		stopPlayback();
		setBusy(true);
		setError(null);
		try {
			await apiJson(`/api/tournaments/${id}/vote`, {
				method: "POST",
				body: JSON.stringify({
					round: state.bracket.nextMatch.round,
					match: state.bracket.nextMatch.match,
					winnerTrackId,
				}),
			});

			const a = matchSnap.a as MatchTrack | null;
			const b = matchSnap.b as MatchTrack | null;
			if (a && b) {
				const winner = winnerTrackId === a.trackId ? a : b;
				const loser = winnerTrackId === a.trackId ? b : a;
				const seedGap = Math.abs(winner.rank - loser.rank);
				const upset = winner.rank > loser.rank;
				const matchKey = `r${matchSnap.round}m${matchSnap.match}`;
				setQueuedRemark({
					matchKey,
					winner,
					loser,
					remark: pickDuelRemark({
						tournamentId: id,
						round: matchSnap.round,
						match: matchSnap.match,
						winnerId: winner.trackId,
						seedWinner: winner.rank,
						seedLoser: loser.rank,
						upset,
						seedGap,
					}),
				});
			}
			await refresh();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}

	type MatchTrack = {
		trackId: string;
		rank: number;
		data: {
			name: string;
			artists: Array<{ name: string }>;
			album: { imageUrl: string | null };
			previewUrl: string | null;
			spotifyUrl: string;
			uri: string;
			durationMs: number;
		};
	};

	function togglePlay(track: MatchTrack | null) {
		if (!track) return;

		if (playingId === track.trackId) {
			stopPlayback();
			return;
		}
		stopPlayback();

		if (canUseWebPlayback) {
			const durationMs = track.data.durationMs;
			const clipMs = PREMIUM_CLIP_MS;
			const maxStart =
				typeof durationMs === "number"
					? Math.max(0, durationMs - clipMs - 2500)
					: 90_000;
			const approxHook =
				typeof durationMs === "number"
					? Math.floor(durationMs * 0.33)
					: 45_000;
			const positionMs = Math.min(maxStart, Math.max(30_000, approxHook));

			setPlayingId(track.trackId);
			clipTimeoutRef.current = window.setTimeout(() => {
				clipTimeoutRef.current = null;
				setPlayingId(null);
			}, clipMs);
			void webPlaybackRef
				.current!.play({ uri: track.data.uri, clipMs, positionMs })
				.catch(() => stopPlayback());
			return;
		}

		if (!track.data.previewUrl) return;

		const audio =
			preloadedAudioRef.current.get(track.trackId) ??
			new Audio(track.data.previewUrl);
		audio.preload = "auto";
		audioRef.current = audio;
		setPlayingId(track.trackId);
		try {
			audio.currentTime = 0;
		} catch {
			// ignore
		}

		audio.onended = () => {
			if (clipTimeoutRef.current) {
				window.clearTimeout(clipTimeoutRef.current);
				clipTimeoutRef.current = null;
			}
			setPlayingId(null);
		};

		clipTimeoutRef.current = window.setTimeout(() => {
			audio.pause();
			clipTimeoutRef.current = null;
			setPlayingId(null);
		}, CLIP_MS);

		void audio.play().catch(() => {
			stopPlayback();
		});
	}

	if (error) {
		return (
			<div className="mx-auto w-full max-w-3xl px-5 py-10">
				<Card className="p-6">
					<div className="text-xl font-semibold">
						Something went wrong
					</div>
					<div className="mt-2 text-sm text-muted-foreground">
						{error}
					</div>
					<div className="mt-6 flex gap-2">
						<Button variant="secondary" onClick={() => refresh()}>
							Retry
						</Button>
						{needsReauth ? (
							<Button variant="outline" onClick={reconnect}>
								Reconnect Spotify
							</Button>
						) : null}
						<Link to="/t/$id" params={{ id }}>
							<Button variant="ghost">Back to lobby</Button>
						</Link>
					</div>
				</Card>
			</div>
		);
	}

	if (!state || !tournament) {
		return (
			<div className="mx-auto w-full max-w-3xl px-5 py-10">
				<Card className="p-6">
					<div className="text-xl font-semibold">
						Loading bracket…
					</div>
				</Card>
			</div>
		);
	}

	if (!state.bracket) {
		return (
			<div className="mx-auto w-full max-w-3xl px-5 py-10">
				<Card className="p-6">
					<div className="text-2xl font-semibold">
						Bracket not started
					</div>
					<div className="mt-2 text-sm text-muted-foreground">
						Once both users are connected, start the bracket.
					</div>
					<div className="mt-6 flex gap-2">
						<Button onClick={startBracket} disabled={busy}>
							{busy ? "Starting…" : "Start"}
						</Button>
						<Link to="/t/$id" params={{ id }}>
							<Button variant="ghost">Lobby</Button>
						</Link>
					</div>
				</Card>
			</div>
		);
	}

	if (!state.bracket.nextMatch) {
		return (
			<div className="mx-auto w-full max-w-3xl px-5 py-10">
				<Card className="p-6">
					<div className="text-2xl font-semibold">
						Tournament complete
					</div>
					<div className="mt-2 text-sm text-muted-foreground">
						Winner locked in. Want the final ranking?
					</div>
					<div className="mt-6 flex gap-2">
						<Link to="/t/$id/results" params={{ id }}>
							<Button>View Results</Button>
						</Link>
						<Link to="/t/$id" params={{ id }}>
							<Button variant="ghost">Lobby</Button>
						</Link>
					</div>
				</Card>
			</div>
		);
	}

	const a = state.bracket.nextMatch.a;
	type Track = NonNullable<typeof a>;
	const b = state.bracket.nextMatch.b;
	if (!a || !b) {
		return (
			<div className="mx-auto w-full max-w-3xl px-5 py-10">
				<Card className="p-6">
					<div className="text-xl font-semibold">
						Match data missing
					</div>
					<div className="mt-2 text-sm text-muted-foreground">
						Try refreshing.
					</div>
					<div className="mt-6">
						<Button onClick={() => refresh()}>Refresh</Button>
					</div>
				</Card>
			</div>
		);
	}

	const ownerA = labels.get(a.ownerUserId) ?? "Player A";
	const ownerB = labels.get(b.ownerUserId) ?? "Player B";
	const totalMatches = state.bracket.size - 1;
	const completedMatches = Object.keys(state.bracket.winners).length;
	const progress = totalMatches > 0 ? completedMatches / totalMatches : 0;

	return (
		<div className="mx-auto w-full max-w-6xl px-5 py-10">
			<div className="flex items-end justify-between gap-4">
				<div>
					<div className="text-xs font-semibold tracking-[0.22em] text-muted-foreground">
						MATCH
					</div>
					<div className="mt-2 font-display text-4xl font-semibold uppercase tracking-[0.12em] sm:text-5xl">
						Pick a winner
					</div>
					<div className="mt-2 text-sm text-muted-foreground">
						Round {state.bracket.nextMatch.round + 1} · Match{" "}
						{state.bracket.nextMatch.match + 1}
						<span className="hidden md:inline">
							{" "}
							· Hotkeys: Q/W play, 1/2 pick
						</span>
					</div>
				</div>
				<div className="flex gap-2">
					<Link to="/t/$id" params={{ id }}>
						<Button variant="ghost">Lobby</Button>
					</Link>
					<Link to="/t/$id/results" params={{ id }}>
						<Button variant="secondary">Results</Button>
					</Link>
				</div>
			</div>

			<div className="mt-4 flex flex-wrap items-center justify-between gap-3">
				<div className="text-xs font-semibold tracking-[0.22em] text-muted-foreground">
					{ownerA} vs {ownerB}
				</div>
				<div className="flex items-center gap-4">
					<label className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
						<input
							type="checkbox"
							checked={blindMode}
							onChange={(e) => setBlindMode(e.target.checked)}
						/>
						Blind reveal
					</label>
					<label className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
						<input
							type="checkbox"
							checked={hotkeysEnabled}
							onChange={(e) =>
								setHotkeysEnabled(e.target.checked)
							}
						/>
						Hotkeys
					</label>
				</div>
			</div>

			<div className="mt-3 overflow-hidden rounded-full border border-white/10 bg-background/30">
				<div
					className="h-2 rounded-full bg-[hsl(var(--jukebox-amber))]"
					style={{
						width: `${Math.min(100, Math.max(0, progress * 100))}%`,
					}}
				/>
			</div>
			<div className="mt-2 text-xs text-muted-foreground">
				{completedMatches} / {totalMatches} matchups decided
			</div>

			{error ? (
				<div className="mt-6 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
					{error}
				</div>
			) : null}

			{premium && webPlaybackErr ? (
				<div className="mt-6 rounded-md border border-white/10 bg-background/20 p-3 text-sm">
					<div className="font-semibold">
						In-page Spotify player unavailable
					</div>
					<div className="mt-1 text-xs text-muted-foreground">
						Falling back to embed players for tracks without preview
						clips.
					</div>
					{needsReauth ? (
						<div className="mt-3">
							<Button variant="secondary" onClick={reconnect}>
								Reconnect Spotify
							</Button>
						</div>
					) : null}
				</div>
			) : null}

			<div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
				<TrackCard
					track={a as Track}
					ownerLabel={ownerA}
					sideLabel="A"
					active={playingId === a.trackId}
					onPlay={() => togglePlay(a as Track)}
					onPick={() => vote(a.trackId)}
					disabled={busy}
					canUseWebPlayback={canUseWebPlayback}
					authLoading={authLoading}
					premiumEligible={premium}
					blindMode={blindMode}
				/>
				<TrackCard
					track={b as Track}
					ownerLabel={ownerB}
					sideLabel="B"
					active={playingId === b.trackId}
					onPlay={() => togglePlay(b as Track)}
					onPick={() => vote(b.trackId)}
					disabled={busy}
					canUseWebPlayback={canUseWebPlayback}
					authLoading={authLoading}
					premiumEligible={premium}
					blindMode={blindMode}
				/>
			</div>
			{lastRemark ? (
				<div className="mt-4 text-sm text-muted-foreground italic">
					{lastRemark.remark}
					<br />
					<span className="hidden md:inline">
						{" "}
						· Last pick: {lastRemark.winnerName} over{" "}
						{lastRemark.loserName}
						(#{lastRemark.winnerRank} over #{lastRemark.loserRank})
					</span>
				</div>
			) : (
				<div className="mt-4 text-sm text-muted-foreground/70">
					Make your pick. I’m watching.
				</div>
			)}
		</div>
	);
}

function TrackCard(props: {
	track: {
		trackId: string;
		ownerUserId: string;
		rank: number;
		data: {
			name: string;
			artists: Array<{ name: string }>;
			album: { imageUrl: string | null };
			previewUrl: string | null;
			spotifyUrl: string;
			uri: string;
			durationMs: number;
		};
	};
	sideLabel: string;
	ownerLabel: string;
	active: boolean;
	onPlay: () => void;
	onPick: () => void;
	disabled: boolean;
	canUseWebPlayback: boolean;
	authLoading: boolean;
	premiumEligible: boolean;
	blindMode: boolean;
}) {
	const needsIframe =
		!props.authLoading &&
		!props.canUseWebPlayback &&
		!props.track.data.previewUrl;
	const [showIframe, setShowIframe] = useState(
		needsIframe && !props.premiumEligible,
	);
	const iframeDelayRef = useRef<number | null>(null);

	useEffect(() => {
		if (iframeDelayRef.current) {
			window.clearTimeout(iframeDelayRef.current);
			iframeDelayRef.current = null;
		}
		if (!needsIframe) {
			setShowIframe(false);
			return;
		}

		// If the user is premium-eligible, give the Web Playback SDK a moment to
		// warm up before flashing the iframe fallback.
		if (props.premiumEligible) {
			setShowIframe(false);
			iframeDelayRef.current = window.setTimeout(() => {
				iframeDelayRef.current = null;
				setShowIframe(true);
			}, 1400);
			return;
		}
		setShowIframe(true);
	}, [needsIframe, props.track.trackId]);

	const canPreview =
		props.canUseWebPlayback || Boolean(props.track.data.previewUrl);
	const previewLabel = props.authLoading
		? "Checking Spotify session…"
		: props.canUseWebPlayback
			? "Premium hook preview"
			: props.track.data.previewUrl
				? "Quick preview available"
				: props.premiumEligible && needsIframe && !showIframe
					? "Starting premium player…"
					: "Spotify embed fallback";

	return (
		<Card
			className={cn(
				"relative overflow-hidden p-6",
				props.active ? "ring-1 ring-[hsl(var(--jukebox-cyan))]/40" : "",
			)}
		>
			<div className="mb-4 flex items-center justify-between">
				<div className="flex items-center gap-2">
					<span className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-background/40 text-xs font-semibold">
						{props.sideLabel}
					</span>
					<span className="text-xs font-semibold tracking-[0.22em] text-muted-foreground">
						{props.ownerLabel}
					</span>
				</div>
				<span className="text-xs font-semibold text-muted-foreground">
					Seed #{props.track.rank}
				</span>
			</div>
			<div className="flex gap-4">
				<div className="h-24 w-24 shrink-0 overflow-hidden rounded-md border bg-muted">
					{props.track.data.album.imageUrl ? (
						<img
							alt=""
							src={props.track.data.album.imageUrl}
							className="h-full w-full object-cover"
						/>
					) : null}
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex items-center justify-between gap-3">
						<div className="min-w-0">
							<div className="truncate text-xl font-semibold">
								{props.blindMode
									? `Track ${props.sideLabel}`
									: props.track.data.name}
							</div>
							<div className="mt-1 truncate text-sm text-muted-foreground">
								{props.blindMode
									? "Artist hidden"
									: props.track.data.artists
											.map((a) => a.name)
											.join(", ")}
							</div>
							<div className="mt-2 text-xs font-semibold text-muted-foreground">
								{previewLabel}
							</div>
						</div>
					</div>
				</div>
			</div>

			<div className="mt-6 grid grid-cols-2 gap-3">
				{props.authLoading && !props.track.data.previewUrl ? (
					<Button variant="secondary" disabled>
						Loading…
					</Button>
				) : props.premiumEligible && needsIframe && !showIframe ? (
					<Button
						variant="secondary"
						onClick={() => setShowIframe(true)}
						disabled={props.disabled}
					>
						Starting…
					</Button>
				) : canPreview ? (
					<Button
						variant="secondary"
						onClick={props.onPlay}
						disabled={props.disabled}
					>
						{props.active ? "Pause" : "Play"}
					</Button>
				) : (
					<Button
						variant="secondary"
						onClick={() => setShowIframe((v) => !v)}
						disabled={props.disabled}
					>
						{showIframe ? "Hide player" : "Show player"}
					</Button>
				)}
				<Button onClick={props.onPick} disabled={props.disabled}>
					Pick winner
				</Button>
			</div>

			{needsIframe && (!props.premiumEligible || showIframe) ? (
				<div
					className={cn(
						"mt-4 overflow-hidden rounded-2xl border border-white/10 bg-muted/20 transition-all",
						showIframe
							? "opacity-100"
							: props.premiumEligible
								? "h-0 opacity-0"
								: "h-0 opacity-0",
					)}
					aria-hidden={!showIframe}
				>
					<iframe
						src={`https://open.spotify.com/embed/track/${props.track.trackId}?theme=0`}
						width="100%"
						height="80"
						allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
						loading="lazy"
						title="Spotify player"
					/>
				</div>
			) : null}
		</Card>
	);
}
