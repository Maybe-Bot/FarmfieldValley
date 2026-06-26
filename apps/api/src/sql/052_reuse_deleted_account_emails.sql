-- Deleted accounts are soft-deleted with is_active = false. Allow the same
-- email to be used again after deletion while keeping active accounts unique.
drop index if exists app_users_email_lower_unique_idx;
drop index if exists app_users_email_lower_idx;

create unique index if not exists app_users_active_email_lower_unique_idx
  on app_users (lower(email))
  where is_active = true;
