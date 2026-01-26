import { z } from "zod";

export const SpotifyTimeRangeSchema = z.enum([
	"short_term",
	"medium_term",
	"long_term",
]);
export type SpotifyTimeRange = z.infer<typeof SpotifyTimeRangeSchema>;

export const TournamentStatusSchema = z.enum([
	"waiting_for_host",
	"waiting_for_challenger",
	"ready",
	"in_progress",
	"completed",
]);
export type TournamentStatus = z.infer<typeof TournamentStatusSchema>;

export const TournamentSourceSchema = z.enum([
	"top_tracks",
	"playlist",
	"playlist_vs",
	"mood",
]);
export type TournamentSource = z.infer<typeof TournamentSourceSchema>;

export const PublicUserSchema = z.object({
	id: z.string(),
	spotifyId: z.string(),
	displayName: z.string(),
	imageUrl: z.string().nullable().optional(),
});
export type PublicUser = z.infer<typeof PublicUserSchema>;

export const MeSchema = z.object({
	user: z.object({
		id: z.string(),
		spotifyId: z.string(),
		displayName: z.string(),
		imageUrl: z.string().nullable().optional(),
		email: z.string().nullable().optional(),
		country: z.string().nullable().optional(),
		product: z.string().nullable().optional(),
	}),
});
export type Me = z.infer<typeof MeSchema>;

export const TournamentSchema = z.object({
	id: z.string(),
	status: TournamentStatusSchema,
	sourceType: TournamentSourceSchema,
	mesh: z.boolean(),
	mood: z.string().nullable().optional(),
	hostPlaylistId: z.string().nullable().optional(),
	challengerPlaylistId: z.string().nullable().optional(),
	timeRange: SpotifyTimeRangeSchema,
	bracketSize: z.number().int(),
	seed: z.number().int().optional(),
	host: PublicUserSchema.nullable(),
	challenger: PublicUserSchema.nullable(),
});
export type Tournament = z.infer<typeof TournamentSchema>;

export const TournamentListItemSchema = TournamentSchema.extend({
	createdAt: z.string(),
	updatedAt: z.string(),
});
export type TournamentListItem = z.infer<typeof TournamentListItemSchema>;

export const StoredTrackDataSchema = z.object({
	id: z.string(),
	name: z.string(),
	artists: z.array(z.object({ id: z.string(), name: z.string() })),
	album: z.object({
		id: z.string(),
		name: z.string(),
		imageUrl: z.string().nullable(),
	}),
	previewUrl: z.string().url().nullable(),
	spotifyUrl: z.string().url(),
	uri: z.string(),
	durationMs: z.number().int(),
});
export type StoredTrackData = z.infer<typeof StoredTrackDataSchema>;

export const TournamentTrackSchema = z
	.object({
		trackId: z.string(),
		ownerUserId: z.string(),
		rank: z.number().int(),
		data: StoredTrackDataSchema,
	})
	.nullable();
export type TournamentTrack = z.infer<typeof TournamentTrackSchema>;

export const TournamentStateSchema = z.object({
	tournament: z.object({
		id: z.string(),
		status: TournamentStatusSchema,
		timeRange: SpotifyTimeRangeSchema,
		bracketSize: z.number().int().optional(),
		hostUserId: z.string().nullable().optional(),
		challengerUserId: z.string().nullable().optional(),
	}),
	bracket: z
		.object({
			size: z.number().int(),
			tracks: z.array(z.string()),
			winners: z.record(z.string(), z.string()),
			tracksById: z.record(
				z.string(),
				z.object({
					trackId: z.string(),
					ownerUserId: z.string(),
					rank: z.number().int(),
					data: StoredTrackDataSchema,
				}),
			),
			winnerTrackId: z.string().nullable(),
			nextMatch: z
				.object({
					round: z.number().int(),
					match: z.number().int(),
					a: TournamentTrackSchema,
					b: TournamentTrackSchema,
				})
				.nullable(),
			completedAt: z.string().nullable().optional(),
		})
		.nullable(),
});
export type TournamentState = z.infer<typeof TournamentStateSchema>;
