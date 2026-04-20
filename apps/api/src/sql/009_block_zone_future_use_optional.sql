-- Allows a zone to have no future planned use yet.
alter table block_zones
  alter column planned_use drop not null;

update block_zones
set planned_use = null
where planned_use = 'unassigned';

alter table block_zones
  drop constraint if exists block_zones_planned_use_check;

alter table block_zones
  add constraint block_zones_planned_use_check
  check (planned_use is null or planned_use in ('beds', 'cover_crop'));

insert into block_zones (
  block_id,
  cover_crop_name_id,
  name,
  planned_use,
  actual_state,
  notes,
  x,
  y,
  width,
  height,
  geom,
  boundary,
  centroid,
  area_sqm
)
select
  block.id,
  null,
  block.name || ' area',
  null,
  'needs_cleanup',
  null,
  block.x,
  block.y,
  block.width,
  block.height,
  block.geom,
  block.boundary,
  block.centroid,
  block.area_sqm
from blocks block
left join block_zones zone on zone.block_id = block.id
where zone.id is null;
