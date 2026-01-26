# Re:Verb

Two-person bracket tournaments built from Spotify top tracks.

## What It Does

- Host connects Spotify → a tournament is created.
- Share the invite link → challenger connects Spotify.
- Start the bracket → pick winners match-by-match (with preview clips when available).
- View results → optionally generate a Spotify playlist from the final ranking.

Time ranges follow Spotify’s supported values: `short_term`, `medium_term`, `long_term`.

## Local Development

### 1) Create a Spotify App

In the Spotify Developer Dashboard:

- Add Redirect URI (local): `http://localhost:8788/api/auth/callback`
- Add Redirect URI (prod): `https://<your-domain>/api/auth/callback`

### 2) Create a D1 database

```bash
bunx wrangler d1 create reverb
```

Then paste the returned `database_id` into `wrangler.toml`.

### 3) Configure env

Copy `.dev.vars.example` → `.dev.vars` and fill:

- `SPOTIFY_CLIENT_ID`
- `SPOTIFY_CLIENT_SECRET`
- `TOKEN_ENC_KEY`
- `APP_ORIGIN` (should be `http://localhost:8788` locally)

### 4) Run

Install deps:

```bash
bun install
```

Start frontend + API:

```bash
bun run dev:all
```

Open:

- `http://localhost:8788`

## Scripts

- `bun run dev` - Vite frontend
- `bun run dev:cf` - Cloudflare Pages (Functions + D1) local dev
- `bun run dev:all` - Vite + Pages dev proxy
- `bun run dev:api` - legacy Fastify API (SQLite file)
