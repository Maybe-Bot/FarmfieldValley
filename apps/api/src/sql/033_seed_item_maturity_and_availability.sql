-- Seed records are a usable catalog; days to maturity can feed planting plans.
alter table seed_items add column if not exists days_to_maturity integer;

alter table seed_items drop constraint if exists seed_items_days_to_maturity_check;
alter table seed_items
  add constraint seed_items_days_to_maturity_check
  check (days_to_maturity is null or days_to_maturity > 0);
