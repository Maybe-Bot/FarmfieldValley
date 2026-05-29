# Third-Party Notices

Loam Ledger uses third-party software, map services, and project-specific image assets. This file is a practical notice checklist for the prototype; review provider terms again before a public or commercial launch.

## Runtime Software

- React and React DOM: MIT License.
- Leaflet: BSD 2-Clause License.
- React-Leaflet and `@react-leaflet/core`: Hippocratic License 2.1. Review this license before commercial launch because it is not a standard permissive open-source license.
- Express, CORS, pg, Zod, Vite, `@vitejs/plugin-react`, tsx, and npm-run-all: MIT License.
- dotenv: BSD 2-Clause License.
- TypeScript: Apache License 2.0.

Dependency license files are installed under `node_modules` after `npm install`.

## Map Data And Imagery

- OpenStreetMap tiles are used for the low-zoom light basemap. The app must show OpenStreetMap attribution and follow the OpenStreetMap tile usage policy.
- Esri World Imagery is used for the aerial basemap. The app must show Esri attribution and current data-source attribution.
- Optional offline imagery caching uses USGS National Map imagery for context tiles and Massachusetts 2023 orthophotos by default for high-zoom detail tiles. Cached imagery should retain source/provider attribution and should not be redistributed without checking the source terms.

The active web map basemap configuration is in `apps/web/src/map-config.ts`. Offline imagery source URLs are configured in `apps/api/src/config.ts` and `apps/api/.env.example`.

## Project Image Assets

- Tractor and vehicle sprite images in `apps/web/public/assets` are project assets derived from local generated/edited source art in `Tractors.png`, `Tractors-outlined.png`, `Trucks.png`, and `Tractors-outlined.xcf`.
- These vehicle images should remain generic. Do not add manufacturer logos, recognizable trade dress, or default color schemes intended to imitate a specific equipment brand.

## Seed And Crop Data

- The built-in starter seed catalog stores crop names, variety names, supplier names, and days-to-maturity style facts. These names should be treated as factual references, not as Loam Ledger branding.
- Do not copy seed catalog descriptions, photos, marketing text, or proprietary tables into the starter catalog unless the source license allows it.
