-- Adds planned and actual cover-crop dates to block zones.
alter table block_zones
  add column if not exists planned_cover_crop_seed_date date,
  add column if not exists planned_cover_crop_terminate_date date,
  add column if not exists actual_cover_crop_seed_date date,
  add column if not exists actual_cover_crop_terminate_date date;

create index if not exists block_zones_cover_crop_seed_date_idx on block_zones (planned_cover_crop_seed_date);
create index if not exists block_zones_cover_crop_actual_date_idx on block_zones (actual_cover_crop_seed_date, actual_cover_crop_terminate_date);
