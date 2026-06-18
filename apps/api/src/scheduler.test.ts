import test from "node:test";
import assert from "node:assert/strict";
import { recalculatePlantingTasks } from "./scheduler";

type QueryCall = {
  sql: string;
  params?: unknown[];
};

function makeSchedulerClient(options?: {
  existingTasks?: Array<{
    id: number;
    task_flow_node_id: number | null;
    status: string;
    completed_date: string | null;
    event_count: string;
  }>;
}) {
  const calls: QueryCall[] = [];
  let nextTaskId = 100;

  return {
    calls,
    client: {
      async query(sql: string, params?: unknown[]) {
        calls.push({ sql, params });
        const compactSql = sql.replace(/\s+/g, " ").trim();

        if (compactSql.includes("from plantings p")) {
          return {
            rows: [{
              id: 44,
              farm_id: 7,
              crop_id: 3,
              intended_bed_id: 12,
              crop_name: "Carrot",
              variety_name: "Napoli",
              task_flow_template_id: null,
              planned_sow_date: "2026-03-01",
              actual_tray_seeding_date: "2026-03-08",
              actual_direct_seeding_date: null,
              days_to_harvest: 75,
              seed_days_to_maturity: 70
            }]
          };
        }

        if (compactSql.includes("from task_flow_templates")) {
          return { rows: [{ id: 77 }] };
        }

        if (compactSql.includes("from task_flow_nodes")) {
          return {
            rows: [
              { id: 1, node_key: "seed", task_type: "seed_in_tray", label: "Seed trays", anchor: "planned_sow", offset_days: 0, icon_color: "#111111", icon_secondary_color: "#aaaaaa", tractor_model: null, tractor_profile_id: null },
              { id: 2, node_key: "transplant", task_type: "transplant", label: "Plant in field", anchor: "after:seed", offset_days: 33, icon_color: "#222222", icon_secondary_color: "#bbbbbb", tractor_model: null, tractor_profile_id: null },
              { id: 3, node_key: "cultivation", task_type: "cultivation", label: "Cultivate", anchor: "after:transplant", offset_days: 7, icon_color: "#333333", icon_secondary_color: "#cccccc", tractor_model: "canopy", tractor_profile_id: 9 },
              { id: 4, node_key: "cleanup", task_type: "cleanup", label: "Cleanup", anchor: "after:cultivation", offset_days: 49, icon_color: "#444444", icon_secondary_color: "#dddddd", tractor_model: null, tractor_profile_id: null }
            ]
          };
        }

        if (compactSql.includes("from task_flow_edges")) {
          return {
            rows: [
              { from_node_key: "seed", to_node_key: "transplant", delay_days: 33 },
              { from_node_key: "transplant", to_node_key: "cultivation", delay_days: 7 },
              { from_node_key: "cultivation", to_node_key: "cleanup", delay_days: 49 }
            ]
          };
        }

        if (compactSql.includes("from tasks task")) {
          return { rows: options?.existingTasks ?? [] };
        }

        if (compactSql.startsWith("insert into tasks")) {
          nextTaskId += 1;
          return { rows: [{ id: nextTaskId }] };
        }

        return { rows: [] };
      }
    }
  };
}

test("recalculatePlantingTasks schedules from seeding date and preserves arrow dependencies", async () => {
  const { client, calls } = makeSchedulerClient();

  await recalculatePlantingTasks(client as never, 44);

  const taskInserts = calls.filter((call) => call.sql.includes("insert into tasks"));
  assert.equal(taskInserts.length, 4);
  assert.equal(taskInserts[0].params?.[12], "2026-03-08");
  assert.equal(taskInserts[1].params?.[12], "2026-04-10");
  assert.equal(taskInserts[2].params?.[12], "2026-04-17");
  assert.equal(taskInserts[3].params?.[10], "after:cultivation");
  assert.equal(taskInserts[3].params?.[11], 49);
  assert.equal(taskInserts[3].params?.[12], "2026-06-05");

  const dependencyUpdates = calls.filter((call) => call.sql.includes("set depends_on_task_ids"));
  assert.deepEqual(dependencyUpdates[0].params, [101, []]);
  assert.deepEqual(dependencyUpdates[1].params, [102, [101]]);
  assert.deepEqual(dependencyUpdates[2].params, [103, [102]]);
  assert.deepEqual(dependencyUpdates[3].params, [104, [103]]);

  const bulkCompletionUpdates = calls.filter((call) => call.sql.includes("set status = 'done'"));
  assert.equal(bulkCompletionUpdates.length, 0);
});

test("recalculatePlantingTasks updates existing generated tasks instead of replacing their IDs", async () => {
  const { client, calls } = makeSchedulerClient({
    existingTasks: [
      { id: 501, task_flow_node_id: 1, status: "done", completed_date: "2026-03-08", event_count: "1" },
      { id: 502, task_flow_node_id: 2, status: "done", completed_date: "2026-04-12", event_count: "1" },
      { id: 503, task_flow_node_id: 999, status: "done", completed_date: "2026-03-01", event_count: "1" },
      { id: 504, task_flow_node_id: 1000, status: "pending", completed_date: null, event_count: "0" }
    ]
  });

  await recalculatePlantingTasks(client as never, 44);

    const taskInserts = calls.filter((call) => call.sql.includes("insert into tasks"));
	    assert.equal(taskInserts.length, 2);
	    assert.equal(taskInserts[0].params?.[3], 3);
	    assert.equal(taskInserts[0].params?.[10], "after:transplant");
	    assert.equal(taskInserts[0].params?.[12], "2026-04-19");
	    assert.equal(taskInserts[1].params?.[3], 4);
		    assert.equal(taskInserts[1].params?.[10], "after:cultivation");
		    assert.equal(taskInserts[1].params?.[11], 49);
		    assert.equal(taskInserts[1].params?.[12], "2026-06-07");

  const taskUpdates = calls.filter((call) => call.sql.includes("update tasks") && call.sql.includes("scheduled_date = $12"));
  assert.deepEqual(taskUpdates.map((call) => call.params?.[0]), [501, 502]);

  const dependencyUpdates = calls.filter((call) => call.sql.includes("set depends_on_task_ids"));
  assert.deepEqual(dependencyUpdates[0].params, [501, []]);
  assert.deepEqual(dependencyUpdates[1].params, [502, [501]]);
  assert.deepEqual(dependencyUpdates[2].params, [101, [502]]);
  assert.deepEqual(dependencyUpdates[3].params, [102, [101]]);

  const retainedHistoricalTask = calls.find((call) => call.sql.includes("Task kept as history") && call.params?.[0] === 503);
  assert.ok(retainedHistoricalTask);

  const deletedObsoleteTask = calls.find((call) => call.sql.includes("delete from tasks where id = $1") && call.params?.[0] === 504);
  assert.ok(deletedObsoleteTask);
});

test("recalculatePlantingTasks accumulates fractional arrow delays", async () => {
  const { client, calls } = makeSchedulerClient();
  const originalQuery = client.query.bind(client);
  client.query = async (sql: string, params?: unknown[]) => {
    const compactSql = sql.replace(/\s+/g, " ").trim();
    if (compactSql.includes("from task_flow_edges")) {
      calls.push({ sql, params });
      return {
        rows: [
          { from_node_key: "seed", to_node_key: "transplant", delay_days: 0.5 },
          { from_node_key: "transplant", to_node_key: "cultivation", delay_days: 0.5 },
          { from_node_key: "cultivation", to_node_key: "cleanup", delay_days: 0.01 }
        ]
      };
    }
    return originalQuery(sql, params);
  };

  await recalculatePlantingTasks(client as never, 44);

  const taskInserts = calls.filter((call) => call.sql.includes("insert into tasks"));
  assert.equal(taskInserts[0].params?.[12], "2026-03-08");
  assert.equal(taskInserts[1].params?.[12], "2026-03-08");
  assert.equal(taskInserts[2].params?.[12], "2026-03-09");
  assert.equal(taskInserts[3].params?.[11], 0.01);
});
