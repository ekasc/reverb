import { z } from "zod";

const nodeEnvSchema = z
	.enum(["development", "test", "production"])
	.default("development");

function parsePort(v: unknown): number {
	const parsed = z.coerce.number().int().safeParse(v);
	if (!parsed.success) return 8080;
	return parsed.data;
}

const rawEnvSchema = z.object({
	NODE_ENV: nodeEnvSchema,
	PORT: z.unknown().optional(),
	APP_ORIGIN: z.string().url().default("http://localhost:5173"),
	DATABASE_URL: z.string().default("./.data/nyx.sqlite"),

	SPOTIFY_CLIENT_ID: z.string().min(1),
	SPOTIFY_CLIENT_SECRET: z.string().min(1),
	SPOTIFY_REDIRECT_URI: z.string().url().optional(),

	SESSION_SECRET: z.string().min(16),
	TOKEN_ENC_KEY: z.string().min(16),
});

const raw = rawEnvSchema.parse({
	NODE_ENV: process.env.NODE_ENV,
	PORT: process.env.PORT,
	APP_ORIGIN: process.env.APP_ORIGIN,
	DATABASE_URL: process.env.DATABASE_URL,

	SPOTIFY_CLIENT_ID: process.env.SPOTIFY_CLIENT_ID,
	SPOTIFY_CLIENT_SECRET: process.env.SPOTIFY_CLIENT_SECRET,
	SPOTIFY_REDIRECT_URI: process.env.SPOTIFY_REDIRECT_URI,

	SESSION_SECRET: process.env.SESSION_SECRET,
	TOKEN_ENC_KEY: process.env.TOKEN_ENC_KEY,
});

export const env = {
	NODE_ENV: raw.NODE_ENV,
	PORT: parsePort(raw.PORT),
	APP_ORIGIN: raw.APP_ORIGIN,
	DATABASE_URL: raw.DATABASE_URL,
	SPOTIFY_CLIENT_ID: raw.SPOTIFY_CLIENT_ID,
	SPOTIFY_CLIENT_SECRET: raw.SPOTIFY_CLIENT_SECRET,
	SPOTIFY_REDIRECT_URI:
		raw.SPOTIFY_REDIRECT_URI ??
		`http://localhost:${parsePort(raw.PORT)}/api/auth/callback`,
	SESSION_SECRET: raw.SESSION_SECRET,
	TOKEN_ENC_KEY: raw.TOKEN_ENC_KEY,
} as const;
