-- Road presets generate non-plantable path/road geometries in the beds layer.
alter table bed_presets add column if not exists is_road boolean not null default false;

insert into bed_presets (farm_id, name, bed_width_m, path_spacing_m, is_road, notes)
select id, 'Farm road 12 ft', 3.6576, 0, true, 'Default non-plantable farm road: 12 ft wide.'
from farms
on conflict (farm_id, name) do nothing;
