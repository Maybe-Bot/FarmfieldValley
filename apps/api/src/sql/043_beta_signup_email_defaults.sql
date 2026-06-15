-- Keep the shared beta-test email reusable while real email delivery is optional.
-- Older local databases may still have the original all-email unique index.
drop index if exists app_users_email_lower_idx;

create unique index if not exists app_users_email_lower_unique_idx
  on app_users (lower(email))
  where lower(email) <> 'junk@trash.com';
