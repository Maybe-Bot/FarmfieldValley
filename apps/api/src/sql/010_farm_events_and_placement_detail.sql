-- Adds dated farm events and more detailed planting placement fields for the map time slider.
create table if not exists farm_events (
  id serial primary key,
  farm_id integer not null references farms(id) on delete cascade,
  event_date date not null,
  event_type text not null,
  title text not null,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  field_id integer references fields(id) on delete set null,
  block_id integer references blocks(id) on delete set null,
  zone_id integer references block_zones(id) on delete set null,
  bed_id integer references beds(id) on delete set null,
  planting_id integer references plantings(id) on delete set null,
  placement_id integer references planting_placements(id) on delete set null,
  task_id integer references tasks(id) on delete set null,
  boundary geometry(Polygon, 4326),
  centroid geometry(Point, 4326),
  area_sqm numeric(14,2),
  created_at timestamptz not null default now()
);

create index if not exists farm_events_farm_date_idx on farm_events (farm_id, event_date desc, id desc);
create index if not exists farm_events_planting_id_idx on farm_events (planting_id);
create index if not exists farm_events_block_id_idx on farm_events (block_id);
create index if not exists farm_events_boundary_idx on farm_events using gist (boundary);

alter table planting_placements add column if not exists placed_on date;
alter table planting_placements add column if not exists location_detail text;
alter table planting_placements add column if not exists boundary geometry(Polygon, 4326);
alter table planting_placements add column if not exists centroid geometry(Point, 4326);
alter table planting_placements add column if not exists area_sqm numeric(14,2);
