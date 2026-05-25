-- Lets tractor task-flow nodes choose which tractor artwork row to use.
alter table task_flow_nodes add column if not exists tractor_model text;
alter table tasks add column if not exists tractor_model text;

update task_flow_nodes
set tractor_model = case
  when task_type = 'bed_prep' then 'cab'
  when task_type = 'cultivate' then 'canopy'
  when task_type in ('weed', 'mow') then 'open'
  else null
end
where tractor_model is null;

update tasks
set tractor_model = case
  when task_type = 'bed_prep' then 'cab'
  when task_type = 'cultivate' then 'canopy'
  when task_type in ('weed', 'mow') then 'open'
  else null
end
where tractor_model is null;
