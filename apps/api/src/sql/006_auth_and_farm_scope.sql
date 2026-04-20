-- Adds users, farm memberships, and sessions so each account can have its own farm data.
create table if not exists app_users (
  id serial primary key,
  username text not null unique,
  password_hash text not null,
  display_name text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists farm_memberships (
  id serial primary key,
  farm_id integer not null references farms(id) on delete cascade,
  user_id integer not null references app_users(id) on delete cascade,
  role text not null check (role in ('planner', 'worker')),
  created_at timestamptz not null default now(),
  unique (farm_id, user_id)
);

create table if not exists user_sessions (
  id serial primary key,
  user_id integer not null references app_users(id) on delete cascade,
  farm_id integer not null references farms(id) on delete cascade,
  session_token text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table plantings add column if not exists farm_id integer references farms(id) on delete cascade;
update plantings
set farm_id = coalesce(
  (
    select field.farm_id
    from beds bed
    join blocks block on block.id = bed.block_id
    join fields field on field.id = block.field_id
    where bed.id = plantings.intended_bed_id
    limit 1
  ),
  (select id from farms order by id asc limit 1)
)
where farm_id is null;
alter table plantings alter column farm_id set not null;
create index if not exists plantings_farm_id_idx on plantings (farm_id);

alter table tasks add column if not exists farm_id integer references farms(id) on delete cascade;
update tasks
set farm_id = coalesce(
  (select plantings.farm_id from plantings where plantings.id = tasks.planting_id limit 1),
  (
    select field.farm_id
    from beds bed
    join blocks block on block.id = bed.block_id
    join fields field on field.id = block.field_id
    where bed.id = tasks.bed_id
    limit 1
  ),
  (select id from farms order by id asc limit 1)
)
where farm_id is null;
alter table tasks alter column farm_id set not null;
create index if not exists tasks_farm_id_idx on tasks (farm_id);

alter table harvest_records add column if not exists farm_id integer references farms(id) on delete cascade;
update harvest_records
set farm_id = coalesce(
  (select plantings.farm_id from plantings where plantings.id = harvest_records.planting_id limit 1),
  (
    select field.farm_id
    from beds bed
    join blocks block on block.id = bed.block_id
    join fields field on field.id = block.field_id
    where bed.id = harvest_records.bed_id
    limit 1
  ),
  (select id from farms order by id asc limit 1)
)
where farm_id is null;
alter table harvest_records alter column farm_id set not null;
create index if not exists harvest_records_farm_id_idx on harvest_records (farm_id);
