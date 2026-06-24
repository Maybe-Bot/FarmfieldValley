-- Keep account email uniqueness consistent on databases created by older builds.
drop index if exists app_users_email_lower_idx;

create unique index if not exists app_users_email_lower_unique_idx
  on app_users (lower(email));
