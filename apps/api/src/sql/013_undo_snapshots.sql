-- Adds undo snapshots for recent session-level recovery of user changes.
create table if not exists undo_snapshots (
  id serial primary key,
  farm_id integer not null references farms(id) on delete cascade,
  user_id integer not null references app_users(id) on delete cascade,
  label text not null,
  snapshot jsonb not null,
  undone_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists undo_snapshots_farm_user_created_idx
  on undo_snapshots (farm_id, user_id, created_at desc, id desc);

create index if not exists undo_snapshots_open_idx
  on undo_snapshots (farm_id, user_id, id desc)
  where undone_at is null;
