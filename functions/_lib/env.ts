import { z } from "zod";
import type { D1Database } from "@cloudflare/workers-types";

export const EnvSchema = z.object({
	NODE_ENV: z.enum(["development", "production"]).default("production"),
	APP_ORIGIN: z.string().url(),
	SPOTIFY_CLIENT_ID: z.string().min(1),
	SPOTIFY_CLIENT_SECRET: z.string().min(1),
	SPOTIFY_REDIRECT_URI: z.string().url(),
	TOKEN_ENC_KEY: z.string().min(16),
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
