import { sql } from "drizzle-orm";
import {
	integer,
	primaryKey,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
	id: text("id").primaryKey(),
	spotifyId: text("spotify_id").notNull().unique(),
	displayName: text("display_name").notNull(),
	imageUrl: text("image_url"),
	email: text("email"),
	country: text("country"),
	product: text("product"),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.notNull()
		.default(sql`(unixepoch() * 1000)`),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" })
		.notNull()
		.default(sql`(unixepoch() * 1000)`),
});

export const oauthTokens = sqliteTable("oauth_tokens", {
	userId: text("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" })
		.primaryKey(),
	accessTokenEnc: text("access_token_enc").notNull(),
	refreshTokenEnc: text("refresh_token_enc").notNull(),
	scope: text("scope").notNull(),
	expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" })
		.notNull()
		.default(sql`(unixepoch() * 1000)`),
});

export const sessions = sqliteTable("sessions", {
	id: text("id").primaryKey(),
	userId: text("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.notNull()
		.default(sql`(unixepoch() * 1000)`),
	expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
});

export const oauthStates = sqliteTable("oauth_states", {
	state: text("state").primaryKey(),
	dataJson: text("data_json").notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.notNull()
		.default(sql`(unixepoch() * 1000)`),
	expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
});

export const tournaments = sqliteTable("tournaments", {
	id: text("id").primaryKey(),
	hostUserId: text("host_user_id").references(() => users.id, {
		onDelete: "set null",
	}),
	challengerUserId: text("challenger_user_id").references(() => users.id, {
		onDelete: "set null",
	}),
	sourceType: text("source_type").notNull(),
	meshMode: integer("mesh_mode").notNull(),
	mood: text("mood"),
	hostPlaylistId: text("host_playlist_id"),
	challengerPlaylistId: text("challenger_playlist_id"),
	timeRange: text("time_range").notNull(),
	bracketSize: integer("bracket_size").notNull(),
	status: text("status").notNull(),
	seed: integer("seed").notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.notNull()
		.default(sql`(unixepoch() * 1000)`),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" })
		.notNull()
		.default(sql`(unixepoch() * 1000)`),
});

export const tournamentTracks = sqliteTable(
	"tournament_tracks",
	{
		tournamentId: text("tournament_id")
			.notNull()
			.references(() => tournaments.id, { onDelete: "cascade" }),
		trackId: text("track_id").notNull(),
		ownerUserId: text("owner_user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		rank: integer("rank").notNull(),
		dataJson: text("data_json").notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.tournamentId, t.trackId] }),
	}),
);

export const tournamentBracketState = sqliteTable("tournament_bracket_state", {
	tournamentId: text("tournament_id")
		.notNull()
		.references(() => tournaments.id, { onDelete: "cascade" })
		.primaryKey(),
	tracksJson: text("tracks_json").notNull(),
	winnersJson: text("winners_json").notNull(),
	completedAt: integer("completed_at", { mode: "timestamp_ms" }),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" })
		.notNull()
		.default(sql`(unixepoch() * 1000)`),
});
