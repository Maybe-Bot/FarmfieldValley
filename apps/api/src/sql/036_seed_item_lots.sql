create table if not exists seed_item_lots (
  id serial primary key,
  seed_item_id integer not null references seed_items(id) on delete cascade,
  lot_number text not null,
  stock_quantity integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (seed_item_id, lot_number),
  check (length(trim(lot_number)) > 0),
  check (stock_quantity is null or stock_quantity >= 0)
);

insert into seed_item_lots (seed_item_id, lot_number, stock_quantity)
select id, trim(lot_number), stock_quantity
from seed_items
where lot_number is not null
  and trim(lot_number) <> ''
on conflict (seed_item_id, lot_number) do update
set stock_quantity = coalesce(seed_item_lots.stock_quantity, excluded.stock_quantity),
    updated_at = now();

create index if not exists seed_item_lots_seed_item_id_idx on seed_item_lots (seed_item_id);
