-- Stores the map/list icon color on task-flow nodes.
alter table task_flow_nodes add column if not exists icon_color text not null default '#d98c2b';
alter table tasks add column if not exists icon_color text not null default '#4f84aa';

update task_flow_nodes
set icon_color = case
  when task_type = 'cultivation' then '#d98c2b'
  when task_type = 'transplant' then '#4f9b58'
  when task_type in ('direct_seed', 'seed_in_tray') then '#7c9f35'
  when task_type in ('bed_making', 'till') then '#8b6f43'
  when task_type = 'fertilizing_spraying' then '#5f8f4f'
  when task_type in ('cleanup', 'cover_crop') then '#6d7f45'
  else '#4f84aa'
end
where icon_color = '#d98c2b';

update tasks
set icon_color = case
  when task_type = 'cultivation' then '#d98c2b'
  when task_type = 'transplant' then '#4f9b58'
  when task_type in ('direct_seed', 'seed_in_tray') then '#7c9f35'
  when task_type in ('bed_making', 'till') then '#8b6f43'
  when task_type = 'fertilizing_spraying' then '#5f8f4f'
  when task_type in ('cleanup', 'cover_crop') then '#6d7f45'
  else '#4f84aa'
end
where icon_color = '#4f84aa';
