-- Adds visual flow-chart nodes and edges for task dependencies.
create table if not exists task_flow_nodes (
  id serial primary key,
  flow_template_id integer not null references task_flow_templates(id) on delete cascade,
  node_key text not null,
  task_type text not null,
  label text not null,
  anchor text not null,
  offset_days integer not null,
  x_pos numeric(8,4) not null default 0.5,
  y_pos numeric(8,4) not null default 0.5,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (flow_template_id, node_key)
);

create table if not exists task_flow_edges (
  id serial primary key,
  flow_template_id integer not null references task_flow_templates(id) on delete cascade,
  from_node_id integer not null references task_flow_nodes(id) on delete cascade,
  to_node_id integer not null references task_flow_nodes(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (flow_template_id, from_node_id, to_node_id),
  check (from_node_id <> to_node_id)
);

alter table tasks add column if not exists task_flow_node_id integer references task_flow_nodes(id) on delete set null;

create unique index if not exists tasks_planting_flow_node_uidx
  on tasks (planting_id, task_flow_node_id)
  where planting_id is not null and task_flow_node_id is not null;
