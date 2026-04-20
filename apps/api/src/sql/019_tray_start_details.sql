-- Adds tray-start planning details for transplant workflows.
alter table plantings add column if not exists tray_location text;
alter table plantings add column if not exists tray_count integer;
