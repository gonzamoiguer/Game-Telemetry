# Urbes en Urgencia — playtest telemetry

One Cloudflare Worker that receives telemetry from the Unity client, stores it
in D1 (events) and R2 (screenshots), and serves a small password-protected
viewer for reading playtests. Runs on the Cloudflare free tier.

```
src/            Worker (TypeScript)
  index.ts        router + security headers
  ingest.ts       POST /api/ingest, PUT /api/shot/:session/:seq
  viewer-api.ts   /api/v/* (login required)
  auth.ts         login cookie, throttle, key checks
  db.ts           all SQL
  http.ts         small shared helpers
public/         viewer (plain HTML/CSS/ES modules, no build step)
migrations/     D1 schema
scripts/        setup / dev / deploy / seed / smoke (plain Node, Windows-friendly)
test/           vitest tests running in the Workers runtime
```

## First-time setup

Needs Node 20+ and a free Cloudflare account.

```bash
npm install
```

```bash
npx wrangler login
```

```bash
npm run setup
```

`npm run setup` is safe to run again at any time. It:

1. checks that you are logged in (if not, it tells you to run `npx wrangler login`);
2. creates the D1 database `urbes-telemetry` and writes its id into `wrangler.jsonc`;
3. creates the R2 bucket `urbes-telemetry-shots` (if R2 is not enabled yet it prints
   what to click in the dashboard: R2 needs a card on file even on the free plan);
4. applies the D1 migrations;
5. sets the secrets `INGEST_KEY`, `SESSION_SECRET` and `VIEWER_PASSWORD` if they are missing
   (it asks for the password; leave it empty to get a 4-word passphrase). New values are
   printed once and saved to `.secrets.local.txt` (git-ignored);
6. deploys and prints the `https://urbes-telemetry.<you>.workers.dev` URL and the `INGEST_KEY`.

Paste the URL and the `INGEST_KEY` into the Unity client. Then check the whole chain:

```bash
npm run smoke -- https://urbes-telemetry.<you>.workers.dev
```

If you have more than one Cloudflare account, set `CLOUDFLARE_ACCOUNT_ID` first. On a
machine without a browser, set `CLOUDFLARE_API_TOKEN` (a token with Workers Scripts, D1 and
R2 edit rights) instead of running `wrangler login`.

## Everyday commands

| Command | What it does |
|---|---|
| `npm run dev` | Local Worker at http://localhost:8787 with local D1/R2. Creates `.dev.vars` from `.dev.vars.example` the first time (viewer password `dev`). |
| `npm run seed` | Posts a fake playtest (2 players, 3 runs, a 2-day resume, a save reload, a crash, feedback, errors, 8 screenshots) to local dev. `npm run seed -- <url>` sends it somewhere else. Running it twice adds nothing. |
| `npm test` | Tests in the Workers runtime. Run before deploying. |
| `npm run deploy` | Applies new migrations and deploys. Use this for updates. |
| `npm run smoke -- <url>` | End-to-end check of a deployed Worker; cleans up after itself. |
| `npm run typecheck` | TypeScript check. |

## Secrets and environment

| Name | Where | Purpose |
|---|---|---|
| `INGEST_KEY` | Worker secret | Sent by the game as `X-Ingest-Key`. |
| `SESSION_SECRET` | Worker secret | Signs the viewer login cookie. |
| `VIEWER_PASSWORD` | Worker secret | The shared viewer password. |
| `.secrets.local.txt` | your disk, git-ignored | Copy of the values `setup` generated. `smoke` and `seed -- <url>` read it. |
| `.dev.vars` | your disk, git-ignored | Secrets for `npm run dev`. |

`smoke` and `seed` also accept `INGEST_KEY` and `VIEWER_PASSWORD` as environment variables.

### Rotating

- **Viewer password:** `npx wrangler secret put VIEWER_PASSWORD` and type the new one.
  Existing logins stay valid until they expire (30 days); also rotate `SESSION_SECRET` to log everyone out.
- **Log everyone out:** `npx wrangler secret put SESSION_SECRET` and paste a long random string.
- **Ingest key:** `npx wrangler secret put INGEST_KEY`, then update the Unity client.
  Builds with the old key stop sending data (they get 401), so ship a new build first.
- Or delete the line from `.secrets.local.txt`, run `npx wrangler secret delete <NAME>` and
  run `npm run setup` again to generate a new value.

Secrets take effect immediately; no redeploy is needed.

## Wiping test data

- In the viewer: open a player and press **Delete player** (or **Delete run** on a run page).
  This removes the rows and the run's screenshots.
- Through the API (logged-in cookie): `DELETE /api/v/players/:id` or `DELETE /api/v/runs/:id`.
- Everything, from the command line:

  ```bash
  npx wrangler d1 execute urbes-telemetry --remote --command "DELETE FROM players; DELETE FROM login_attempts;"
  ```

  This leaves orphaned screenshots in R2; delete them in the dashboard
  (R2 → `urbes-telemetry-shots`) or just leave them, since they are invisible without the rows.

Local dev data lives in `.wrangler/`; delete that folder to start over.

## Free-tier limits that matter

| Resource | Free limit | What it means here |
|---|---|---|
| Worker requests | 100,000 / day | Each batch, screenshot and viewer request counts. Plenty for playtests. |
| Worker CPU | 10 ms / request | The run page sends event data as raw JSON strings so the Worker does not parse them. |
| D1 storage | 5 GB | Events are small; a session is capped at 20,000 events. |
| D1 rows read | 5 million / day | Opening a run reads its events once; the players list uses indexes. |
| D1 rows written | 100,000 / day | One row per event, roughly 30 events per minute of play. |
| R2 storage | 10 GB / month | Screenshots are ≤ 600 KB; about 12 per hour of play. |
| R2 operations | 1M writes, 10M reads / month | Not a concern at this scale. |

Cloudflare may change these; check https://developers.cloudflare.com/workers/platform/pricing/
and https://developers.cloudflare.com/r2/pricing/.

## API reference

The Unity client already implements this; see the original contract for details.

- `POST /api/ingest`: `X-Ingest-Key`, JSON batch ≤ 1 MB / 500 events. Idempotent on `(session_id, seq)`.
  Returns `{ ok, stored, max_seq }`.
- `PUT /api/shot/:session_id/:seq`: `X-Ingest-Key`, JPEG ≤ 600 KB. 404 if the session is unknown (retry later).
- `POST /api/login` `{ "password": "…" }`, `POST /api/logout`. 5 failed logins per IP per 15 minutes, then 429.
- `GET /api/v/players?env=release,dev`, `GET|PATCH|DELETE /api/v/players/:id`,
  `GET|DELETE /api/v/runs/:id`, `GET /api/v/shot/:session_id/:seq`.

Run events are always ordered by session start, then `seq`, never by `t`: `t` goes
backwards when a player reloads an older save.
