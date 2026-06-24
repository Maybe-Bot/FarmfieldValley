import assert from "node:assert/strict";
import test from "node:test";
import {
  dashboardResponse,
  loadDashboardResource,
  parseDashboardResources
} from "./dashboard-resources";

test("dashboard resources default to the complete small-farm response", () => {
  assert.equal(parseDashboardResources(undefined), null);
  assert.deepEqual(
    dashboardResponse(null, {
      farm: { id: 1 },
      fields: [],
      blocks: [],
      blockZones: [],
      beds: [],
      bedPresets: [],
      coverCropNames: [],
      seedItems: [],
      crops: [],
      varieties: [],
      taskFlowTemplates: [],
      taskFlowNodes: [],
      taskFlowEdges: [],
      tractorProfiles: [],
      plantings: [],
      placements: [],
      placementGaps: [],
      placementOverflows: [],
      events: [],
      tasks: [],
      harvests: []
    }).farm,
    { id: 1 }
  );
});

test("partial dashboard reloads execute only requested resource loaders", async () => {
  const requested = parseDashboardResources("tasks,events");
  let taskLoads = 0;
  let eventLoads = 0;
  let plantingLoads = 0;

  const tasks = await loadDashboardResource(requested, "tasks", async () => {
    taskLoads += 1;
    return [{ id: 10 }];
  });
  const events = await loadDashboardResource(requested, "events", async () => {
    eventLoads += 1;
    return [{ id: 20 }];
  });
  const plantings = await loadDashboardResource(requested, "plantings", async () => {
    plantingLoads += 1;
    return [{ id: 30 }];
  });

  assert.deepEqual(tasks, [{ id: 10 }]);
  assert.deepEqual(events, [{ id: 20 }]);
  assert.equal(plantings, null);
  assert.equal(taskLoads, 1);
  assert.equal(eventLoads, 1);
  assert.equal(plantingLoads, 0);
});

test("partial responses omit unrelated dashboard data", () => {
  const requested = parseDashboardResources("tasks");
  const response = dashboardResponse(requested, {
    farm: { id: 1 },
    fields: [{ id: 2 }],
    blocks: [],
    blockZones: [],
    beds: [],
    bedPresets: [],
    coverCropNames: [],
    seedItems: [],
    crops: [],
    varieties: [],
    taskFlowTemplates: [],
    taskFlowNodes: [],
    taskFlowEdges: [],
    tractorProfiles: [],
    plantings: [],
    placements: [],
    placementGaps: [],
    placementOverflows: [],
    events: [],
    tasks: [{ id: 3 }],
    harvests: []
  });

  assert.deepEqual(response, { tasks: [{ id: 3 }] });
  assert.equal("fields" in response, false);
});

test("unknown resource names are rejected", () => {
  assert.throws(
    () => parseDashboardResources("tasks,weather"),
    /Unknown dashboard resource: weather/
  );
});
