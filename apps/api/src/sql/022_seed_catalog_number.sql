-- Stores seed catalog/item numbers separately from seed lot numbers.
-- Lot numbers identify a purchased batch; catalog numbers identify the seed product.
alter table seed_items add column if not exists catalog_number text;
