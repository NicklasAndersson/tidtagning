# Tidtagning (Race timing)

[Svenska](README.md)

Simple web-based timing for small races with a mass start. Marshals scan runners' QR bibs with their phones, spectators follow the race live on a map and leaderboard, and anyone who scans a bib can send a cheer.

Runs entirely on Cloudflare Workers + D1, with no build step and no frontend framework: plain HTML pages in `public/` and a small Hono API in `src/index.ts`. The UI is in Swedish.

Live: <https://lopp.wwn.se>

## Features

- **Offline-first scanner.** Every scan is stored immediately in the phone's IndexedDB with the phone's clock and synced to the server when a connection is available. Camera (BarcodeDetector) or manual number entry.
- **First time wins.** Scanning the same runner at the same station several times yields one time (PRIMARY KEY + `INSERT OR IGNORE`).
- **Unknown bibs.** An unknown QR code is still recorded and shows up in admin as "Okänd #nr" until it is linked to a participant.
- **Marshal cards.** Each marshal gets a QR link (`/scan/<token>`) that opens the scanner locked to the right station.
- **Live front page for TV and mobile.** Map with GPX track and runners, a big clock (countdown before the start, elapsed time after), leaderboard.
- **Map.** The GPX track is drawn together with the stations. Each runner is shown at their last known position: the station's fixed coordinates for an official scan, otherwise the marshal's or guest's GPS.
- **Leaderboard.** Finished runners are sorted by finish time. The rest are sorted by how far along the course they are (station *order*), then by who got there first.
- **Guest reports.** Spectators who scan a bib land on the runner's page, can send a cheer and (optionally) share their position. This never affects official times.
- **Race logo.** An optional logo is shown in the top menu on every page and included in the archive.
- **Archiving.** "Arkivera och nollställ" (archive and reset) saves the results as a standalone HTML page, including the logo, and clears all race data for the next race.

## Pages

| Path | Who | Content |
|---|---|---|
| `/` | Public | Live: map, clock and leaderboard. Made to be shown on a TV |
| `/results` | Public | Full results with all split times, filter by class |
| `/map` | Public | Full-screen map |
| `/l/<bib>` | Public | Runner page: timeline and cheers (the bib's QR code leads here) |
| `/admin` | Organizer | Race, logo, GPX, participants, stations (placed on a map), marshals, start, archive |
| `/admin-scans` | Organizer | All scans with who scanned and coordinates |
| `/print` | Organizer | Print QR codes for bibs and marshal cards |
| `/scanner` | Marshal | The scanner (installable PWA) |
| `/scan/<token>` | Marshal | Marshal card link, redirects to a locked scanner |
| `/archive/<id>` | Organizer | Download an archived race as HTML |

The admin API (`/api/admin/*`) is protected with Basic Auth, using one shared username and password for the organizers. The admin pages themselves are static. The browser asks for credentials the first time they call the API.

## Race-day workflow

1. **Admin → Lopp:** set the race name, upload the course GPX file and (optionally) a logo. The logo appears in the top menu on every page and is included in the archive.
2. **Admin → Stationer:** click the map where each station is and enter a name, type (Checkpoint/Finish) and *order along the course* (1 = first). Without an order the station is added last. Click a station to edit it.
3. **Admin → Deltagare:** enter bib number, name and class.
4. **Admin → Funktionärer:** create one card per marshal and station.
5. **Print QR codes** for bibs and marshal cards.
6. **Mass start:** start now, in X seconds, or at an exact time. The countdown is shown publicly.
7. Show `/` on a TV at the finish.
8. Afterwards: **Arkivera och nollställ**.

## Local development

Requires Node.js 18+.

```sh
npm install
```

Create `.dev.vars` (ignored by git) with the admin credentials:

```
ADMIN_USER=admin
ADMIN_PASS=something-secret
```

Create the local database and start:

```sh
npx wrangler d1 execute tidtagning --local --file=./schema.sql
npm run dev
```

Open <http://localhost:8787>.

The scanner's camera requires HTTPS, or `localhost` on the same machine. To test with a real phone, deploy or use a tunnel.

## Deployment

First time:

```sh
npx wrangler d1 create tidtagning                  # update database_id in wrangler.toml
npm run db:init -- --remote                        # creates the tables
npx wrangler secret put ADMIN_USER
npx wrangler secret put ADMIN_PASS
```

Then:

```sh
npm run deploy
```

The domain (`lopp.wwn.se`) is configured as a custom domain in `wrangler.toml`. One race per instance: to run several races at once, deploy one instance per (sub)domain, each with its own D1 database.

### Schema changes

`schema.sql` describes the whole schema and only creates missing tables (`CREATE TABLE IF NOT EXISTS`). New columns on an existing database must be added by hand, both locally (`--local`) and in production (`--remote`), for example:

```sh
npx wrangler d1 execute tidtagning --remote --command "ALTER TABLE stations ADD COLUMN ordning INTEGER"
npx wrangler d1 execute tidtagning --remote --command "ALTER TABLE race_settings ADD COLUMN logo TEXT"
```

## Architecture

```
public/            static pages (served by Workers Assets)
  index.html       live front page
  app.css          shared styles
  nav.js           shared top menu (data-menu="admin" gives the admin menu)
  livemap.js       shared Leaflet map: GPX, stations, runners
  scanner.html     scanner PWA with IndexedDB queue
  ...
src/index.ts       Hono API on Cloudflare Workers
schema.sql         D1 schema
```

The maps use Leaflet and leaflet-gpx from unpkg and map tiles from OpenStreetMap. No npm dependencies in the frontend.

### Data model (D1)

| Table | Content |
|---|---|
| `participants` | `startnummer` (bib), `namn`, `klass` |
| `stations` | `id` (generated), `namn`, `typ` (`checkpoint`/`mal`), `lat`, `long`, `ordning` |
| `scans` | official passes: `runner_id`, `station_id`, `timestamp`, `scanned_by`, `lat`, `long`. PK (`runner_id`, `station_id`) |
| `gast_rapporter` | cheers and positions from spectators |
| `funktionarer` | `token` → station |
| `race_settings` | one row: race name, start time, GPX track, logo (data URL) |
| `archives` | archived races: results JSON and standalone HTML |

### Public API

| Method | Path | |
|---|---|---|
| `POST` | `/api/scan` | official scan (from the scanner) |
| `POST` | `/api/guest-report` | cheer and position from spectators |
| `GET` | `/api/results` | all participants with times per station |
| `GET` | `/api/stations` | stations ordered along the course |
| `GET` | `/api/live-positions` | last known position per runner |
| `GET` | `/api/gpx` | the course GPX track |
| `GET` | `/api/race-settings` | race name, start time and whether a logo exists |
| `GET` | `/api/logo` | the race logo (image) |
| `GET` | `/api/participant/:id`, `/api/guest-reports/:id` | data for the runner page |

## Known limitations

- `POST /api/scan` is unauthenticated. Anyone who knows the API can register times. Reasonable for a small race, but worth knowing.
- A runner's position on the map is where they were last scanned, not a real-time GPS position.
- The requirements spec (`kravspecifikation_tidtagningsapp.md`, in Swedish) mentions KV cache and R2 storage. For now D1 is enough: the GPX file, logo and archives are stored in the database, and the pages poll for data every 5–10 seconds.
