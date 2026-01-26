export function MarqueeCard({
	k,
	name,
	url,
	img,
	followers,
	position,
}: {
	k: number;
	name: string;
	url: string;
	img: string;
	followers: string;
	position: number;
}) {
	return (
		<div className="flex flex-col gap-5 border p-5 bg-background hover:ring-ring hover:ring-2  hover:ring-offset-background transition-colors" key={k}>
			<figure className="w-48 h-48">
				<a href={url} target="_blank">
					<img
						src={img}
						className="w-full h-full object-cover  "
					/>
				</a>
			</figure>
			<div>{name}</div>
			<div>{followers}M</div>
			<div>#{position}</div>
		</div>
	);
}
