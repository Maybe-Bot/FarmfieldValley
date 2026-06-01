-- Keep the built-in sample bed presets aligned with the current default farm setup.
alter table bed_presets add column if not exists is_road boolean not null default false;

update bed_presets
set
  name = 'Bare bed 3 ft',
  bed_width_m = 0.9144,
  path_spacing_m = 0.6096,
  notes = 'Default bare bed: 3 ft plantable bed with 2 ft path.',
  updated_at = now()
where name in ('Standard Veg Bed', 'Cedar Standard Bed', 'Demo 4 ft bed')
  and not exists (
    select 1
    from bed_presets existing
    where existing.farm_id = bed_presets.farm_id
      and existing.name = 'Bare bed 3 ft'
  );

update bed_presets
set
  name = 'Plastic bed 3 ft',
  bed_width_m = 0.9144,
  path_spacing_m = 0.9144,
  notes = 'Default plastic bed: 3 ft bed with 3 ft path.',
  updated_at = now()
where name in ('Narrow Salad Bed', 'Demo narrow bed')
  and not exists (
    select 1
    from bed_presets existing
    where existing.farm_id = bed_presets.farm_id
      and existing.name = 'Plastic bed 3 ft'
  );

update bed_presets
set
  name = 'Farm road 12 ft',
  bed_width_m = 3.6576,
  path_spacing_m = 0,
  is_road = true,
  notes = 'Default non-plantable farm road: 12 ft wide.',
  updated_at = now()
where name = 'Harvest road / path'
  and not exists (
    select 1
    from bed_presets existing
    where existing.farm_id = bed_presets.farm_id
      and existing.name = 'Farm road 12 ft'
  );

insert into bed_presets (farm_id, name, bed_width_m, path_spacing_m, is_road, notes)
select farms.id, preset.name, preset.bed_width_m, preset.path_spacing_m, preset.is_road, preset.notes
from farms
cross join (
  values
    ('Bare bed 3 ft', 0.9144::numeric, 0.6096::numeric, false, 'Default bare bed: 3 ft plantable bed with 2 ft path.'),
    ('Plastic bed 3 ft', 0.9144::numeric, 0.9144::numeric, false, 'Default plastic bed: 3 ft bed with 3 ft path.'),
    ('Farm road 12 ft', 3.6576::numeric, 0::numeric, true, 'Default non-plantable farm road: 12 ft wide.')
) as preset(name, bed_width_m, path_spacing_m, is_road, notes)
on conflict (farm_id, name) do update
set
  bed_width_m = excluded.bed_width_m,
  path_spacing_m = excluded.path_spacing_m,
  is_road = excluded.is_road,
  notes = excluded.notes,
  updated_at = now();
