-- Password resets and farm-scoped invitations.
create table if not exists password_reset_tokens (
  id bigserial primary key,
  user_id integer not null references app_users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists password_reset_tokens_user_id_idx
  on password_reset_tokens (user_id);

create table if not exists farm_invitations (
  id bigserial primary key,
  farm_id integer not null references farms(id) on delete cascade,
  email text not null,
  display_name text,
  role text not null check (role in ('planner', 'worker')),
  token_hash text not null unique,
  invited_by_user_id integer references app_users(id) on delete set null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists farm_invitations_pending_email_idx
  on farm_invitations (farm_id, lower(email))
  where accepted_at is null;

create index if not exists farm_invitations_token_hash_idx
  on farm_invitations (token_hash)
  where accepted_at is null;

-- Older beta builds allowed one shared test address. Preserve the oldest account
-- and move later duplicate test records to unique, intentionally unusable
-- addresses before enforcing normal email uniqueness.
with duplicate_emails as (
  select
    id,
    row_number() over (partition by lower(email) order by id) as duplicate_number
  from app_users
)
update app_users
set
  email = 'legacy-duplicate-' || app_users.id || '@invalid.local',
  email_verified_at = null,
  updated_at = now()
from duplicate_emails
where duplicate_emails.id = app_users.id
  and duplicate_emails.duplicate_number > 1;

drop index if exists app_users_email_lower_unique_idx;
drop index if exists app_users_email_lower_idx;

create unique index if not exists app_users_email_lower_unique_idx
  on app_users (lower(email));
