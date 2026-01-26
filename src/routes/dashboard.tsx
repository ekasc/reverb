import Marquee from "@/components/magicui/marquee";
import { Avatar } from "@/components/ui/avatar";
import { MarqueeCard } from "@/components/ui/MarqueeCard";
import { apiJson } from "@/lib/api";
import { AvatarFallback, AvatarImage } from "@radix-ui/react-avatar";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/dashboard")({
	component: () => Dashboard(),
});

function Dashboard() {
	const [cook, setCook] = useState<UserProfile>();
	const [topArtists, setTopArtists] = useState<GetUsersTopArtistsResponse>();
	const [firstRow, setFirstRow] = useState<Artist[]>();
	const [secondRow, setSecondRow] = useState<Artist[]>();

	useEffect(() => {
		async function fetchData() {
			try {
				const [profileResp, topArtistsResp] = await Promise.all([
					apiJson<{ message: UserProfile }>("/api/profile"),
					apiJson<{ data: GetUsersTopArtistsResponse }>("/api/top-artists", {
						method: "POST",
						body: JSON.stringify({
							type: "artists",
							n: 20,
							time_range: "long_term",
						}),
					}),
				]);

				setCook(profileResp.message);
				if (topArtistsResp.data) {
					// console.log("top artists: ", topArtistsResp);

					setFirstRow(
						topArtistsResp.data.items.slice(
							0,
							topArtistsResp.data.items.length / 2,
						),
					);
					setSecondRow(
						topArtistsResp.data.items.slice(
							topArtistsResp.data.items.length / 2,
						),
					);

					setTopArtists(topArtistsResp.data);
				}
			} catch (error) {
				console.error("Error fetching data:", error);
				window.alert("Session expired");
				window.location.href = "/";
			}
		}
		fetchData();
	}, []);

	return (
		<>
			<div className=" w-full p-4 h-full">
				<div className="flex p-4 border rounded-md flex-col">
					<div className="flex gap-2 items-center">
						<Avatar className=" ">
							<a
								href={cook?.external_urls.spotify}
								target="_blank"
								rel="noreferrer"
							>
								<AvatarImage src={cook?.images[0].url} />
								<AvatarFallback>
									{cook?.display_name}
								</AvatarFallback>
							</a>
						</Avatar>
						<div className="text-6xl font-bold">
							{cook?.display_name}
						</div>
					</div>
					{topArtists?.items ? (
						<div>
							{firstRow ? (
								<div>
									<Marquee
										pauseOnHover
										className="[--duration:40s]"
									>
										{firstRow?.map((v, k) => {
											return (
												<MarqueeCard
													k={k}
													url={
														v.external_urls.spotify
													}
													name={v.name}
													img={v.images[0].url}
													followers={(
														v.followers.total /
														1000000
													).toFixed(2)}
													position={k + 1}
												/>
											);
										})}
									</Marquee>
									<Marquee reverse pauseOnHover>
										{secondRow?.map((v, k) => {
											return (
												<MarqueeCard
													k={k}
													url={
														v.external_urls.spotify
													}
													name={v.name}
													img={v.images[0].url}
													followers={(
														v.followers.total /
														1000000
													).toFixed(2)}
													position={
														firstRow.length + k + 1
													}
												/>
											);
										})}
									</Marquee>
								</div>
							) : null}
						</div>
					) : (
						<div>Fetching...</div>
					)}
				</div>
			</div>
		</>
	);
}
