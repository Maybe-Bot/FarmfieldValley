-- Adds the setting that controls whether a farm map is visible to other users.
alter table farms add column if not exists maps_private boolean not null default false;

create index if not exists farms_maps_private_idx on farms (maps_private);
