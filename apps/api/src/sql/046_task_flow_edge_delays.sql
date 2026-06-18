-- Task-flow timing belongs to the connection between two jobs.
alter table task_flow_edges
  add column if not exists delay_days integer not null default 0;

-- Preserve existing linked schedules by moving each target node's delay onto
-- every arrow entering that node. Negative legacy delays become zero because
-- edge delays now represent elapsed days between jobs.
update task_flow_edges edge
set delay_days = greatest(0, least(9999, target.offset_days))
from task_flow_nodes target
where target.id = edge.to_node_id
  and edge.delay_days = 0;

update task_flow_nodes
set offset_days = 0
where offset_days <> 0;

alter table task_flow_edges
  drop constraint if exists task_flow_edges_delay_days_check;

alter table task_flow_edges
  add constraint task_flow_edges_delay_days_check
  check (delay_days between 0 and 9999);
