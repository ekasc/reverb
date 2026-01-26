type UserProfile = {
	country: string;
	display_name: string;
	email: string;
	explicit_content: {
		filter_enabled: boolean;
		filter_locked: boolean;
	};
	external_urls: { spotify: string };
	followers: { href: string; total: number };
	href: string;
	id: string;
	images: Image[];
	product: string;
	type: string;
	uri: string;
};

interface Image {
	url: string;
	height: number;
	width: number;
}

// Paging represents the paging object in the Spotify API response.
interface Paging<T> {
	href: string; // A link to the Web API endpoint returning the full result of the request
	items: T[]; // The requested data (artists or tracks)
	limit: number; // The maximum number of items in the response (as set in the query or default)
	next: string | null; // URL to the next page of items, or null if none
	offset: number; // The offset of the items returned (as set in the query or default)
	previous: string | null; // URL to the previous page of items, or null if none
	total: number; // The total number of items available to return
}

// ExternalURL represents external URLs associated with a Spotify object.
interface ExternalURL {
	spotify: string;
}

// Artist represents an artist object in the Spotify API.
interface Artist {
	external_urls: ExternalURL;
	followers: {
		total: number;
	};
	genres: string[];
	href: string;
	id: string;
	images: Image[];
	name: string;
	popularity: number;
	type: string;
	uri: string;
}

// Album represents a simplified album object in the Spotify API.
interface Album {
	album_type: string;
	artists: Artist[];
	external_urls: ExternalURL;
	href: string;
	id: string;
	images: Image[];
	name: string;
	release_date: string;
	total_tracks: number;
	type: string;
	uri: string;
}

// Track represents a track object in the Spotify API.
interface Track {
	album: Album;
	artists: Artist[];
	disc_number: number;
	duration_ms: number;
	explicit: boolean;
	href: string;
	id: string;
	name: string;
	popularity: number;
	preview_url: string | null;
	track_number: number;
	type: string;
	uri: string;
}

// GetUsersTopArtistsResponse represents the response for the Get User's Top Artists API.
type GetUsersTopArtistsResponse = {
	items: Artist[];
	href: string;
	limit: number;
	next: string | null;
	offset: number;
	previous: string | null;
	total: number;
};

// GetUsersTopTracksResponse represents the response for the Get User's Top Tracks API.
type GetUsersTopTracksResponse = {
	items: Track[];
	href: string;
	limit: number;
	next: string | null;
	offset: number;
	previous: string | null;
	total: number;
};
