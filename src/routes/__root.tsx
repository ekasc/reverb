import { useAuth } from "@/components/auth-provider";
import DotPattern from "@/components/magicui/dot-pattern";
import { Button } from "@/components/ui/button";
import { apiJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/router-devtools";

export const Route = createRootRoute({
	component: RootLayout,
});

function RootLayout() {
	const { me, loading, logout } = useAuth();

	async function signin() {
		const resp = (await apiJson("/api/login", {
			method: "POST",
			body: JSON.stringify({ role: "signin", returnTo: "/tournaments" }),
		})) as { message: string };
		window.location.assign(resp.message);
	}

	return (
		<div className="relative min-h-screen">
			<div className="pointer-events-none fixed inset-0 -z-20 bg-[radial-gradient(900px_circle_at_18%_0%,hsl(var(--jukebox-cyan)/0.20),transparent_60%),radial-gradient(900px_circle_at_80%_95%,hsl(var(--jukebox-pink)/0.18),transparent_60%)]" />
			<div className="pointer-events-none fixed inset-0 -z-10 opacity-[0.07] mix-blend-overlay [background-image:repeating-linear-gradient(to_bottom,rgba(255,255,255,0.10)_0px,rgba(255,255,255,0.10)_1px,transparent_6px,transparent_12px)]" />
			<DotPattern
				width={22}
				height={22}
				cx={1}
				cy={1}
				cr={1}
				className={cn(
					"-z-10 opacity-[0.08] [mask-image:radial-gradient(ellipse_at_center,black,transparent_70%)]",
				)}
			/>

			<header className="sticky top-0 z-50 border-b border-white/10 bg-background/40 backdrop-blur-xl">
				<div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 py-4">
					<Link to="/" className="group flex items-baseline gap-3">
						<span className="font-display text-xl font-semibold uppercase tracking-[0.22em]">
							Re:Verb
						</span>
						<span className="hidden text-xs font-semibold tracking-[0.22em] text-muted-foreground md:inline">
							JUKEBOX DUEL
						</span>
					</Link>

					<nav className="hidden items-center gap-5 text-sm font-semibold text-muted-foreground md:flex">
						<Link to="/tournaments" className="hover:text-foreground">
							Tournaments
						</Link>
						{/* <a */}
						{/* 	href="https://developer.spotify.com/documentation/web-api/" */}
						{/* 	target="_blank" */}
						{/* 	rel="noreferrer" */}
						{/* 	className="hover:text-foreground" */}
						{/* > */}
						{/* 	Spotify API */}
						{/* </a> */}
					</nav>

					<div className="flex items-center gap-2">
						<Link to="/new">
							<Button variant="secondary">New duel</Button>
						</Link>

						{loading ? (
							<Button variant="outline" disabled>
								Loading…
							</Button>
						) : me ? (
							<>
								<div className="hidden items-center gap-2 rounded-full border border-white/10 bg-card/40 px-3 py-2 text-sm md:flex">
									{me.imageUrl ? (
										<img
											alt=""
											src={me.imageUrl}
											className="h-7 w-7 rounded-full border border-white/10 object-cover"
										/>
									) : null}
									<div className="max-w-[160px] truncate font-semibold">
										{me.displayName}
									</div>
								</div>
								<Button variant="outline" onClick={() => void logout()}>
									Logout
								</Button>
							</>
						) : (
							<Button onClick={signin}>Sign in</Button>
						)}
					</div>
				</div>
			</header>

			<main className="relative z-10">
				<Outlet />
			</main>
			<TanStackRouterDevtools />
		</div>
	);
}
