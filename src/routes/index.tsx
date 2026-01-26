import { useAuth } from "@/components/auth-provider";
import { BorderBeam } from "@/components/magicui/border-beam";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
	component: Index,
});

function Index() {
	const { me, loading } = useAuth();

	return (
		<div className="mx-auto w-full max-w-6xl px-5 pb-20 pt-10">
			<div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-2">
				<div>
					<div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-card/40 px-4 py-2 text-xs font-semibold tracking-[0.2em] text-muted-foreground">
						<span className="h-2 w-2 rounded-full bg-[hsl(var(--jukebox-pink))] shadow-[0_0_18px_hsl(var(--jukebox-pink)/0.55)]" />
						<span className="h-2 w-2 rounded-full bg-[hsl(var(--jukebox-cyan))] shadow-[0_0_18px_hsl(var(--jukebox-cyan)/0.55)]" />
						JUKEBOX BRACKET
					</div>

					<h1 className="mt-6 font-display text-5xl font-semibold uppercase leading-[1.05] tracking-[0.12em] sm:text-6xl">
						A duel for your
						<br />
						<span className="text-[hsl(var(--jukebox-amber))]">top tracks</span>
					</h1>

					<p className="mt-5 max-w-xl text-base leading-relaxed text-muted-foreground">
						Connect Spotify, generate a link, and let someone crown the winner
						match-by-match. It feels like picking songs on a glowing jukebox —
						fast, tactile, and weirdly addictive.
					</p>

					<div className="mt-8 flex flex-wrap gap-3">
						<Link to="/new">
							<Button size="lg" disabled={loading}>
								Start a duel
							</Button>
						</Link>
						{me ? (
							<Link to="/tournaments">
								<Button size="lg" variant="secondary">
									Your tournaments
								</Button>
							</Link>
						) : (
							<span className="flex items-center text-sm text-muted-foreground">
								No account needed — Spotify creates one automatically.
							</span>
						)}
					</div>
				</div>

				<div className="relative">
					<div
						className={cn(
							"relative overflow-hidden rounded-[2rem] border border-white/10 bg-card/50 p-7 shadow-[0_30px_80px_-50px_rgba(0,0,0,0.9)] backdrop-blur-xl",
							"before:pointer-events-none before:absolute before:inset-0 before:bg-[radial-gradient(900px_circle_at_20%_0%,hsl(var(--jukebox-cyan)/0.22),transparent_55%)]",
							"after:pointer-events-none after:absolute after:inset-0 after:bg-[radial-gradient(900px_circle_at_80%_100%,hsl(var(--jukebox-pink)/0.22),transparent_55%)]",
						)}
					>
						<div className="relative">
							<div className="flex items-center justify-between gap-3">
								<div>
									<div className="font-display text-xs uppercase tracking-[0.22em] text-muted-foreground">
										Now selecting
									</div>
									<div className="mt-2 text-2xl font-semibold tracking-tight">
										Left vs Right
									</div>
								</div>
								<div className="rounded-full border border-white/10 bg-background/40 px-3 py-2 text-xs font-semibold text-muted-foreground">
									Round 1
								</div>
							</div>

							<div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
								<MiniTrackCard title="Neon Nights" artist="The Comets" />
								<MiniTrackCard title="Chrome Heart" artist="VHS Dream" />
							</div>

							<div className="mt-6 rounded-2xl border border-white/10 bg-background/40 p-4">
								<div className="flex items-center justify-between gap-3">
									<div className="text-xs font-semibold text-muted-foreground">
										Always-on previews
									</div>
									<div className="text-xs font-semibold text-[hsl(var(--jukebox-cyan))]">
										Quick 6s + Spotify player
									</div>
								</div>
								<div className="mt-3 h-10 rounded-xl bg-[repeating-linear-gradient(90deg,rgba(255,255,255,0.06)_0px,rgba(255,255,255,0.06)_1px,transparent_6px,transparent_12px)]" />
							</div>
						</div>
						<BorderBeam size={120} duration={12} />
					</div>
				</div>
			</div>
		</div>
	);
}

function MiniTrackCard(props: { title: string; artist: string }) {
	return (
		<Card className="p-4">
			<div className="text-xs font-semibold tracking-[0.22em] text-muted-foreground">
				PREVIEW
			</div>
			<div className="mt-2 truncate text-lg font-semibold">{props.title}</div>
			<div className="mt-1 truncate text-sm text-muted-foreground">
				{props.artist}
			</div>
			<div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-muted">
				<div className="h-full w-2/3 rounded-full bg-[hsl(var(--jukebox-amber))]" />
			</div>
		</Card>
	);
}

// function LoginWindow() {
// 	const form = useForm<z.infer<typeof formSchema>>({
// 		resolver: zodResolver(formSchema),
// 		defaultValues: {
// 			username: "",
// 			password: "",
// 		},
// 	});
//
// 	async function onSubmit(values: z.infer<typeof formSchema>) {
// 		console.log(JSON.stringify(values));
// 		const resp = await fetch("http://localhost:8080/api/login", {
// 			method: "POST",
// 			headers: {
// 				"Content-Type": "application/json",
// 			},
// 			body: JSON.stringify(values),
// 		});
//
// 		const data = (await resp.json()) as {
// 			message: string;
// 			err: null | undefined;
// 		};
// 		console.log("response: ", data.message);
//
// 		window.open(data.message, "_blank", "noopener,noreferrer");
// 	}
//
// 	return (
// 		<>
// 			<Form {...form}>
// 				<form
// 					onSubmit={form.handleSubmit(onSubmit)}
// 					className="space-y-6 w-[350px] p-4"
// 				>
// 					<FormField
// 						control={form.control}
// 						name="username"
// 						render={({ field }) => (
// 							<FormItem className="">
// 								<FormLabel className="text-4xl">
// 									Username
// 								</FormLabel>
// 								<FormControl>
// 									<Input placeholder="John Doe" {...field} />
// 								</FormControl>
// 								<FormMessage />
// 							</FormItem>
// 						)}
// 					/>
//
// 					<FormField
// 						control={form.control}
// 						name="password"
// 						render={({ field }) => (
// 							<FormItem>
// 								<FormLabel className="text-4xl">
// 									Password
// 								</FormLabel>
// 								<FormControl>
// 									<Input
// 										type="password"
// 										placeholder="12345"
// 										{...field}
// 									/>
// 								</FormControl>
// 								<FormMessage />
// 							</FormItem>
// 						)}
// 					/>
// 					<Button type="submit" className="w-full text-lg">
// 						Submit
// 					</Button>
// 				</form>
// 			</Form>
// 		</>
// 	);
// }
