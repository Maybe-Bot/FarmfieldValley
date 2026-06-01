alter table seed_items add column if not exists usual_spacing text;
alter table seed_items add column if not exists usual_field_spacing_in_row numeric(10,2);
alter table seed_items add column if not exists usual_row_spacing numeric(10,2);
alter table seed_items add column if not exists usual_rows_per_bed integer;

alter table seed_items drop constraint if exists seed_items_usual_field_spacing_check;
alter table seed_items
  add constraint seed_items_usual_field_spacing_check
  check (usual_field_spacing_in_row is null or usual_field_spacing_in_row > 0);

alter table seed_items drop constraint if exists seed_items_usual_row_spacing_check;
alter table seed_items
  add constraint seed_items_usual_row_spacing_check
  check (usual_row_spacing is null or usual_row_spacing > 0);

alter table seed_items drop constraint if exists seed_items_usual_rows_per_bed_check;
alter table seed_items
  add constraint seed_items_usual_rows_per_bed_check
  check (usual_rows_per_bed is null or usual_rows_per_bed > 0);

with latest_spacing as (
  select distinct on (seed_item_id)
    seed_item_id,
    nullif(trim(spacing), '') as spacing,
    field_spacing_in_row,
    row_spacing,
    rows_per_bed
  from plantings
  where seed_item_id is not null
    and (
      nullif(trim(coalesce(spacing, '')), '') is not null
      or field_spacing_in_row is not null
      or row_spacing is not null
      or rows_per_bed is not null
    )
  order by seed_item_id, updated_at desc, id desc
)
update seed_items seed
set
  usual_spacing = coalesce(seed.usual_spacing, latest_spacing.spacing),
  usual_field_spacing_in_row = coalesce(seed.usual_field_spacing_in_row, latest_spacing.field_spacing_in_row),
  usual_row_spacing = coalesce(seed.usual_row_spacing, latest_spacing.row_spacing),
  usual_rows_per_bed = coalesce(seed.usual_rows_per_bed, latest_spacing.rows_per_bed),
  updated_at = now()
from latest_spacing
where seed.id = latest_spacing.seed_item_id;
