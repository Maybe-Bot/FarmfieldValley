-- Adds feedback reports so users can submit suggestions/problems from the app.
create table if not exists feedback_reports (
  id serial primary key,
  farm_id integer references farms(id) on delete cascade,
  user_id integer references app_users(id) on delete cascade,
  page text not null,
  comment text,
  context jsonb not null default '{}'::jsonb,
  recent_activity jsonb not null default '[]'::jsonb,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists feedback_reports_farm_created_idx
  on feedback_reports (farm_id, created_at desc);
