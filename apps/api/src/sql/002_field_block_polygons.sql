-- Adds true PostGIS polygon storage for fields and blocks so the map can save
-- real drawn boundaries instead of only old rectangle-style x/y/width/height data.
alter table fields add column if not exists boundary geometry(Polygon, 4326);
alter table fields add column if not exists centroid geometry(Point, 4326);
alter table fields add column if not exists area_sqm numeric(14,2);

alter table blocks add column if not exists boundary geometry(Polygon, 4326);
alter table blocks add column if not exists centroid geometry(Point, 4326);
alter table blocks add column if not exists area_sqm numeric(14,2);

update fields
set
  boundary = coalesce(boundary, case when geom is not null then ST_Transform(geom, 4326) end),
  centroid = coalesce(centroid, case when geom is not null then ST_Centroid(ST_Transform(geom, 4326)) end),
  area_sqm = coalesce(area_sqm, case when geom is not null then ST_Area(ST_Transform(geom, 4326)::geography) end)
where boundary is null or centroid is null or area_sqm is null;

update blocks
set
  boundary = coalesce(boundary, case when geom is not null then ST_Transform(geom, 4326) end),
  centroid = coalesce(centroid, case when geom is not null then ST_Centroid(ST_Transform(geom, 4326)) end),
  area_sqm = coalesce(area_sqm, case when geom is not null then ST_Area(ST_Transform(geom, 4326)::geography) end)
where boundary is null or centroid is null or area_sqm is null;

create index if not exists fields_boundary_idx on fields using gist (boundary);
create index if not exists blocks_boundary_idx on blocks using gist (boundary);
