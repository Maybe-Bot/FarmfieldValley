-- Task flows now use one crop-date anchor: the planting's seeding date.
-- Existing non-arrow flow-template anchors are normalized. Generated task rows
-- keep their old anchor labels until their planting is recalculated, because
-- they may still have old scheduled dates.
update task_flow_nodes
set anchor = 'planned_sow'
where anchor not like 'after:%';
