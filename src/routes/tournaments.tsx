import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { apiJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import { TournamentListItemSchema, TournamentStatusSchema } from "@shared/api";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";

export const Route = createFileRoute("/tournaments")({
	component: TournamentsPage,
});

type TournamentListItem = z.infer<typeof TournamentListItemSchema>;

function statusLabel(status: z.infer<typeof TournamentStatusSchema>) {
	switch (status) {
		case "waiting_for_host":
			return "Waiting for host";
		case "waiting_for_challenger":
			return "Waiting for challenger";
		case "ready":
			return "Ready";
		case "in_progress":
			return "In progress";
		case "completed":
			return "Completed";
	}
}

function primaryHref(t: TournamentListItem) {
	if (t.status === "completed") return { to: "/t/$id/results" as const };
	if (t.status === "in_progress") return { to: "/t/$id/play" as const };
	return { to: "/t/$id" as const };
}

function TournamentsPage() {
	const [items, setItems] = useState<TournamentListItem[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [authNeeded, setAuthNeeded] = useState(false);
	const [deletingId, setDeletingId] = useState<string | null>(null);

	const sorted = useMemo(() => {
		if (!items) return null;
		return [...items].sort(
			(a, b) =>
				new Date(b.updatedAt).getTime() -
				new Date(a.updatedAt).getTime(),
		);
	}, [items]);

	const buckets = useMemo(() => {
		if (!sorted) return null;
		const active: TournamentListItem[] = [];
		const completed: TournamentListItem[] = [];
		for (const t of sorted) {
			if (t.status === "completed") completed.push(t);
			else active.push(t);
		}
		return { active, completed };
	}, [sorted]);

	async function load() {
		setError(null);
		setAuthNeeded(false);
		try {
			const resp = await apiJson(
				"/api/me/tournaments",
				{},
				z.object({ tournaments: z.array(TournamentListItemSchema) }),
			);
			setItems(resp.tournaments);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			setError(msg);
			setItems(null);
			if (msg.includes("401")) setAuthNeeded(true);
		}
	}

	useEffect(() => {
		void load();
	}, []);

	async function signin() {
		const resp = await apiJson(
			"/api/login",
			{
				method: "POST",
				body: JSON.stringify({
					role: "signin",
					returnTo: "/tournaments",
				}),
			},
			z.object({ message: z.string() }),
		);
		window.location.assign(resp.message);
	}

	async function deleteTournament(id: string) {
		setDeletingId(id);
		setError(null);
		try {
			await apiJson(
				`/api/tournaments/${id}`,
				{ method: "DELETE" },
				z.any(),
			);
			await load();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setDeletingId(null);
		}
	}

	return (
		<div className="mx-auto w-full max-w-6xl px-5 py-10">
			<div className="flex items-end justify-between gap-4">
				<div>
					<div className="text-xs font-semibold tracking-[0.22em] text-muted-foreground">
						LIBRARY
					</div>
					<div className="mt-2 font-display text-4xl font-semibold uppercase tracking-[0.12em] sm:text-5xl">
						Your tournaments
					</div>
					<div className="mt-2 text-sm text-muted-foreground">
						Resume an unfinished bracket or revisit past results.
					</div>
				</div>

				<div className="flex gap-2">
					<Link to="/new">
						<Button variant="secondary">New duel</Button>
					</Link>
					<Button variant="ghost" onClick={load}>
						Refresh
					</Button>
				</div>
			</div>

			{authNeeded ? (
				<div className="mt-8">
					<Card className="p-6">
						<div className="text-xl font-semibold">
							Sign in required
						</div>
						<div className="mt-2 text-sm text-muted-foreground">
							Connect your Spotify to see and manage your
							tournaments.
						</div>
						<div className="mt-6">
							<Button className="text-lg" onClick={signin}>
								Sign in with Spotify
							</Button>
						</div>
					</Card>
				</div>
			) : null}

			{error && !authNeeded ? (
				<div className="mt-6 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
					{error}
				</div>
			) : null}

			{sorted && sorted.length === 0 ? (
				<div className="mt-8">
					<Card className="p-6">
						<div className="text-xl font-semibold">
							No tournaments yet
						</div>
						<div className="mt-2 text-sm text-muted-foreground">
							Create a duel from the home page.
						</div>
						<div className="mt-6">
							<Link to="/">
								<Button>Go Home</Button>
							</Link>
						</div>
					</Card>
				</div>
			) : null}

			{buckets &&
			(buckets.active.length > 0 || buckets.completed.length > 0) ? (
				<div className="mt-8 grid grid-cols-1 gap-6">
					{buckets.active.length > 0 ? (
						<div>
							<div className="mb-3 text-xs font-semibold tracking-[0.22em] text-muted-foreground">
								IN PROGRESS
							</div>
							<div className="grid grid-cols-1 gap-4">
								{buckets.active.map((t) => {
									const host = t.host?.displayName ?? "Host";
									const challenger =
										t.challenger?.displayName ??
										"Challenger";
									const when = new Date(t.updatedAt);
									const href = primaryHref(t);
									const actionLabel = "Resume";

									return (
										<Card key={t.id} className="p-6">
											<div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
												<div className="min-w-0">
													<div className="truncate text-2xl font-semibold">
														{host} vs {challenger}
													</div>
													<div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
														<span
															className={cn(
																"rounded-full border px-2 py-0.5 text-xs font-semibold",
																"border-white/10 bg-background/30 text-muted-foreground",
															)}
														>
															{statusLabel(
																t.status,
															)}
														</span>
														<span className="text-xs text-muted-foreground">
															Updated{" "}
															{when.toLocaleString()}
														</span>
														<span className="text-xs text-muted-foreground">
															· {t.bracketSize}{" "}
															tracks
														</span>
													</div>
												</div>

												<div className="flex flex-wrap gap-2">
													<Link
														to={href.to}
														params={{ id: t.id }}
													>
														<Button>
															{actionLabel}
														</Button>
													</Link>

													<AlertDialog>
														<AlertDialogTrigger
															asChild
														>
															<Button
																variant="outline"
																disabled={
																	deletingId ===
																	t.id
																}
															>
																Delete
															</Button>
														</AlertDialogTrigger>
														<AlertDialogContent>
															<AlertDialogHeader>
																<AlertDialogTitle>
																	Delete
																	tournament?
																</AlertDialogTitle>
																<AlertDialogDescription>
																	This will
																	permanently
																	remove this
																	tournament
																	and its
																	bracket.
																</AlertDialogDescription>
															</AlertDialogHeader>
															<AlertDialogFooter>
																<AlertDialogCancel>
																	Cancel
																</AlertDialogCancel>
																<AlertDialogAction
																	onClick={() =>
																		deleteTournament(
																			t.id,
																		)
																	}
																>
																	Delete
																</AlertDialogAction>
															</AlertDialogFooter>
														</AlertDialogContent>
													</AlertDialog>
												</div>
											</div>
										</Card>
									);
								})}
							</div>
						</div>
					) : null}

					{buckets.completed.length > 0 ? (
						<div>
							<div className="mb-3 text-xs font-semibold tracking-[0.22em] text-muted-foreground">
								COMPLETED
							</div>
							<div className="grid grid-cols-1 gap-4">
								{buckets.completed.map((t) => {
									const host = t.host?.displayName ?? "Host";
									const challenger =
										t.challenger?.displayName ??
										"Challenger";
									const when = new Date(t.updatedAt);
									return (
										<Card key={t.id} className="p-6">
											<div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
												<div className="min-w-0">
													<div className="truncate text-2xl font-semibold">
														{host} vs {challenger}
													</div>
													<div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
														<span className="rounded-full border border-spotify/40 bg-spotify/10 px-2 py-0.5 text-xs font-semibold text-spotify">
															Completed
														</span>
														<span className="text-xs text-muted-foreground">
															Updated{" "}
															{when.toLocaleString()}
														</span>
														<span className="text-xs text-muted-foreground">
															· {t.bracketSize}{" "}
															tracks
														</span>
													</div>
												</div>

												<div className="flex flex-wrap gap-2">
													<Link
														to="/t/$id/results"
														params={{ id: t.id }}
													>
														<Button>
															View results
														</Button>
													</Link>
													<Link
														to="/t/$id"
														params={{ id: t.id }}
													>
														<Button variant="outline">
															Lobby
														</Button>
													</Link>
												</div>
											</div>
										</Card>
									);
								})}
							</div>
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}
