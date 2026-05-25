create table if not exists tractor_profiles (
  id serial primary key,
  farm_id integer not null references farms(id) on delete cascade,
  name text not null,
  tractor_model text not null default 'cab',
  icon_color text not null default '#d98c2b',
  icon_secondary_color text not null default '#f4c430',
  created_at timestamptz not null default now(),
  unique (farm_id, name)
);

alter table task_flow_nodes add column if not exists tractor_profile_id integer references tractor_profiles(id) on delete set null;
alter table tasks add column if not exists tractor_profile_id integer references tractor_profiles(id) on delete set null;

insert into tractor_profiles (farm_id, name, tractor_model, icon_color, icon_secondary_color)
select farm.id, profile.name, profile.tractor_model, profile.icon_color, profile.icon_secondary_color
from farms farm
cross join (
  values
    ('Cab tractor', 'cab', '#d98c2b', '#f4c430'),
    ('Canopy tractor', 'canopy', '#d98c2b', '#f4c430'),
    ('Open tractor', 'open', '#d98c2b', '#f4c430')
) as profile(name, tractor_model, icon_color, icon_secondary_color)
on conflict (farm_id, name) do nothing;
