insert into tractor_profiles (farm_id, name, tractor_model, icon_color, icon_secondary_color)
select farm.id, profile.name, profile.tractor_model, profile.icon_color, profile.icon_secondary_color
from farms farm
cross join (
  values
    ('Van', 'van', '#d6d9dc', '#2f3437'),
    ('Pickup truck', 'pickup', '#b7322c', '#f2d6aa'),
    ('Box truck', 'box', '#f1efe6', '#b7322c')
) as profile(name, tractor_model, icon_color, icon_secondary_color)
on conflict (farm_id, name) do nothing;
