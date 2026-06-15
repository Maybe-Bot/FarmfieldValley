-- Add current sample task flows to existing farms.
-- This is insert-only for existing names so rerunning migrations does not rewrite
-- a farmer-edited copy of these examples.
insert into task_flow_templates (farm_id, crop_id, name, notes, is_default)
select farms.id, null, sample.name, sample.notes, false
from farms
cross join (
  values
    ('Eight-node transplant flow', 'Compact sample showing field prep leading into transplant and harvest.'),
    ('Full brassica transplant flow', 'Fourteen-node sample with tray seeding, pot-up, field prep, transplanting, cultivation, spray/check passes, and harvest.')
) as sample(name, notes)
on conflict (farm_id, name) do nothing;

with sample_nodes(flow_name, node_key, task_type, label, anchor, offset_days, x_pos, y_pos, icon_color, icon_secondary_color, tractor_model, notes) as (
  values
    ('Eight-node transplant flow', 'seed_tray', 'seed_in_tray', 'Seed trays', 'planned_sow', 0, 0.08, 0.70, '#7c9f35', '#f4c430', null, null),
    ('Eight-node transplant flow', 'disk', 'bed_making', 'Disk ground', 'planned_sow', 7, 0.08, 0.28, '#8b6f43', '#f4c430', 'cab', null),
    ('Eight-node transplant flow', 'lime', 'bed_making', 'Spread lime', 'after:disk', 1, 0.22, 0.28, '#8b6f43', '#f4c430', 'cab', null),
    ('Eight-node transplant flow', 'fertilize', 'bed_making', 'Fertilize', 'after:lime', 10, 0.36, 0.28, '#8b6f43', '#f4c430', 'cab', null),
    ('Eight-node transplant flow', 'perfecta', 'bed_making', 'Perfecta pass', 'after:fertilize', 1, 0.50, 0.28, '#8b6f43', '#f4c430', 'cab', null),
    ('Eight-node transplant flow', 'bed_shape', 'bed_making', 'Bed shape', 'after:perfecta', 1, 0.64, 0.28, '#8b6f43', '#f4c430', 'cab', null),
    ('Eight-node transplant flow', 'transplant', 'transplant', 'Transplant', 'after:seed_tray,bed_shape', 1, 0.64, 0.58, '#4f9b58', '#f4c430', null, null),
    ('Eight-node transplant flow', 'cleanup', 'cleanup', 'Cleanup', 'after:transplant', 35, 0.86, 0.58, '#6d7f45', '#f4c430', null, null),
    ('Full brassica transplant flow', 'seed_tray', 'seed_in_tray', 'Seed trays', 'planned_sow', 0, 0.08, 0.72, '#7c9f35', '#f4c430', null, null),
    ('Full brassica transplant flow', 'pot_up', 'seed_in_tray', 'Pot up', 'after:seed_tray', 21, 0.22, 0.72, '#7c9f35', '#f4c430', null, null),
    ('Full brassica transplant flow', 'disk', 'bed_making', 'Disk ground', 'planned_sow', 14, 0.08, 0.24, '#8b6f43', '#f4c430', 'cab', null),
    ('Full brassica transplant flow', 'lime', 'bed_making', 'Spread lime', 'after:disk', 1, 0.22, 0.24, '#8b6f43', '#f4c430', 'cab', null),
    ('Full brassica transplant flow', 'fertilize', 'bed_making', 'Fertilize', 'after:lime', 14, 0.36, 0.24, '#8b6f43', '#f4c430', 'cab', null),
    ('Full brassica transplant flow', 'perfecta', 'bed_making', 'Perfecta pass', 'after:fertilize', 1, 0.50, 0.24, '#8b6f43', '#f4c430', 'cab', null),
    ('Full brassica transplant flow', 'bed_shape', 'bed_making', 'Bed shape', 'after:perfecta', 1, 0.64, 0.24, '#8b6f43', '#f4c430', 'cab', null),
    ('Full brassica transplant flow', 'transplant', 'transplant', 'Transplant', 'after:pot_up,bed_shape', 1, 0.64, 0.52, '#4f9b58', '#f4c430', null, null),
    ('Full brassica transplant flow', 'water_in', 'fertilizing_spraying', 'Water in', 'after:transplant', 1, 0.78, 0.38, '#4f84aa', '#f4c430', null, null),
    ('Full brassica transplant flow', 'cultivate_1', 'cultivation', 'First cultivation', 'after:transplant', 7, 0.78, 0.62, '#d98c2b', '#f4c430', 'canopy', null),
    ('Full brassica transplant flow', 'cultivate_2', 'cultivation', 'Second cultivation', 'after:cultivate_1', 10, 0.90, 0.62, '#d98c2b', '#f4c430', 'canopy', null),
    ('Full brassica transplant flow', 'spray', 'fertilizing_spraying', 'Spray/check pests', 'after:cultivate_2', 3, 0.90, 0.38, '#4f84aa', '#f4c430', null, null),
    ('Full brassica transplant flow', 'cultivate_3', 'cultivation', 'Third cultivation', 'after:spray', 7, 0.90, 0.76, '#d98c2b', '#f4c430', 'canopy', null),
    ('Full brassica transplant flow', 'cleanup', 'cleanup', 'Cleanup', 'after:cultivate_3', 40, 0.90, 0.90, '#6d7f45', '#f4c430', null, null)
)
insert into task_flow_nodes (
  flow_template_id,
  node_key,
  task_type,
  label,
  anchor,
  offset_days,
  x_pos,
  y_pos,
  icon_color,
  icon_secondary_color,
  tractor_model,
  notes
)
select
  template.id,
  node.node_key,
  node.task_type,
  node.label,
  node.anchor,
  node.offset_days,
  node.x_pos,
  node.y_pos,
  node.icon_color,
  node.icon_secondary_color,
  node.tractor_model,
  node.notes
from task_flow_templates template
join sample_nodes node on node.flow_name = template.name
where template.name in ('Eight-node transplant flow', 'Full brassica transplant flow')
on conflict (flow_template_id, node_key) do nothing;

with sample_edges(flow_name, from_node_key, to_node_key) as (
  values
    ('Eight-node transplant flow', 'disk', 'lime'),
    ('Eight-node transplant flow', 'lime', 'fertilize'),
    ('Eight-node transplant flow', 'fertilize', 'perfecta'),
    ('Eight-node transplant flow', 'perfecta', 'bed_shape'),
    ('Eight-node transplant flow', 'seed_tray', 'transplant'),
    ('Eight-node transplant flow', 'bed_shape', 'transplant'),
    ('Eight-node transplant flow',  'transplant', 'cleanup'),
    ('Full brassica transplant flow', 'seed_tray', 'pot_up'),
    ('Full brassica transplant flow', 'pot_up', 'transplant'),
    ('Full brassica transplant flow', 'disk', 'lime'),
    ('Full brassica transplant flow', 'lime', 'fertilize'),
    ('Full brassica transplant flow', 'fertilize', 'perfecta'),
    ('Full brassica transplant flow', 'perfecta', 'bed_shape'),
    ('Full brassica transplant flow', 'bed_shape', 'transplant'),
    ('Full brassica transplant flow', 'transplant', 'water_in'),
    ('Full brassica transplant flow', 'transplant', 'cultivate_1'),
    ('Full brassica transplant flow', 'cultivate_1', 'cultivate_2'),
    ('Full brassica transplant flow', 'cultivate_2', 'spray'),
    ('Full brassica transplant flow', 'spray', 'cultivate_3'),
    ('Full brassica transplant flow', 'cultivate_3', 'cleanup')
)
insert into task_flow_edges (flow_template_id, from_node_id, to_node_id)
select template.id, from_node.id, to_node.id
from task_flow_templates template
join sample_edges edge on edge.flow_name = template.name
join task_flow_nodes from_node
  on from_node.flow_template_id = template.id
  and from_node.node_key = edge.from_node_key
join task_flow_nodes to_node
  on to_node.flow_template_id = template.id
  and to_node.node_key = edge.to_node_key
where template.name in ('Eight-node transplant flow', 'Full brassica transplant flow')
on conflict (flow_template_id, from_node_id, to_node_id) do nothing;
