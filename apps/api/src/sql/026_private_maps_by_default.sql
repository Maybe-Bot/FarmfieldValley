-- Keep map sharing disabled by default until hosted sharing rules are ready.
alter table farms alter column maps_private set default true;

update farms
set maps_private = true
where maps_private = false;
