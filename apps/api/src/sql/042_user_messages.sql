-- Adds an inbox-style message table that can hold admin report replies now
-- and direct user messages later.
create table if not exists user_messages (
  id serial primary key,
  farm_id integer references farms(id) on delete set null,
  sender_user_id integer references app_users(id) on delete set null,
  recipient_user_id integer not null references app_users(id) on delete cascade,
  related_feedback_report_id integer references feedback_reports(id) on delete set null,
  subject text not null,
  body text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists user_messages_recipient_created_idx
  on user_messages (recipient_user_id, created_at desc);

create index if not exists user_messages_recipient_unread_idx
  on user_messages (recipient_user_id, read_at)
  where read_at is null;

create index if not exists user_messages_feedback_report_idx
  on user_messages (related_feedback_report_id, created_at desc)
  where related_feedback_report_id is not null;
