import { z } from "zod";

export const API_URL =
	(import.meta.env.VITE_API_URL as string | undefined) ??
	"";

export type ApiJsonError = Error & {
	payload?: unknown;
};

export async function apiJson<T>(
	path: string,
	init: RequestInit = {},
	schema?: z.ZodType<T>,
): Promise<T> {
	const headers = new Headers(init.headers);
	const bodyIsFormLike =
		init.body instanceof FormData ||
		init.body instanceof URLSearchParams ||
		init.body instanceof Blob;
	if (
		!headers.has("Content-Type") &&
		init.body !== undefined &&
		!bodyIsFormLike
	) {
		headers.set("Content-Type", "application/json");
	}
	if (!headers.has("Accept")) {
		headers.set("Accept", "application/json");
	}

	const resp = await fetch(`${API_URL}${path}`, {
		...init,
		credentials: "include",
		headers,
	});

	if (!resp.ok) {
		let payload: unknown = null;
		try {
			payload = await resp.json();
		} catch {
			payload = await resp.text();
		}
		const err = new Error(
			`API ${resp.status} ${resp.statusText}: ${JSON.stringify(payload)}`,
		) as ApiJsonError;
		err.payload = payload;
		throw err;
	}

	const json = (await resp.json()) as unknown;
	return schema ? schema.parse(json) : (json as T);
}
