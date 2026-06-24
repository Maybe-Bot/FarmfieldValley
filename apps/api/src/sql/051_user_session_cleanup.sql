create index if not exists user_sessions_expires_at_idx
  on user_sessions (expires_at);
