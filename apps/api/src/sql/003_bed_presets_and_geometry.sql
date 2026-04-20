-- Adds reusable bed presets and geometry fields needed by generated map beds.
create table if not exists bed_presets (
  id serial primary key,
  farm_id integer not null references farms(id) on delete cascade,
  name text not null,
  bed_width_m numeric(10,2) not null,
  path_spacing_m numeric(10,2) not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (farm_id, name)
);

alter table beds add column if not exists boundary geometry(Polygon, 4326);
alter table beds add column if not exists centroid geometry(Point, 4326);
alter table beds add column if not exists area_sqm numeric(14,2);
alter table beds add column if not exists source text not null default 'manual';
alter table beds add column if not exists bed_preset_id integer references bed_presets(id) on delete set null;
alter table beds add column if not exists direction text;
alter table beds add column if not exists sequence_no integer;

update beds
set
  boundary = coalesce(boundary, case when geom is not null then ST_Transform(geom, 4326) end),
  centroid = coalesce(centroid, case when geom is not null then ST_Centroid(ST_Transform(geom, 4326)) end),
  area_sqm = coalesce(area_sqm, case when geom is not null then ST_Area(ST_Transform(geom, 4326)::geography) end)
where boundary is null or centroid is null or area_sqm is null;

create index if not exists beds_boundary_idx on beds using gist (boundary);
