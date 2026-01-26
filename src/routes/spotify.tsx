import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/spotify")({
	component: () => <div>Hello /spotify!</div>,
});
