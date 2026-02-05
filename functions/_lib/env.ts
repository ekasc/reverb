import { z } from "zod";
import type { D1Database } from "@cloudflare/workers-types";

function isValidTokenEncKey(key: string) {
	// Must be 32 bytes for AES-256-GCM. Accept either base64-encoded 32 bytes
	// or a raw 32-byte UTF-8 string.
	try {
		const bin = atob(key);
		if (bin.length === 32) return true;
	} catch {
		// ignore
	}

	try {
		return new TextEncoder().encode(key).length === 32;
	} catch {
		return false;
	}
}

export const EnvSchema = z.object({
	NODE_ENV: z.enum(["development", "production"]).default("production"),
	APP_ORIGIN: z.string().url(),
	SPOTIFY_CLIENT_ID: z.string().min(1),
	SPOTIFY_CLIENT_SECRET: z.string().min(1),
	SPOTIFY_REDIRECT_URI: z.string().url(),
	TOKEN_ENC_KEY: z
		.string()
		.refine(isValidTokenEncKey, {
			message:
				"TOKEN_ENC_KEY must be 32 bytes (base64 or raw utf-8) for AES-256-GCM",
		}),
});

export type AppEnv = z.infer<typeof EnvSchema> & {
	DB: D1Database;
};

export function parseEnv(env: unknown): AppEnv {
	const e = env as Record<string, unknown>;
	const vars = EnvSchema.parse(e);
	const db = e.DB as D1Database | undefined;
	if (!db) throw new Error("Missing D1 binding: DB");
	return { ...vars, DB: db };
}
