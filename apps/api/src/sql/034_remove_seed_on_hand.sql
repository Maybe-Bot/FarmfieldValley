-- Seed records stay usable even when no inventory quantity is tracked.
drop index if exists seed_items_farm_on_hand_idx;
alter table seed_items drop column if exists on_hand;
