# FarmMan Code Walkthrough

This document explains how the prototype is put together for someone who is new
to the code. It is meant to be read before making changes.

## What The App Does

FarmMan is a local-first prototype for planning vegetable farm work on a map.
The core idea is:

1. Draw the farm layout on aerial imagery.
2. Plan fields, blocks, beds, plantings, cover crops, and tasks.
3. Record what actually happened.
4. Use those actual dates and map records to adjust future work.

The app is still a prototype. Some files are larger than they would be in a
finished production app because the project has favored fast iteration.

## Main Folder Structure

- `apps/web` is the React frontend. This is what the browser loads.
- `apps/api` is the Node/Express backend. It handles database reads and writes.
- `apps/api/src/sql` contains database migrations. These build or update the
  PostgreSQL/PostGIS schema.
- `demo data` contains spreadsheet examples used by the demo import script.
- `docker-compose.yml` starts PostgreSQL/PostGIS locally.

## Data Flow

The browser renders the React app from `apps/web/src/App.tsx`.

When the user saves something, the frontend calls a function in
`apps/web/src/api.ts`. That file sends an HTTP request to the backend.

The backend receives the request in `apps/api/src/server.ts`, validates the
payload, and writes to PostgreSQL through the shared pool in `apps/api/src/db.ts`.

Most map shapes are stored in PostGIS. The frontend usually works with Leaflet
coordinates as `{ lat, lng }`, while PostGIS expects geometry in longitude /
latitude order. The conversion helpers live in `apps/api/src/geometry.ts` and
`apps/web/src/map-utils.ts`.

## Important Concepts

Farm layout:

- A `Farm` owns the user-visible farm data.
- A `Field` is a large drawn polygon.
- A `Block` is a polygon inside a field.
- A `Bed` is a smaller growing area inside a block. Beds can be generated from
  presets and later updated from better field measurements.

Planning:

- A `Planting` is the parent plan for one crop or variety batch.
- A `Placement` says how much of that planting is placed in a specific bed.
- A `HarvestRecord` logs harvested quantity by bed and planting.

Tasks:

- Task flow templates are editable flow charts.
- Flow chart nodes become scheduled tasks for plantings.
- `apps/api/src/scheduler.ts` recalculates auto-generated tasks when planned or
  actual dates change.
- Task icons and colors are stored with the task flow nodes so the same task can
  show consistently in the flow editor, task list, and map.

Field state over time:

- `farm_events` records what happened, when it happened, and where it happened.
- This supports the long-term direction of showing past, current, and planned
  map states with the time slider.

Accounts:

- Normal farm users are stored in `app_users` and linked to farms through
  `farm_memberships`.
- Farm roles are currently `planner` and `worker`.
- Admin users are marked with `app_users.is_admin` and can access the admin
  panel.

Feedback:

- Users can submit a `Suggestion/problem` report.
- Reports are stored in `feedback_reports`.
- Only admins should see the report list.

Undo / redo:

- The prototype stores snapshots before changes.
- Undo and redo are intended for recent user actions, not full long-term audit
  recovery.

## Main Frontend Files

- `apps/web/src/main.tsx` starts React and provides the error boundary.
- `apps/web/src/App.tsx` contains the main screen routing, map interaction,
  forms, settings, admin panel, and many prototype UI cards.
- `apps/web/src/api.ts` centralizes all HTTP calls to the backend.
- `apps/web/src/types.ts` defines the frontend data shapes expected from the API.
- `apps/web/src/map-config.ts` defines basemap tile sources.
- `apps/web/src/map-utils.ts` contains Leaflet and geometry display helpers.
- `apps/web/src/styles.css` contains layout, map, cards, forms, and theme styles.

## Main Backend Files

- `apps/api/src/server.ts` is the main Express API server.
- `apps/api/src/auth.ts` handles passwords, session cookies, and resolving the
  current user/farm.
- `apps/api/src/config.ts` reads environment variables and sets defaults.
- `apps/api/src/db.ts` creates the shared PostgreSQL connection pool.
- `apps/api/src/geometry.ts` converts browser map coordinates to PostGIS text
  geometry.
- `apps/api/src/beds.ts` contains bed-generation geometry helpers.
- `apps/api/src/scheduler.ts` creates and recalculates tasks from task flows.
- `apps/api/src/offline-imagery.ts` contains optional cached tile helpers.

## Scripts

- `npm run db:migrate` runs every SQL file in `apps/api/src/sql` in filename
  order.
- `npm run db:seed` creates sample data. Do not run this against data you care
  about unless you have checked what it will change.
- `npm --workspace apps/api run import:demo` imports the farm-specific demo
  spreadsheet data.
- `npm --workspace apps/api run cache:imagery` downloads optional map tiles for
  offline imagery experiments.

## Where To Start When Changing Things

- Map behavior usually starts in `apps/web/src/App.tsx`.
- API save/load behavior usually starts in `apps/api/src/server.ts`.
- Database structure changes need a new SQL migration in `apps/api/src/sql`.
- New shared frontend types usually go in `apps/web/src/types.ts`.
- Task scheduling changes usually go in `apps/api/src/scheduler.ts`.
- Bed generation changes usually go in `apps/api/src/beds.ts` and the bed tool
  UI in `apps/web/src/App.tsx`.

## Common Safe Checks

Run these after code changes when possible:

```bash
npm --workspace apps/web run build
npx tsc -p apps/api/tsconfig.json --noImplicitAny false
```

The API TypeScript check currently uses `--noImplicitAny false` because the
prototype still has some legacy implicit types. Cleaning those up would be a
good future refactor.
