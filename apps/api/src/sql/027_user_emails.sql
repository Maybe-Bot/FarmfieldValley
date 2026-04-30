-- Store an email address for each login, even before email verification exists.
alter table app_users add column if not exists email text;

update app_users
set email = lower(regexp_replace(username, '[^a-zA-Z0-9]+', '_', 'g')) || '@farmfield-valley.local'
where email is null or btrim(email) = '';

alter table app_users alter column email set not null;

create unique index if not exists app_users_email_lower_idx on app_users (lower(email));
