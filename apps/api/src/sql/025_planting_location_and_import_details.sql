-- Stores planting-level location and spreadsheet planning details that are not
-- specific to one exact bed.
alter table plantings add column if not exists intended_field_id integer references fields(id) on delete set null;
alter table plantings add column if not exists intended_block_id integer references blocks(id) on delete set null;
alter table plantings add column if not exists days_to_harvest integer;
alter table plantings add column if not exists field_spacing_in_row numeric(10,2);
alter table plantings add column if not exists row_spacing numeric(10,2);
alter table plantings add column if not exists rows_per_bed integer;
alter table plantings add column if not exists cells_per_tray integer;
alter table plantings add column if not exists dead_at_frost boolean;
alter table plantings add column if not exists bed_cover text;

update plantings planting
set intended_block_id = bed.block_id
from beds bed
where planting.intended_bed_id = bed.id
  and planting.intended_block_id is null;

update plantings planting
set intended_field_id = block.field_id
from blocks block
where planting.intended_block_id = block.id
  and planting.intended_field_id is null;
