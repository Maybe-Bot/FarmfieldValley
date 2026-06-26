-- Release emails held by accounts that were already soft-deleted before
-- admin deletion started rewriting the email value.
update app_users
set
  email = 'deleted-' || id || '-' || email,
  updated_at = now()
where is_active = false
  and email not like ('deleted-' || id || '-%');
