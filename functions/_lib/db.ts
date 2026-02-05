import type { D1Database } from "@cloudflare/workers-types";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "../../db/schema";

let bootstrapPromise: Promise<void> | null = null;
let cachedDb: Db | null = null;

function splitSqlStatements(sql: string) {
	return sql
		.split(";")
		.map((s) => s.trim())
		.filter(Boolean);
}

async function execStatements(db: D1Database, sql: string) {
	// Avoid `db.exec()` here. We've seen production Pages deployments where
	// Cloudflare's internal D1 metadata aggregation throws when `exec()` is
	// used (TypeError reading `duration`). Running statements via
	// `prepare().run()` is slower but stable.
	for (const stmt of splitSqlStatements(sql)) {
		await db.prepare(stmt).run();
	}
}

async function tableColumns(db: D1Database, table: string) {
	const info = await db
		.prepare(`PRAGMA table_info(${table})`)
		.all<{ name: string }>();
	return new Set((info.results ?? []).map((r) => r.name));
}

async function ensureColumn(db: D1Database, table: string, colName: string, ddl: string) {
	const cols = await tableColumns(db, table);
	if (cols.has(colName)) return;
	await db.prepare(ddl).run();
}

export async function ensureSchema(db: D1Database) {
	if (bootstrapPromise) return bootstrapPromise;
	bootstrapPromise = (async () => {
		// Basic schema setup + non-destructive upgrades. This keeps D1 boot
		// friction low while we iterate.
		await execStatements(
			db,
			`
		PRAGMA foreign_keys = ON;

		CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY,
			spotify_id TEXT NOT NULL UNIQUE,
			display_name TEXT NOT NULL,
			image_url TEXT,
			email TEXT,
			country TEXT,
			product TEXT,
			created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
			updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
		);

		CREATE TABLE IF NOT EXISTS oauth_tokens (
			user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			access_token_enc TEXT NOT NULL,
			refresh_token_enc TEXT NOT NULL,
			scope TEXT NOT NULL,
			expires_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
		);

		CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
			expires_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

		CREATE TABLE IF NOT EXISTS oauth_states (
			state TEXT PRIMARY KEY,
			data_json TEXT NOT NULL,
			created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
			expires_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_oauth_states_expires_at ON oauth_states(expires_at);

		CREATE TABLE IF NOT EXISTS tournaments (
			id TEXT PRIMARY KEY,
			host_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
			challenger_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
			source_type TEXT NOT NULL DEFAULT 'top_tracks',
			mesh_mode INTEGER NOT NULL DEFAULT 0,
			mood TEXT,
			host_playlist_id TEXT,
			challenger_playlist_id TEXT,
			time_range TEXT NOT NULL,
			bracket_size INTEGER NOT NULL,
			status TEXT NOT NULL,
			seed INTEGER NOT NULL,
			created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
			updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
		);
		CREATE INDEX IF NOT EXISTS idx_tournaments_host_user_id ON tournaments(host_user_id);
		CREATE INDEX IF NOT EXISTS idx_tournaments_challenger_user_id ON tournaments(challenger_user_id);

		CREATE TABLE IF NOT EXISTS tournament_tracks (
			tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
			track_id TEXT NOT NULL,
			owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			rank INTEGER NOT NULL,
			data_json TEXT NOT NULL,
			created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
			PRIMARY KEY (tournament_id, track_id)
		);
		CREATE INDEX IF NOT EXISTS idx_tournament_tracks_owner_user_id ON tournament_tracks(owner_user_id);

		CREATE TABLE IF NOT EXISTS tournament_bracket_state (
			tournament_id TEXT PRIMARY KEY NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
			tracks_json TEXT NOT NULL,
			winners_json TEXT NOT NULL,
			completed_at INTEGER,
			updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
		);
		`,
		);

		await ensureColumn(
			db,
			"users",
			"email",
			"ALTER TABLE users ADD COLUMN email TEXT",
		);
		await ensureColumn(
			db,
			"users",
			"country",
			"ALTER TABLE users ADD COLUMN country TEXT",
		);
		await ensureColumn(
			db,
			"users",
			"product",
			"ALTER TABLE users ADD COLUMN product TEXT",
		);
		await ensureColumn(
			db,
			"tournaments",
			"source_type",
			"ALTER TABLE tournaments ADD COLUMN source_type TEXT NOT NULL DEFAULT 'top_tracks'",
		);
		await ensureColumn(
			db,
			"tournaments",
			"mesh_mode",
			"ALTER TABLE tournaments ADD COLUMN mesh_mode INTEGER NOT NULL DEFAULT 0",
		);
		await ensureColumn(
			db,
			"tournaments",
			"mood",
			"ALTER TABLE tournaments ADD COLUMN mood TEXT",
		);
		await ensureColumn(
			db,
			"tournaments",
			"host_playlist_id",
			"ALTER TABLE tournaments ADD COLUMN host_playlist_id TEXT",
		);
		await ensureColumn(
			db,
			"tournaments",
			"challenger_playlist_id",
			"ALTER TABLE tournaments ADD COLUMN challenger_playlist_id TEXT",
		);
	})();

	return bootstrapPromise;
}

export async function getDb(db: D1Database) {
	await ensureSchema(db);
	if (!cachedDb) cachedDb = drizzle(db, { schema });
	return cachedDb;
}

export type Db = DrizzleD1Database<typeof schema>;
