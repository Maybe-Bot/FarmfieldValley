-- Tracks how exact bed geometry was created or updated, leaving room for future drone/photo correction.
alter table beds add column if not exists geometry_source text not null default 'unknown';
alter table beds add column if not exists geometry_updated_at timestamptz not null default now();
alter table beds add column if not exists geometry_notes text;

update beds
set geometry_source = source
where geometry_source = 'unknown' and source is not null;
