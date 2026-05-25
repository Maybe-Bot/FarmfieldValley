-- Optional seed stock count. This is only a stored count for now; seed usage
-- and inventory drawdown can be added later.
alter table seed_items add column if not exists stock_quantity integer;

alter table seed_items drop constraint if exists seed_items_stock_quantity_check;
alter table seed_items
  add constraint seed_items_stock_quantity_check
  check (stock_quantity is null or stock_quantity >= 0);
