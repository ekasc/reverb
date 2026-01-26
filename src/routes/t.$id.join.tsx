import { Card } from "@/components/ui/card";
import { apiJson } from "@/lib/api";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/t/$id/join")({
	component: JoinTournament,
});

function JoinTournament() {
	const { id } = Route.useParams();
	const [err, setErr] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const data = (await apiJson(`/api/login`, {
					method: "POST",
					body: JSON.stringify({
						role: "challenger",
						tournamentId: id,
					}),
				})) as { message: string };
				if (cancelled) return;
				window.location.assign(data.message);
			} catch (e) {
				if (!cancelled)
					setErr(e instanceof Error ? e.message : String(e));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [id]);

	return (
		<div className="mx-auto w-full max-w-2xl px-5 py-10">
			<Card className="p-6">
				<div className="text-xs font-semibold tracking-[0.22em] text-muted-foreground">
					CHALLENGER
				</div>
				<div className="mt-2 font-display text-3xl font-semibold uppercase tracking-[0.12em]">
					Joining…
				</div>
				<div className="mt-3 text-sm text-muted-foreground">
					Redirecting to Spotify to connect your account.
				</div>
				{err ? (
					<div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
						{err}
					</div>
				) : null}
			</Card>
		</div>
	);
}
