-- Extends undo snapshots with redo data and a direction flag.
alter table undo_snapshots add column if not exists redo_snapshot jsonb;
alter table undo_snapshots add column if not exists redone_at timestamptz;

create index if not exists undo_snapshots_redo_idx
  on undo_snapshots (farm_id, user_id, undone_at desc, id desc)
  where undone_at is not null and redo_snapshot is not null;
