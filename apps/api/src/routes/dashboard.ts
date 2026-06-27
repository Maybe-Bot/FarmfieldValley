import express from "express";
import { QueryResultRow } from "pg";
import { AuthContext } from "../auth";
import { pool } from "../db";
import { DashboardResourceName, dashboardResponse, loadDashboardResource, parseDashboardResources } from "../dashboard-resources";
import { asyncHandler, currentAuth, requireRole } from "../route-helpers";

const DASHBOARD_QUERY_BATCH_SIZE = 4;

async function runDashboardQueryBatch<T>(loaders: Array<() => Promise<T>>) {
  const results: T[] = [];
  for (let index = 0; index < loaders.length; index += DASHBOARD_QUERY_BATCH_SIZE) {
    results.push(...await Promise.all(loaders.slice(index, index + DASHBOARD_QUERY_BATCH_SIZE).map((load) => load())));
  }
  return results;
}

export function registerDashboardRoutes(app: express.Express) {
  app.get("/api/dashboard", requireRole("worker"), asyncHandler(async (req, res) => {
    const auth = currentAuth(req) as AuthContext;
    let requestedResources: Set<DashboardResourceName> | null;
    try {
      requestedResources = parseDashboardResources(req.query.resources);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid dashboard resources" });
      return;
    }
    const dashboardQuery = async (
      resource: DashboardResourceName,
      text: string,
      values?: unknown[]
    ): Promise<{ rows: QueryResultRow[] }> => {
      const result = await loadDashboardResource(
        requestedResources,
        resource,
        () => pool.query(text, values)
      );
      return result ?? { rows: [] };
    };
    const mapQueryValues = [auth.farmId, auth.isAdmin];
    const [farm, fields, blocks, blockZones, beds, bedPresets, coverCropNames, seedItems, crops, varieties, taskFlowTemplates, taskFlowNodes, taskFlowEdges, tractorProfiles, plantings, placements, placementGaps, placementOverflows, events, tasks, harvests] = await runDashboardQueryBatch([
      () => dashboardQuery("farm", `
        select
          id,
          name,
          notes,
          maps_private as "mapsPrivate"
        from farms
        where id = $1
        limit 1
      `, [auth.farmId]),
      () => dashboardQuery("fields", `
        select
          field.id,
          field.farm_id as "farmId",
          farm.name as "farmName",
          field.name,
          field.notes,
          field.area_sqm as "areaSqM",
          ST_AsGeoJSON(field.boundary)::json as boundary,
          ST_AsGeoJSON(field.centroid)::json as centroid
        from fields field
        join farms farm on farm.id = field.farm_id
        where $2::boolean = true or field.farm_id = $1
        order by farm.name, field.id
      `, mapQueryValues),
      () => dashboardQuery("blocks", `
        select
          b.id,
          f.farm_id as "farmId",
          farm.name as "farmName",
          b.field_id as "fieldId",
          b.name,
          b.notes,
          b.bed_start_entrance_side as "bedStartEntranceSide",
          b.area_sqm as "areaSqM",
          f.name as "fieldName",
          ST_AsGeoJSON(b.boundary)::json as boundary,
          ST_AsGeoJSON(b.centroid)::json as centroid
        from blocks b
        join fields f on f.id = b.field_id
        join farms farm on farm.id = f.farm_id
        where $2::boolean = true or f.farm_id = $1
        order by farm.name, f.id, b.id
      `, mapQueryValues),
      () => dashboardQuery("blockZones", `
        select
          zone.id,
          field.farm_id as "farmId",
          farm.name as "farmName",
          zone.block_id as "blockId",
          block.name as "blockName",
          field.id as "fieldId",
          field.name as "fieldName",
          zone.name,
          zone.planned_use as "plannedUse",
          zone.actual_state as "actualState",
          zone.cover_crop_name_id as "coverCropNameId",
          cover_crop.name as "coverCropName",
          zone.planned_cover_crop_seed_date as "plannedCoverCropSeedDate",
          zone.planned_cover_crop_terminate_date as "plannedCoverCropTerminateDate",
          zone.actual_cover_crop_seed_date as "actualCoverCropSeedDate",
          zone.actual_cover_crop_terminate_date as "actualCoverCropTerminateDate",
          zone.notes,
          zone.area_sqm as "areaSqM",
          ST_AsGeoJSON(zone.boundary)::json as boundary,
          ST_AsGeoJSON(zone.centroid)::json as centroid
        from block_zones zone
        join blocks block on block.id = zone.block_id
        join fields field on field.id = block.field_id
        join farms farm on farm.id = field.farm_id
        left join cover_crop_names cover_crop on cover_crop.id = zone.cover_crop_name_id
        where $2::boolean = true or field.farm_id = $1
        order by farm.name, field.id, block.id, zone.id
      `, mapQueryValues),
      () => dashboardQuery("beds", `
        select
          b.id,
          field.farm_id as "farmId",
          farm.name as "farmName",
          b.block_id as "blockId",
          bl.name as "blockName",
          b.zone_id as "zoneId",
          zone.name as "zoneName",
          b.name,
          b.is_permanent as "isPermanent",
          b.notes,
          b.x,
          b.y,
          b.width,
          b.height,
          b.bed_length_m as "bedLengthM",
          b.source,
          b.direction,
          b.sequence_no as "sequenceNo",
          b.bed_preset_id as "bedPresetId",
          bp.name as "bedPresetName",
          b.area_sqm as "areaSqM",
          b.geometry_source as "geometrySource",
          b.geometry_updated_at as "geometryUpdatedAt",
          b.geometry_notes as "geometryNotes",
          ST_AsGeoJSON(coalesce(b.boundary, ST_Transform(b.geom, 4326)))::json as boundary,
          coalesce(sum(pp.bed_length_used_m), 0) as "occupiedLengthM"
        from beds b
        join blocks bl on bl.id = b.block_id
        join fields field on field.id = bl.field_id
        join farms farm on farm.id = field.farm_id
        left join block_zones zone on zone.id = b.zone_id
        left join bed_presets bp on bp.id = b.bed_preset_id
        left join planting_placements pp on pp.bed_id = b.id
        where $2::boolean = true or field.farm_id = $1
        group by b.id, field.id, field.farm_id, farm.name, bl.id, bl.name, zone.id, zone.name, bp.id, bp.name
        order by farm.name, field.id, bl.id, b.id
      `, mapQueryValues),
      () => dashboardQuery("bedPresets", `
        select
          id,
          farm_id as "farmId",
          name,
          bed_width_m as "bedWidthM",
          path_spacing_m as "pathSpacingM",
          is_road as "isRoad",
          notes
        from bed_presets
        where farm_id = $1
        order by name
      `, [auth.farmId]),
      () => dashboardQuery("coverCropNames", `
        select
          id,
          farm_id as "farmId",
          name,
          notes
        from cover_crop_names
        where farm_id = $1
        order by name
      `, [auth.farmId]),
      () => dashboardQuery("seedItems", `
        select
          id,
          farm_id as "farmId",
          crop_id as "cropId",
          variety_id as "varietyId",
          family,
          crop_type as "cropType",
          variety_name as "varietyName",
          breed_name as "breedName",
          supplier,
          catalog_number as "catalogNumber",
          lot_number as "lotNumber",
          coalesce(
            (select sum(lot.stock_quantity)::integer from seed_item_lots lot where lot.seed_item_id = seed_items.id),
            stock_quantity
          ) as "stockQuantity",
          (
            select coalesce(json_agg(json_build_object(
              'id', lot.id,
              'seedItemId', lot.seed_item_id,
              'lotNumber', lot.lot_number,
              'stockQuantity', lot.stock_quantity
            ) order by lot.lot_number), '[]'::json)
            from seed_item_lots lot
            where lot.seed_item_id = seed_items.id
          ) as lots,
          days_to_maturity as "daysToMaturity",
          usual_spacing as "usualSpacing",
          usual_field_spacing_in_row as "usualFieldSpacingInRow",
          usual_row_spacing as "usualRowSpacing",
          usual_rows_per_bed as "usualRowsPerBed",
          notes,
          archived_at as "archivedAt",
          concat_ws(' / ', crop_type, variety_name, breed_name, supplier, nullif(catalog_number, ''), nullif(lot_number, '')) as "displayName"
        from seed_items
        where farm_id = $1
        order by archived_at nulls first, crop_type, variety_name nulls last, breed_name nulls last, supplier nulls last
      `, [auth.farmId]),
      () => dashboardQuery("crops", `select id, name from crops order by name`),
      () => dashboardQuery("varieties", `
        select id, crop_id as "cropId", name
        from varieties
        order by name
      `),
      () => dashboardQuery("taskFlowTemplates", `
        select
          tft.id,
          tft.farm_id as "farmId",
          tft.crop_id as "cropId",
          c.name as "cropName",
          tft.name,
          tft.notes,
          tft.is_default as "isDefault",
          tft.source_task_flow_template_id as "sourceTaskFlowTemplateId"
        from task_flow_templates tft
        left join crops c on c.id = tft.crop_id
        where tft.farm_id = $1
        order by coalesce(c.name, 'General'), tft.name
      `, [auth.farmId]),
      () => dashboardQuery("taskFlowNodes", `
        select
          id,
          flow_template_id as "flowTemplateId",
          node_key as "nodeKey",
          task_type as "taskType",
          label,
          anchor,
          offset_days as "offsetDays",
          icon_color as "iconColor",
          icon_secondary_color as "iconSecondaryColor",
          tractor_model as "tractorModel",
          tractor_profile_id as "tractorProfileId",
          x_pos as "x",
          y_pos as "y",
          notes
        from task_flow_nodes
        where flow_template_id in (select id from task_flow_templates where farm_id = $1)
        order by flow_template_id, y_pos, x_pos, id
      `, [auth.farmId]),
      () => dashboardQuery("taskFlowEdges", `
        select
          e.id,
          e.flow_template_id as "flowTemplateId",
          from_node.node_key as "fromNodeKey",
          to_node.node_key as "toNodeKey",
          e.delay_days::float8 as "delayDays"
        from task_flow_edges e
        join task_flow_nodes from_node on from_node.id = e.from_node_id
        join task_flow_nodes to_node on to_node.id = e.to_node_id
        where e.flow_template_id in (select id from task_flow_templates where farm_id = $1)
        order by e.flow_template_id, e.id
      `, [auth.farmId]),
      () => dashboardQuery("tractorProfiles", `
        select
          id,
          farm_id as "farmId",
          name,
          tractor_model as "tractorModel",
          icon_color as "iconColor",
          icon_secondary_color as "iconSecondaryColor"
        from tractor_profiles
        where farm_id = $1
        order by name, id
      `, [auth.farmId]),
      () => dashboardQuery("plantings", `
        select
          p.id,
          p.farm_id as "farmId",
          p.crop_id as "cropId",
          p.variety_id as "varietyId",
          p.seed_item_id as "seedItemId",
          c.name as "cropName",
          v.name as "varietyName",
          concat_ws(' / ', seed.crop_type, seed.variety_name, seed.breed_name, seed.supplier, nullif(seed.lot_number, '')) as "seedName",
          p.title,
          p.status,
          p.intended_field_id as "intendedFieldId",
          pf.name as "intendedFieldName",
          p.intended_block_id as "intendedBlockId",
          pb.name as "intendedBlockName",
          p.intended_bed_id as "intendedBedId",
          ib.name as "intendedBedName",
          p.task_flow_template_id as "taskFlowTemplateId",
          tft.name as "taskFlowTemplateName",
          p.spacing,
          p.plant_count as "plantCount",
          p.bed_length_used_m as "bedLengthUsedM",
          p.tray_location as "trayLocation",
          p.tray_count as "trayCount",
          p.cells_per_tray as "cellsPerTray",
          p.days_to_harvest as "daysToHarvest",
          p.field_spacing_in_row as "fieldSpacingInRow",
          p.row_spacing as "rowSpacing",
          p.rows_per_bed as "rowsPerBed",
          p.dead_at_frost as "deadAtFrost",
          p.bed_cover as "bedCover",
          p.notes,
          p.planned_sow_date as "plannedSowDate",
          p.planned_transplant_date as "plannedTransplantDate",
          p.expected_harvest_start as "expectedHarvestStart",
          p.expected_harvest_end as "expectedHarvestEnd",
          p.actual_tray_seeding_date as "actualTraySeedingDate",
          p.actual_direct_seeding_date as "actualDirectSeedingDate",
          p.actual_transplant_date as "actualTransplantDate",
          p.actual_cultivation_date as "actualCultivationDate",
          p.actual_harvest_date as "actualHarvestDate",
          p.actual_finish_date as "actualFinishDate"
        from plantings p
        join crops c on c.id = p.crop_id
        left join varieties v on v.id = p.variety_id
        left join seed_items seed on seed.id = p.seed_item_id
        left join fields pf on pf.id = p.intended_field_id
        left join blocks pb on pb.id = p.intended_block_id
        left join beds ib on ib.id = p.intended_bed_id
        left join task_flow_templates tft on tft.id = p.task_flow_template_id
        where p.farm_id = $1
        order by coalesce(p.planned_transplant_date, p.planned_sow_date), p.id
      `, [auth.farmId]),
      () => dashboardQuery("placements", `
        select
          pp.id,
          pp.planting_id as "plantingId",
          pp.bed_id as "bedId",
          b.name as "bedName",
          pp.plant_count as "plantCount",
          pp.bed_length_used_m as "bedLengthUsedM",
          pp.start_length_m as "startLengthM",
          pp.placement_order as "placementOrder",
          pp.plan_source as "planSource",
          pp.placed_on as "placedOn",
          pp.location_detail as "locationDetail",
          pp.notes,
          case when pp.boundary is not null then ST_AsGeoJSON(pp.boundary)::json else null end as boundary
        from planting_placements pp
        join beds b on b.id = pp.bed_id
        join plantings p on p.id = pp.planting_id
        where p.farm_id = $1
        order by pp.id
      `, [auth.farmId]),
      () => dashboardQuery("placementGaps", `
        select
          gap.id,
          gap.farm_id as "farmId",
          gap.block_id as "blockId",
          block.name as "blockName",
          gap.bed_id as "bedId",
          bed.name as "bedName",
          gap.start_length_m as "startLengthM",
          gap.bed_length_used_m as "bedLengthUsedM",
          gap.placement_order as "placementOrder",
          gap.notes
        from block_placement_gaps gap
        join blocks block on block.id = gap.block_id
        join beds bed on bed.id = gap.bed_id
        where gap.farm_id = $1
        order by gap.block_id, gap.placement_order, gap.id
      `, [auth.farmId]),
      () => dashboardQuery("placementOverflows", `
        select
          overflow.id,
          overflow.farm_id as "farmId",
          overflow.block_id as "blockId",
          block.name as "blockName",
          overflow.planting_id as "plantingId",
          planting.title as "plantingTitle",
          overflow.entry_type as "entryType",
          overflow.bed_length_used_m as "bedLengthUsedM",
          overflow.plant_count as "plantCount",
          overflow.tray_count as "trayCount",
          overflow.placement_order as "placementOrder",
          overflow.notes
        from block_placement_overflows overflow
        join blocks block on block.id = overflow.block_id
        left join plantings planting on planting.id = overflow.planting_id
        where overflow.farm_id = $1
        order by overflow.block_id, overflow.placement_order, overflow.id
      `, [auth.farmId]),
      () => dashboardQuery("events", `
        select
          event.id,
          event.farm_id as "farmId",
          event.event_date as "eventDate",
          event.event_type as "eventType",
          event.title,
          event.notes,
          event.metadata,
          event.field_id as "fieldId",
          event.block_id as "blockId",
          event.zone_id as "zoneId",
          event.bed_id as "bedId",
          bed.name as "bedName",
          event.planting_id as "plantingId",
          planting.title as "plantingTitle",
          event.placement_id as "placementId",
          event.task_id as "taskId",
          case when event.boundary is not null then ST_AsGeoJSON(event.boundary)::json else null end as boundary
        from farm_events event
        left join beds bed on bed.id = event.bed_id
        left join plantings planting on planting.id = event.planting_id
        where event.farm_id = $1
        order by event.event_date desc, event.id desc
      `, [auth.farmId]),
      () => dashboardQuery("tasks", `
        select
          t.id,
          t.farm_id as "farmId",
          t.planting_id as "plantingId",
          t.bed_id as "bedId",
          t.task_flow_node_id as "taskFlowNodeId",
          t.task_type as "taskType",
          t.title,
          t.status,
          t.anchor,
          t.offset_days as "offsetDays",
          coalesce(t.icon_color, node.icon_color, '#4f84aa') as "iconColor",
          coalesce(t.icon_secondary_color, node.icon_secondary_color, '#f4c430') as "iconSecondaryColor",
          coalesce(t.tractor_model, node.tractor_model) as "tractorModel",
          coalesce(t.tractor_profile_id, node.tractor_profile_id) as "tractorProfileId",
          t.depends_on_task_ids as "dependsOnTaskIds",
          t.scheduled_date as "scheduledDate",
          t.completed_date as "completedDate",
          t.notes,
          t.is_auto_generated as "isAutoGenerated",
          p.title as "plantingTitle",
          b.name as "bedName"
        from tasks t
        left join plantings p on p.id = t.planting_id
        left join beds b on b.id = t.bed_id
        left join task_flow_nodes node on node.id = t.task_flow_node_id
        where t.farm_id = $1
        order by t.scheduled_date nulls last, t.id
      `, [auth.farmId]),
      () => dashboardQuery("harvests", `
        select
          h.id,
          h.farm_id as "farmId",
          h.planting_id as "plantingId",
          h.bed_id as "bedId",
          h.harvest_date as "harvestDate",
          h.quantity,
          h.unit,
          h.notes,
          p.title as "plantingTitle",
          b.name as "bedName"
        from harvest_records h
        join plantings p on p.id = h.planting_id
        join beds b on b.id = h.bed_id
        where h.farm_id = $1
        order by h.harvest_date desc, h.id desc
      `, [auth.farmId])
    ]);
  
    res.json(dashboardResponse(requestedResources, {
      farm: farm.rows[0] ?? null,
      fields: fields.rows,
      blocks: blocks.rows,
      blockZones: blockZones.rows,
      beds: beds.rows,
      bedPresets: bedPresets.rows,
      coverCropNames: coverCropNames.rows,
      seedItems: seedItems.rows,
      crops: crops.rows,
      varieties: varieties.rows,
      taskFlowTemplates: taskFlowTemplates.rows,
      taskFlowNodes: taskFlowNodes.rows,
      taskFlowEdges: taskFlowEdges.rows,
      tractorProfiles: tractorProfiles.rows,
      plantings: plantings.rows,
      placements: placements.rows,
      placementGaps: placementGaps.rows,
      placementOverflows: placementOverflows.rows,
      events: events.rows,
      tasks: tasks.rows,
      harvests: harvests.rows
    }));
  }));
  
}
