-- Normalizes old "reserve" planned-use values to "unassigned" wording.
update block_zones
set planned_use = 'unassigned'
where planned_use = 'reserve';

alter table block_zones
  drop constraint if exists block_zones_planned_use_check;

alter table block_zones
  add constraint block_zones_planned_use_check
  check (planned_use in ('beds', 'cover_crop', 'unassigned'));
