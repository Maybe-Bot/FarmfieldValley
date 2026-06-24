-- Add verification state and require every account email to be unique.
alter table app_users add column if not exists email_verified_at timestamptz;
alter table app_users add column if not exists email_verification_token_hash text;
alter table app_users add column if not exists email_verification_expires_at timestamptz;

update app_users
set email_verified_at = coalesce(email_verified_at, created_at, now())
where email_verified_at is null
  and email is not null;

drop index if exists app_users_email_lower_idx;

create unique index if not exists app_users_email_lower_unique_idx
  on app_users (lower(email));

create index if not exists app_users_email_verification_token_hash_idx
  on app_users (email_verification_token_hash)
  where email_verification_token_hash is not null;
