-- Allow task-flow arrows to use hundredths of a day.
alter table task_flow_edges
  alter column delay_days type numeric(8,2)
  using round(delay_days::numeric, 2);

-- Generated tasks retain the delay from the arrow that determined their date.
alter table tasks
  alter column offset_days type numeric(8,2)
  using round(offset_days::numeric, 2);

alter table task_flow_edges
  drop constraint if exists task_flow_edges_delay_days_check;

alter table task_flow_edges
  add constraint task_flow_edges_delay_days_check
  check (delay_days between 0 and 9999);
