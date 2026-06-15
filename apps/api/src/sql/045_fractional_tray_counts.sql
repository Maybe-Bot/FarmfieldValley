alter table plantings alter column tray_count type numeric using tray_count::numeric;
alter table block_placement_overflows alter column tray_count type numeric using tray_count::numeric;
