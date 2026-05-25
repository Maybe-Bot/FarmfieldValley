# Farmfield Valley

Local prototype for farm project management and annual crop planning.

## Stack

- Frontend: React + TypeScript + Vite + Leaflet
- Backend: Node + TypeScript + Express
- Database: PostgreSQL + PostGIS

## Quick start

1. Start PostgreSQL with PostGIS:

   ```bash
   docker compose up -d
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Copy the API env file:

   ```bash
   cp apps/api/.env.example apps/api/.env
   ```

   Optional for the web app:

   ```bash
   cp apps/web/.env.example apps/web/.env
   ```

   Local development defaults to `http://localhost:4000` if `VITE_API_BASE_URL`
   is not set.

4. Create schema and sample data:

   ```bash
   npm run db:migrate
   npm run db:seed
   ```

   `npm run db:seed` is for a fresh demo database only. If the database already
   has users, farms, fields, plantings, or work records, the seed script refuses
   to run unless you explicitly confirm a destructive reset.

5. Optional: build a local aerial imagery cache for offline use:

   ```bash
   npm run map:cache
   ```

   This downloads USGS imagery in two tiers:
   - lower zoom context around your saved Fields
   - higher zoom imagery directly on the saved Fields

6. Start the API and web app:

   ```bash
   npm run dev
   ```

7. Open the app at `http://localhost:5173` and log in with one of the seeded demo accounts below.

If you want a brand-new farm instead of the seeded demo farms, use `Create account` on the landing page to create a new farm and its first planner login.

If you need the first global admin account for the admin panel, create it from the terminal instead of the public login page:

```bash
ADMIN_CREATE_PASSWORD="YourPassword123" npm run admin:create -- --email you@example.com --username your_admin_name --display-name "Your Name"
```

The API runs on `http://localhost:4000`.

## Frontend API URL

The web app reads its backend URL from Vite's `VITE_API_BASE_URL`.

For local development, this is optional because [api.ts](/home/name/Documents/Projects/Farmfield Valley/apps/web/src/api.ts) defaults to:

```env
VITE_API_BASE_URL=http://localhost:4000
```

For hosting, set `VITE_API_BASE_URL` in the frontend host's build environment, for example:

```env
VITE_API_BASE_URL=https://your-api.example.com
```

Because this is a Vite variable, it is baked into the frontend at build time. Change it before building/deploying the web app.

## Public Hosting Security Settings

Before putting the API on the public internet, set these in `apps/api/.env` or your host's environment:

```env
NODE_ENV=production
CORS_ALLOWED_ORIGINS=https://your-frontend.example.com
CSRF_SECRET=replace-with-a-long-random-string
SESSION_COOKIE_SECURE=true
SESSION_COOKIE_SAMESITE=Lax
```

Use `SESSION_COOKIE_SAMESITE=None` only if the frontend and API are on different sites and browser cookies are not being sent. If you use `None`, `SESSION_COOKIE_SECURE=true` is required.

The API now rejects browser requests from origins not listed in `CORS_ALLOWED_ORIGINS`, marks cookies `Secure` in production by default, and requires an `X-CSRF-Token` header for logged-in write requests. The web app receives that token from `/api/session` or login/register responses and sends it automatically.

The first admin account is no longer created from the public website. Create it with the one-time terminal command above before exposing the site publicly.

The admin password is read from the `ADMIN_CREATE_PASSWORD` environment variable so it does not need to be passed on the command line.

## User spreadsheet import

The app has a strict crop-plan uploader in the Planning area. It accepts `.xlsx`,
`.ods`, or `.csv` files whose first row exactly matches this header:

```csv
Seed supplier,Crop,Variety,Catalog number,Start date,Plant count,Bed length (ft),Transplant date,Tray count,Cells per tray,Days to harvest,Field spacing in row,Row spacing,Rows per bed,Bed cover (plastic mulch/bare),Field,Block,Bed,Notes
```

Dates must use `YYYY-MM-DD`. Spacing numbers are inches. Leave `Transplant date`,
`Tray count`, and `Cells per tray` blank for direct-seeded crops. `Bed cover
(plastic mulch/bare)` may be blank, `plastic mulch`, `plastic`, or `bare`.
`Field` and `Block` must match existing map names; `Bed` may be blank if the
exact bed is not assigned yet. Uploads add rows to the current crop plan by
default. The upload card has an explicit checkbox for replacing earlier
spreadsheet-imported rows from the same farm when that is intentional.

Rows with missing essentials such as Crop, Start date, Plant count or Bed length,
Field, or Block are still imported. The crop plan shows a red review marker for
major problems and a yellow marker for optional missing details; their notes list
what must be filled in manually.

## Private Spreadsheet Import

The repository does not include the local `demo data` folder because farm
spreadsheets can contain private details. If you have that ignored folder on
your own machine and want to load those spreadsheets into the farm account
`username`, run:

```bash
npm run db:import-demo
```

The importer reads `.xlsx` and `.ods` files in `demo data`, imports only B1-3 and H2-6 plantings/events, and treats shorthand like `B1/2`, `B1-3`, `H45`, and `H4-6` as multiple blocks. It uses the existing Field/Block geometry in that account and does not create replacement Fields or Blocks. Before each import it saves a field/block/zone/bed snapshot in the `demo_import_map_backups` table, then replaces only earlier spreadsheet-imported plantings/events/task-flow data.

## Demo credentials

River Bend Farm:

- planner: `river_owner` / `river123`
- worker: `river_crew` / `river123`

Cedar Meadow Farm:

- planner: `cedar_owner` / `cedar123`
- worker: `cedar_crew` / `cedar123`

Planner accounts can create additional planner or worker logins for their farm from `Settings -> Team accounts`.

## Core prototype behavior

- Plan annual crop plantings and intended bed usage
- Support multiple farm accounts with farm-scoped data access
- Support two permission levels:
  planner accounts can create and adjust plans
  worker accounts can record completed work and harvests
- Record actual work events without overwriting planned dates
- Automatically recalculate future task dates from the most relevant actual milestone
- Create reusable task-flow templates with dependencies, copy an existing flow, and assign a flow to a planting
- Place the farm on aerial imagery and draw/edit field and block polygons with the mouse
- Manage a simple editable farm layout: Fields -> Blocks -> Beds
- Log harvests by bed while keeping them linked to the parent planting

## Project structure

- `apps/api`: Express API, migrations, seed data, and task scheduling logic
- `apps/web`: React app with Leaflet-based layout and workflow screens
- `docker-compose.yml`: local PostgreSQL/PostGIS service
- `package.json`: workspace scripts for dev, build, migrate, and seed

## Notes

- The Farm Map now uses a free-use aerial basemap and stores Field/Block polygon geometry in PostGIS using EPSG:4326.
- Basemap configuration is isolated in `apps/web/src/map-config.ts` so broader global imagery support can be swapped in later.
- The code is intentionally structured so future topo and elevation layers can be added without rewriting the drawing workflow.
- Beds are rectangle-based and can now be generated inside Blocks from reusable bed presets.
- Offline map support uses a local tile cache served by the API from `apps/api/offline-imagery-cache`.

## If you are upgrading an earlier local copy

Run migrations only:

```bash
npm run db:migrate
```

This updates Fields and Blocks to the newer polygon-based map model and adds newer tables without wiping your farm data.

Do **not** run `npm run db:seed` on a database with real or beta-user data. The seed script is destructive: it truncates users, farms, fields, plantings, tasks, events, and related records.

If you intentionally want to wipe everything and reload the demo farms, run:

```bash
FARMFIELD_VALLEY_CONFIRM_DESTRUCTIVE_SEED=yes npm run db:seed
```

## Offline map workflow

1. Save the Fields you want offline coverage for.
2. Run:

   ```bash
   npm run map:cache
   ```

3. Open `Settings` in the app and set `Map source` to `Offline` or leave it on `Auto`.
4. Keep the API and web app running locally with `npm run dev`.

The cache now uses a split strategy:

- context coverage: lower zoom tiles around all saved Fields plus a wider buffer
- detail coverage: higher zoom tiles directly on the saved Fields

Cached tiles are stored under `apps/api/offline-imagery-cache` and are ignored by git.

### Offline cache settings

These can be changed in `apps/api/.env`:

```env
OFFLINE_IMAGERY_DIR=./offline-imagery-cache
OFFLINE_IMAGERY_SOURCE_URL=https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}
OFFLINE_IMAGERY_CONTEXT_SOURCE_URL=https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}
OFFLINE_IMAGERY_DETAIL_SOURCE_URL=https://tiles.arcgis.com/tiles/hGdibHYSPO59RG1h/arcgis/rest/services/orthos2023/MapServer/tile/{z}/{y}/{x}
OFFLINE_IMAGERY_CONTEXT_MIN_ZOOM=14
OFFLINE_IMAGERY_CONTEXT_MAX_ZOOM=16
OFFLINE_IMAGERY_CONTEXT_BUFFER_MILES=2
OFFLINE_IMAGERY_DETAIL_MIN_ZOOM=17
OFFLINE_IMAGERY_DETAIL_MAX_ZOOM=20
OFFLINE_IMAGERY_DETAIL_BUFFER_MILES=0
```

The default cache strategy is:

- zoom `14` to `16` for the wider 2-mile context area
- zoom `17` to `20` for the saved Fields themselves

The map can still zoom further in the browser; Leaflet will scale the cached imagery at deeper zoom levels.

By default the cache uses:

- USGS imagery for the lower-zoom context layer
- Massachusetts 2023 orthophotos for the higher-zoom field-detail layer

If your farm is outside Massachusetts, set `OFFLINE_IMAGERY_DETAIL_SOURCE_URL` to a different imagery service before rebuilding the cache.

If you want a clean rebuild after changing the cache strategy, remove the old cache first:

```bash
rm -rf apps/api/offline-imagery-cache
npm run map:cache
```

## Bed layout generator

Select a Block on the Farm Map to:

- save farm-specific bed presets such as width and path spacing
- pick a straight 2-point line or a curved 3 to 12 point line inside the block
- optionally flip to the other side of that line
- optionally fill the whole block with as many beds as fit
- generate beds using the selected preset, naming pattern, and line-based setback
