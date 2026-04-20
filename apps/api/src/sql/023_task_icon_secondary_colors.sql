-- Adds a second editable task icon color. The tractor sprite uses icon_color
-- as body paint and icon_secondary_color as wheel/roof/accent paint.
alter table task_flow_nodes add column if not exists icon_secondary_color text not null default '#f4c430';
alter table tasks add column if not exists icon_secondary_color text not null default '#f4c430';
