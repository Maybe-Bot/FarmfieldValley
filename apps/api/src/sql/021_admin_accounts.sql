-- Marks admin users separately from farm planner/worker roles.
alter table app_users
  add column if not exists is_admin boolean not null default false;

create index if not exists app_users_is_admin_idx on app_users (is_admin);
