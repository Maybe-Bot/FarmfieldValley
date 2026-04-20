-- Adds block zones, cover crop names, and planned-use/current-state tracking inside blocks.
create table if not exists cover_crop_names (
  id serial primary key,
  farm_id integer not null references farms(id) on delete cascade,
  name text not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (farm_id, name)
);

create table if not exists block_zones (
  id serial primary key,
  block_id integer not null references blocks(id) on delete cascade,
  cover_crop_name_id integer references cover_crop_names(id) on delete set null,
  name text not null,
  planned_use text not null check (planned_use in ('beds', 'cover_crop', 'reserve')),
  actual_state text not null check (
    actual_state in (
      'needs_cleanup',
      'needs_amendment',
      'needs_tillage',
      'ready_for_bed_making',
      'beds_made',
      'partially_planted',
      'fully_planted',
      'cover_crop_established',
      'finished'
    )
  ),
  notes text,
  x numeric(10,2) not null,
  y numeric(10,2) not null,
  width numeric(10,2) not null,
  height numeric(10,2) not null,
  geom geometry(Polygon, 3857) not null,
  boundary geometry(Polygon, 4326) not null,
  centroid geometry(Point, 4326),
  area_sqm numeric(14,2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists cover_crop_names_farm_id_idx on cover_crop_names (farm_id);
create index if not exists block_zones_block_id_idx on block_zones (block_id);
create index if not exists block_zones_boundary_idx on block_zones using gist (boundary);

alter table beds add column if not exists zone_id integer references block_zones(id) on delete set null;
create index if not exists beds_zone_id_idx on beds (zone_id);
