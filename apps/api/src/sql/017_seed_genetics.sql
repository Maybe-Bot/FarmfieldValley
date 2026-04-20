-- Adds the seed/genetics bank used by planting planning and future lot tracking.
create table if not exists seed_items (
  id serial primary key,
  farm_id integer not null references farms(id) on delete cascade,
  crop_id integer references crops(id) on delete set null,
  variety_id integer references varieties(id) on delete set null,
  family text,
  crop_type text not null,
  variety_name text,
  breed_name text,
  supplier text,
  lot_number text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table plantings add column if not exists seed_item_id integer references seed_items(id) on delete set null;

create index if not exists seed_items_farm_id_idx on seed_items (farm_id);
create index if not exists plantings_seed_item_id_idx on plantings (seed_item_id);
