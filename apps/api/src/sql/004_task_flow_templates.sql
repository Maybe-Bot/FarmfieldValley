-- Adds task-flow templates: reusable crop work patterns that can be copied and edited.
create table if not exists task_flow_templates (
  id serial primary key,
  farm_id integer not null references farms(id) on delete cascade,
  crop_id integer references crops(id) on delete set null,
  name text not null,
  notes text,
  is_default boolean not null default false,
  source_task_flow_template_id integer references task_flow_templates(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (farm_id, name)
);

create table if not exists task_flow_steps (
  id serial primary key,
  flow_template_id integer not null references task_flow_templates(id) on delete cascade,
  step_key text not null,
  task_type text not null,
  label text not null,
  anchor text not null,
  offset_days integer not null,
  sort_order integer not null default 0,
  depends_on_step_keys text[] not null default '{}',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (flow_template_id, step_key)
);

alter table plantings add column if not exists task_flow_template_id integer references task_flow_templates(id) on delete set null;

alter table tasks add column if not exists task_flow_step_id integer references task_flow_steps(id) on delete set null;
alter table tasks add column if not exists depends_on_task_ids integer[] not null default '{}';

create unique index if not exists tasks_planting_flow_step_uidx
  on tasks (planting_id, task_flow_step_id)
  where planting_id is not null and task_flow_step_id is not null;
