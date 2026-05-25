-- Adds ordered block placement planning so map assignments can reflow when a
-- planting count or bed length changes, without rewriting dated actual records.
alter table blocks add column if not exists bed_start_entrance_side text not null default 'start';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'blocks_bed_start_entrance_side_check'
  ) then
    alter table blocks
      add constraint blocks_bed_start_entrance_side_check
      check (bed_start_entrance_side in ('start', 'end'));
  end if;
end $$;

alter table planting_placements add column if not exists start_length_m numeric(10,2) not null default 0;
alter table planting_placements add column if not exists placement_order numeric(12,4);
alter table planting_placements add column if not exists plan_source text not null default 'manual';

create index if not exists planting_placements_block_plan_idx
  on planting_placements (bed_id, placement_order, id)
  where plan_source = 'auto_block_plan';

create table if not exists block_placement_gaps (
  id serial primary key,
  farm_id integer not null references farms(id) on delete cascade,
  block_id integer not null references blocks(id) on delete cascade,
  bed_id integer not null references beds(id) on delete cascade,
  start_length_m numeric(10,2) not null default 0,
  bed_length_used_m numeric(10,2) not null,
  placement_order numeric(12,4) not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists block_placement_gaps_block_idx
  on block_placement_gaps (block_id, placement_order, id);

create table if not exists block_placement_overflows (
  id serial primary key,
  farm_id integer not null references farms(id) on delete cascade,
  block_id integer not null references blocks(id) on delete cascade,
  planting_id integer references plantings(id) on delete cascade,
  entry_type text not null,
  bed_length_used_m numeric(10,2) not null,
  plant_count integer,
  tray_count integer,
  placement_order numeric(12,4) not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (entry_type in ('planting', 'gap'))
);

create index if not exists block_placement_overflows_block_idx
  on block_placement_overflows (block_id, placement_order, id);
