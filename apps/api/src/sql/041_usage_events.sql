-- Stores lightweight product-usage events for understanding page flow and rough friction points.
create table if not exists usage_events (
  id serial primary key,
  farm_id integer references farms(id) on delete cascade,
  user_id integer references app_users(id) on delete set null,
  anonymous_id text,
  browser_session_id text,
  event_type text not null,
  page text not null,
  path text not null,
  title text,
  occurred_at timestamptz not null default now(),
  duration_ms integer,
  details jsonb not null default '{}'::jsonb,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists usage_events_farm_occurred_idx
  on usage_events (farm_id, occurred_at desc);

create index if not exists usage_events_user_occurred_idx
  on usage_events (user_id, occurred_at desc);

create index if not exists usage_events_browser_session_idx
  on usage_events (browser_session_id, occurred_at);
