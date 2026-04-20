-- Road presets generate non-plantable path/road geometries in the beds layer.
alter table bed_presets add column if not exists is_road boolean not null default false;

insert into bed_presets (farm_id, name, bed_width_m, path_spacing_m, is_road, notes)
select id, 'Harvest road / path', 3.05, 0, true, 'Non-plantable road/path preset. Adjust width for your farm.'
from farms
on conflict (farm_id, name) do nothing;
