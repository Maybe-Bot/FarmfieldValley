-- Stores the map/list icon color on task-flow nodes.
alter table task_flow_nodes add column if not exists icon_color text not null default '#d98c2b';
alter table tasks add column if not exists icon_color text not null default '#4f84aa';

update task_flow_nodes
set icon_color = case
  when task_type in ('cultivate', 'weed') then '#d98c2b'
  when task_type = 'transplant' then '#4f9b58'
  when task_type in ('direct_seed', 'seed_in_tray') then '#7c9f35'
  when task_type = 'harvest' then '#c6503f'
  when task_type = 'bed_prep' then '#8b6f43'
  else '#4f84aa'
end
where icon_color = '#d98c2b';

update tasks
set icon_color = case
  when task_type in ('cultivate', 'weed') then '#d98c2b'
  when task_type = 'transplant' then '#4f9b58'
  when task_type in ('direct_seed', 'seed_in_tray') then '#7c9f35'
  when task_type = 'harvest' then '#c6503f'
  when task_type = 'bed_prep' then '#8b6f43'
  else '#4f84aa'
end
where icon_color = '#4f84aa';
