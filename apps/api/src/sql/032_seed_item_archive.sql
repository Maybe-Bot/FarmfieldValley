-- Allows old seed records to be hidden from planning without losing history.
alter table seed_items add column if not exists archived_at timestamptz;

create index if not exists seed_items_farm_archived_idx on seed_items (farm_id, archived_at);
