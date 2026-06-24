-- Usage tracking is opt-in and stores only anonymous, coarse activity.
alter table app_users
  add column if not exists usage_tracking_enabled boolean not null default false;

drop index if exists usage_events_farm_occurred_idx;
drop index if exists usage_events_user_occurred_idx;
drop index if exists usage_events_browser_session_idx;

alter table usage_events
  drop column if exists farm_id,
  drop column if exists user_id,
  drop column if exists anonymous_id,
  drop column if exists browser_session_id,
  drop column if exists path,
  drop column if exists title,
  drop column if exists duration_ms,
  drop column if exists user_agent;

update usage_events set details = '{}'::jsonb;

create index if not exists usage_events_occurred_at_idx
  on usage_events (occurred_at desc);

-- Account IDs exist only in this separate, short-lived abuse-prevention table.
create table if not exists usage_rate_limits (
  user_id integer not null references app_users(id) on delete cascade,
  window_start timestamptz not null,
  event_count integer not null default 1,
  expires_at timestamptz not null,
  primary key (user_id, window_start)
);

create index if not exists usage_rate_limits_expires_at_idx
  on usage_rate_limits (expires_at);

delete from usage_events
where occurred_at < now() - interval '90 days';
