import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

export function createSqliteDb(dbPath: string) {
	const sqlite = new Database(dbPath);
	sqlite.pragma("journal_mode = WAL");
	sqlite.pragma("foreign_keys = ON");

	const tableColumns = (table: string) => {
		const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{
			name: string;
		}>;
		return new Set(rows.map((r) => r.name));
	};

	const ensureColumn = (table: string, colName: string, ddl: string) => {
		const cols = tableColumns(table);
		if (cols.has(colName)) return;
		sqlite.exec(ddl);
	};

	// Minimal schema bootstrapping for local dev.
	// This keeps the project runnable without forcing a migration setup on day 1.
		sqlite.exec(`
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
	`);

	// Non-destructive schema upgrades for existing local DBs.
	ensureColumn("users", "email", "ALTER TABLE users ADD COLUMN email TEXT");
	ensureColumn(
		"users",
		"country",
		"ALTER TABLE users ADD COLUMN country TEXT",
	);
	ensureColumn(
		"users",
		"product",
		"ALTER TABLE users ADD COLUMN product TEXT",
	);
	ensureColumn(
		"tournaments",
		"source_type",
		"ALTER TABLE tournaments ADD COLUMN source_type TEXT NOT NULL DEFAULT 'top_tracks'",
	);
	ensureColumn(
		"tournaments",
		"mesh_mode",
		"ALTER TABLE tournaments ADD COLUMN mesh_mode INTEGER NOT NULL DEFAULT 0",
	);
	ensureColumn(
		"tournaments",
		"mood",
		"ALTER TABLE tournaments ADD COLUMN mood TEXT",
	);
	ensureColumn(
		"tournaments",
		"host_playlist_id",
		"ALTER TABLE tournaments ADD COLUMN host_playlist_id TEXT",
	);
	ensureColumn(
		"tournaments",
		"challenger_playlist_id",
		"ALTER TABLE tournaments ADD COLUMN challenger_playlist_id TEXT",
	);

	return {
		sqlite,
		db: drizzle(sqlite, { schema }),
	};
}
