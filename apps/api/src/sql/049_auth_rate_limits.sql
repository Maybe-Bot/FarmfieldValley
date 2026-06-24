-- Shared authentication abuse protection for multi-instance deployments.
-- Keys are SHA-256 hashes so raw IP addresses and usernames are not stored.
create table if not exists auth_rate_limits (
  key_hash text primary key,
  window_started_at timestamptz not null,
  attempt_count integer not null,
  expires_at timestamptz not null
);

create index if not exists auth_rate_limits_expires_at_idx
  on auth_rate_limits (expires_at);

create table if not exists auth_login_lockouts (
  key_hash text primary key,
  failure_count integer not null,
  failure_window_expires_at timestamptz not null,
  locked_until timestamptz
);

create index if not exists auth_login_lockouts_expiry_idx
  on auth_login_lockouts (failure_window_expires_at, locked_until);
