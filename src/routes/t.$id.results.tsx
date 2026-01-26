import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { apiJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
	TournamentSchema,
	TournamentTrackSchema,
	type TournamentTrack,
} from "@shared/api";
import { createFileRoute, Link } from "@tanstack/react-router";
import { toPng } from "html-to-image";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

export const Route = createFileRoute("/t/$id/results")({
	component: Results,
});

type RankedTrack = TournamentTrack;

function Results() {
	const { id } = Route.useParams();
	const [tournament, setTournament] = useState<
		ReturnType<typeof TournamentSchema.parse> | null
	>(null);
	const [ranking, setRanking] = useState<RankedTrack[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [playlistName, setPlaylistName] = useState<string>("");
	const [isPublic, setIsPublic] = useState(false);
	const [playlistUrl, setPlaylistUrl] = useState<string | null>(null);
	const [needsScopes, setNeedsScopes] = useState(false);
	const shareCardRef = useRef<HTMLDivElement | null>(null);
	const [shareBusy, setShareBusy] = useState(false);
	const [shareErr, setShareErr] = useState<string | null>(null);
	const shareUrl = useMemo(() => {
		return `${window.location.origin}/t/${id}/results`;
	}, [id]);

	const labels = useMemo(() => {
		const byId = new Map<string, string>();
		if (tournament?.host) byId.set(tournament.host.id, tournament.host.displayName);
		if (tournament?.challenger)
			byId.set(tournament.challenger.id, tournament.challenger.displayName);
		return byId;
	}, [tournament]);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const tResp = await apiJson(
					`/api/tournaments/${id}`,
					{},
					z.object({ tournament: TournamentSchema }),
				);
				if (cancelled) return;
				setTournament(tResp.tournament);
				setError(null);

				if (tResp.tournament.status !== "completed") {
					setRanking([]);
					return;
				}

				const rResp = await apiJson(
					`/api/tournaments/${id}/results`,
					{},
					z.object({ ranking: z.array(TournamentTrackSchema) }),
				);
				if (cancelled) return;
				setRanking(rResp.ranking as RankedTrack[]);
			} catch (e) {
				if (!cancelled) setError(e instanceof Error ? e.message : String(e));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [id]);

	async function connectForPlaylist() {
		const resp = await apiJson(
			`/api/login`,
			{
				method: "POST",
				body: JSON.stringify({ role: "playlist", tournamentId: id }),
			},
			z.object({ message: z.string() }),
		);
		window.location.assign(resp.message);
	}

	async function createPlaylist() {
		setBusy(true);
		setError(null);
		setPlaylistUrl(null);
		setNeedsScopes(false);
		try {
			const resp = await apiJson(
				`/api/tournaments/${id}/playlist`,
				{
					method: "POST",
					body: JSON.stringify({
						public: isPublic,
						name: playlistName.trim() || undefined,
					}),
				},
				z.object({
					playlist: z.object({ id: z.string(), url: z.string().nullable() }),
				}),
			);
			setPlaylistUrl(resp.playlist.url);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			setError(msg);
			if (msg.includes("missing_scopes")) setNeedsScopes(true);
		} finally {
			setBusy(false);
		}
	}

	async function renderSharePng() {
		if (!shareCardRef.current) throw new Error("share_card_missing");
		setShareErr(null);
		const dataUrl = await toPng(shareCardRef.current, {
			cacheBust: true,
			pixelRatio: 2,
			backgroundColor: "#0b0b10",
		});
		const blob = await fetch(dataUrl).then((r) => r.blob());
		return { blob, dataUrl };
	}

	async function downloadShareCard() {
		setShareBusy(true);
		try {
			const { dataUrl } = await renderSharePng();
			const a = document.createElement("a");
			a.href = dataUrl;
			a.download = `reverb-duel-${id}.png`;
			a.click();
		} catch (e) {
			setShareErr(e instanceof Error ? e.message : String(e));
		} finally {
			setShareBusy(false);
		}
	}

	async function shareShareCard() {
		setShareBusy(true);
		try {
			const { blob } = await renderSharePng();
			const file = new File([blob], `reverb-duel-${id}.png`, {
				type: "image/png",
			});
			const canShareFiles =
				typeof navigator !== "undefined" &&
				"canShare" in navigator &&
				navigator.canShare?.({ files: [file] } as any);
			if (navigator.share && canShareFiles) {
				await navigator.share({
					title: "Re:Verb Duel",
					text: "Judge my music taste.",
					url: shareUrl,
					files: [file],
				} as any);
				return;
			}

			await downloadShareCard();
		} catch (e) {
			setShareErr(e instanceof Error ? e.message : String(e));
		} finally {
			setShareBusy(false);
		}
	}

	if (error && !tournament) {
		return (
			<div className="mx-auto w-full max-w-3xl px-5 py-10">
				<Card className="p-6">
					<div className="text-xl font-semibold">Results unavailable</div>
					<div className="mt-2 text-sm text-muted-foreground">{error}</div>
					<div className="mt-6 flex gap-2">
						<Link to="/t/$id/play" params={{ id }}>
							<Button>Go to Play</Button>
						</Link>
						<Link to="/t/$id" params={{ id }}>
							<Button variant="ghost">Lobby</Button>
						</Link>
					</div>
				</Card>
			</div>
		);
	}

	if (!tournament || !ranking) {
		return (
			<div className="mx-auto w-full max-w-3xl px-5 py-10">
				<Card className="p-6">
					<div className="text-xl font-semibold">Loading results…</div>
				</Card>
			</div>
		);
	}

	if (tournament.status !== "completed") {
		return (
			<div className="mx-auto w-full max-w-3xl px-5 py-10">
				<Card className="p-6">
					<div className="text-2xl font-semibold">Results aren’t ready yet</div>
					<div className="mt-2 text-sm text-muted-foreground">
						Finish the bracket to unlock the full ranking.
					</div>
					<div className="mt-6 flex gap-2">
						<Link to="/t/$id/play" params={{ id }}>
							<Button>Back to Play</Button>
						</Link>
						<Link to="/t/$id" params={{ id }}>
							<Button variant="ghost">Lobby</Button>
						</Link>
					</div>
				</Card>
			</div>
		);
	}

	const champion = ranking[0];

	return (
		<div className="mx-auto w-full max-w-6xl px-5 py-10">
			<div className="flex flex-col items-start justify-between gap-4 md:flex-row md:items-end">
				<div>
					<div className="text-xs font-semibold tracking-[0.22em] text-muted-foreground">
						RESULTS
					</div>
					<div className="mt-2 font-display text-4xl font-semibold uppercase tracking-[0.12em] sm:text-5xl">
						Final cut
					</div>
					<div className="mt-2 text-sm text-muted-foreground">
						{tournament.host?.displayName ?? "Host"} vs{" "}
						{tournament.challenger?.displayName ?? "Challenger"}
					</div>
				</div>
				<div className="flex gap-2">
					<Link to="/t/$id/play" params={{ id }}>
						<Button variant="secondary">Play</Button>
					</Link>
					<Link to="/t/$id" params={{ id }}>
						<Button variant="ghost">Lobby</Button>
					</Link>
				</div>
			</div>

			<Card className="mt-6 p-6">
				<div className="flex flex-col items-start justify-between gap-4 md:flex-row md:items-center">
					<div>
						<div className="text-xs font-semibold tracking-[0.22em] text-muted-foreground">
							SHARE
						</div>
						<div className="mt-2 text-sm text-muted-foreground">
							Download a card for X / Instagram / WhatsApp.
						</div>
					</div>
					<div className="flex flex-wrap gap-2">
						<Button
							variant="secondary"
							onClick={() => void shareShareCard()}
							disabled={shareBusy}
						>
							{shareBusy ? "Working…" : "Share"}
						</Button>
						<Button
							variant="outline"
							onClick={() => void downloadShareCard()}
							disabled={shareBusy}
						>
							Download
						</Button>
						<Button
							variant="ghost"
							onClick={() => void navigator.clipboard?.writeText(shareUrl)}
						>
							Copy link
						</Button>
					</div>
				</div>

				{shareErr ? (
					<div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
						{shareErr}
					</div>
				) : null}

				<div className="mt-5 grid grid-cols-1 gap-6 md:grid-cols-2">
					<div
						ref={shareCardRef}
						className="relative aspect-[4/5] w-full overflow-hidden rounded-3xl border border-white/10 bg-[radial-gradient(900px_circle_at_20%_10%,hsl(var(--jukebox-amber)/0.18),transparent_55%),radial-gradient(700px_circle_at_80%_30%,hsl(var(--jukebox-cyan)/0.18),transparent_55%),linear-gradient(180deg,rgba(10,10,18,1),rgba(6,6,12,1))] p-6"
					>
						<div className="pointer-events-none absolute inset-0 opacity-30 [background-image:linear-gradient(rgba(255,255,255,0.06)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.04)_1px,transparent_1px)] [background-size:18px_18px]" />
						{champion?.data.album.imageUrl ? (
							<img
								alt=""
								crossOrigin="anonymous"
								src={champion.data.album.imageUrl}
								className="absolute -right-10 top-10 h-56 w-56 rotate-6 rounded-3xl object-cover opacity-90 shadow-[0_40px_120px_-60px_rgba(0,0,0,0.9)]"
							/>
						) : null}
						<div className="relative">
							<div className="text-xs font-semibold tracking-[0.28em] text-muted-foreground">
								RE:VERB
							</div>
							<div className="mt-3 font-display text-4xl font-semibold uppercase tracking-[0.12em]">
								Final Cut
							</div>
							<div className="mt-2 text-sm text-muted-foreground">
								{tournament.host?.displayName ?? "Host"} vs {tournament.challenger?.displayName ?? "Challenger"}
							</div>

							<div className="mt-7 rounded-3xl border border-white/10 bg-background/30 p-5 backdrop-blur">
								<div className="text-xs font-semibold tracking-[0.22em] text-muted-foreground">
									CHAMPION
								</div>
								<div className="mt-2 text-2xl font-semibold leading-tight">
									{champion?.data.name ?? "—"}
								</div>
								<div className="mt-1 text-sm text-muted-foreground">
									{champion ? champion.data.artists.map((a) => a.name).join(", ") : ""}
								</div>
								<div className="mt-3 text-xs font-semibold tracking-[0.22em] text-muted-foreground">
									JUDGED AT {shareUrl.replace(/^https?:\/\//, "")}
								</div>
							</div>
						</div>
					</div>

					<div className="text-sm text-muted-foreground">
						<div className="text-xs font-semibold tracking-[0.22em] text-muted-foreground">
							TIP
						</div>
						<div className="mt-2">
							On Instagram: download, then add to your Story.
						</div>
						<div className="mt-2">
							On X: share the image + link.
						</div>
					</div>
				</div>
			</Card>

			<div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-5">
				<Card className="p-6 lg:col-span-2">
					<div className="text-xs font-semibold tracking-[0.22em] text-muted-foreground">
						CHAMPION
					</div>
					{champion ? (
						<div className="mt-5">
							<div className="relative overflow-hidden rounded-3xl border border-white/10 bg-muted/20">
								<div className="aspect-square w-full">
									{champion.data.album.imageUrl ? (
										<img
											alt=""
											src={champion.data.album.imageUrl}
											className="h-full w-full object-cover"
										/>
									) : (
										<div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
											No cover
										</div>
									)}
								</div>
								<div className="pointer-events-none absolute inset-0 bg-[radial-gradient(600px_circle_at_30%_0%,hsl(var(--jukebox-amber)/0.22),transparent_60%)]" />
							</div>

							<div className="mt-5">
								<div className="text-2xl font-semibold leading-tight">
									{champion.data.name}
								</div>
								<div className="mt-1 text-sm text-muted-foreground">
									{champion.data.artists.map((a) => a.name).join(", ")}
								</div>
								<div className="mt-2 text-xs font-semibold tracking-[0.22em] text-muted-foreground">
									FROM {labels.get(champion.ownerUserId) ?? "PLAYER"}
								</div>
								<div className="mt-5 flex flex-wrap gap-2">
									<Button
										variant="secondary"
										onClick={() =>
											window.open(
												champion.data.spotifyUrl,
												"_blank",
												"noopener,noreferrer",
											)
									}
									>
										Open on Spotify
									</Button>
								</div>
							</div>
						</div>
					) : (
						<div className="mt-4 text-sm text-muted-foreground">
							No champion yet.
						</div>
					)}
				</Card>

				<Card className="p-6 lg:col-span-3">
					<div className="flex items-end justify-between gap-4">
						<div>
							<div className="text-xs font-semibold tracking-[0.22em] text-muted-foreground">
								FULL ORDER
							</div>
							<div className="mt-2 text-sm text-muted-foreground">
								Scroll to view the full ranking.
							</div>
						</div>
						<div className="text-xs font-semibold tracking-[0.22em] text-muted-foreground">
							{ranking.length} TRACKS
						</div>
					</div>

					<div className="mt-5 max-h-[60vh] overflow-y-auto pr-1">
						<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
							{ranking.map((trk, idx) => (
								<RankRow
									key={trk?.trackId ?? String(idx)}
									idx={idx + 1}
									track={trk}
									label={trk ? labels.get(trk.ownerUserId) ?? "Player" : "—"}
								/>
							))}
						</div>
					</div>
				</Card>
			</div>

			<div className="mt-8">
				<Card className="p-6">
					<div className="text-sm font-semibold tracking-wide text-muted-foreground">
						Playlist
					</div>
					<div className="mt-3 text-sm text-muted-foreground">
						Create a Spotify playlist from this ranking.
					</div>

					<div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-3">
						<input
							className="h-11 rounded-full border border-white/10 bg-background/30 px-4 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
							placeholder="Playlist name (optional)"
							value={playlistName}
							onChange={(e) => setPlaylistName(e.target.value)}
						/>
						<label className="flex h-11 items-center gap-2 rounded-full border border-white/10 bg-background/30 px-4 text-sm">
							<input
								type="checkbox"
								checked={isPublic}
								onChange={(e) => setIsPublic(e.target.checked)}
							/>
							Public
						</label>
						<Button onClick={createPlaylist} disabled={busy}>
							{busy ? "Creating…" : "Create playlist"}
						</Button>
					</div>

					{needsScopes ? (
						<div className="mt-4">
							<Button variant="secondary" onClick={connectForPlaylist}>
								Connect Spotify for playlist
							</Button>
						</div>
					) : null}

					{playlistUrl ? (
						<div className="mt-4 rounded-md border bg-muted/30 p-3 text-sm">
							Playlist created:{" "}
							<a
								href={playlistUrl}
								target="_blank"
								rel="noreferrer"
								className="underline"
							>
								Open in Spotify
							</a>
						</div>
					) : null}

					{error ? (
						<div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
							{error}
						</div>
					) : null}
				</Card>
			</div>
		</div>
	);
}

function RankRow(props: {
	idx: number;
	track: RankedTrack;
	label: string;
}) {
	if (!props.track) {
		return (
			<div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-muted/10 p-3">
				<div className="text-xs font-semibold text-muted-foreground">#{props.idx}</div>
				<div className="text-sm text-muted-foreground">—</div>
			</div>
		);
	}

	return (
		<div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-background/30 p-3">
			<div
				className={cn(
					"flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
					props.idx === 1
						? "border-[hsl(var(--jukebox-amber))]/40 bg-[hsl(var(--jukebox-amber))]/10 text-[hsl(var(--jukebox-amber))]"
						: "border-white/10 text-muted-foreground",
				)}
			>
				{props.idx}
			</div>
			<div className="h-10 w-10 shrink-0 overflow-hidden rounded-xl border border-white/10 bg-muted">
				{props.track.data.album.imageUrl ? (
					<img
						alt=""
						src={props.track.data.album.imageUrl}
						className="h-full w-full object-cover"
					/>
				) : null}
			</div>
			<div className="min-w-0 flex-1">
				<div className="truncate font-semibold">{props.track.data.name}</div>
				<div className="truncate text-xs text-muted-foreground">
					{props.track.data.artists.map((a) => a.name).join(", ")} · {props.label}
				</div>
			</div>
			<Button
				variant="ghost"
				onClick={() =>
					window.open(props.track?.data.spotifyUrl, "_blank", "noopener,noreferrer")
				}
			>
				Open
			</Button>
		</div>
	);
}
