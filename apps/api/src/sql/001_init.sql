-- Base schema: enables PostGIS and creates the original farm, field, block,
-- bed, crop, variety, planting, placement, task, and harvest tables.
create extension if not exists postgis;

create table if not exists farms (
  id serial primary key,
  name text not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists fields (
  id serial primary key,
  farm_id integer not null references farms(id) on delete cascade,
  name text not null,
  notes text,
  x numeric(10,2) not null,
  y numeric(10,2) not null,
  width numeric(10,2) not null,
  height numeric(10,2) not null,
  geom geometry(Polygon, 3857) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists blocks (
  id serial primary key,
  field_id integer not null references fields(id) on delete cascade,
  name text not null,
  notes text,
  x numeric(10,2) not null,
  y numeric(10,2) not null,
  width numeric(10,2) not null,
  height numeric(10,2) not null,
  geom geometry(Polygon, 3857) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists beds (
  id serial primary key,
  block_id integer not null references blocks(id) on delete cascade,
  name text not null,
  is_permanent boolean not null default true,
  notes text,
  x numeric(10,2) not null,
  y numeric(10,2) not null,
  width numeric(10,2) not null,
  height numeric(10,2) not null,
  bed_length_m numeric(10,2) not null,
  geom geometry(Polygon, 3857) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists crops (
  id serial primary key,
  name text not null unique
);

create table if not exists varieties (
  id serial primary key,
  crop_id integer not null references crops(id) on delete cascade,
  name text not null,
  unique (crop_id, name)
);

create table if not exists plantings (
  id serial primary key,
  crop_id integer not null references crops(id),
  variety_id integer references varieties(id),
  title text not null,
  status text not null,
  intended_bed_id integer references beds(id),
  spacing text,
  plant_count integer,
  bed_length_used_m numeric(10,2),
  notes text,
  planned_sow_date date,
  planned_transplant_date date,
  expected_harvest_start date,
  expected_harvest_end date,
  actual_tray_seeding_date date,
  actual_direct_seeding_date date,
  actual_transplant_date date,
  actual_cultivation_date date,
  actual_harvest_date date,
  actual_finish_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (plant_count is not null or bed_length_used_m is not null)
);

create table if not exists planting_placements (
  id serial primary key,
  planting_id integer not null references plantings(id) on delete cascade,
  bed_id integer not null references beds(id) on delete cascade,
  plant_count integer,
  bed_length_used_m numeric(10,2),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (plant_count is not null or bed_length_used_m is not null)
);

create table if not exists task_templates (
  id serial primary key,
  applies_to text not null default 'planting',
  task_type text not null,
  label text not null,
  anchor text not null,
  default_offset_days integer not null,
  sort_order integer not null default 0
);

create table if not exists tasks (
  id serial primary key,
  planting_id integer references plantings(id) on delete cascade,
  bed_id integer references beds(id) on delete set null,
  task_template_id integer references task_templates(id) on delete set null,
  task_type text not null,
  title text not null,
  status text not null default 'pending',
  anchor text,
  offset_days integer,
  scheduled_date date,
  completed_date date,
  notes text,
  is_auto_generated boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (planting_id, task_template_id)
);

create table if not exists harvest_records (
  id serial primary key,
  planting_id integer not null references plantings(id) on delete cascade,
  bed_id integer not null references beds(id) on delete cascade,
  harvest_date date not null,
  quantity numeric(10,2) not null,
  unit text not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists fields_geom_idx on fields using gist (geom);
create index if not exists blocks_geom_idx on blocks using gist (geom);
create index if not exists beds_geom_idx on beds using gist (geom);
