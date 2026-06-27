import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const apiSrc = path.dirname(fileURLToPath(import.meta.url));

function readSource(relativePath: string) {
  return readFileSync(path.join(apiSrc, relativePath), "utf8");
}

function compact(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

test("field, block, and block-zone geometry writes include farm predicates inside SQL", () => {
  const server = compact(readSource("server.ts"));

  assert.match(server, /update fields set .* where id = \$1 and farm_id = \$9/);
  assert.match(server, /update blocks set .* where id = \$1 and field_id in \(select id from fields where farm_id = \$10\)/);
  assert.match(server, /update block_zones set .* where id = \$1 and block_id in \( select block\.id from blocks block join fields field on field\.id = block\.field_id where field\.farm_id = \$17 \)/);
});

test("map deletes and bed writes are constrained to the authenticated farm", () => {
  const mapRoutes = compact(readSource("routes/map-routes.ts"));

  assert.match(mapRoutes, /delete from fields where id = \$1 and farm_id = \$2/);
  assert.match(mapRoutes, /delete from blocks where id = \$1 and field_id in \(select id from fields where farm_id = \$2\)/);
  assert.match(mapRoutes, /insert into beds .* from blocks block join fields field on field\.id = block\.field_id where block\.id = \$1 and field\.farm_id = \$11 returning id/);
  assert.match(mapRoutes, /update beds set .* where id = \$1 and block_id in \( select block\.id from blocks block join fields field on field\.id = block\.field_id where field\.farm_id = \$11 \)/);
  assert.match(mapRoutes, /delete from beds bed using blocks block, fields field where bed\.block_id = block\.id and block\.field_id = field\.id and bed\.id = \$1 and field\.farm_id = \$2/);
});

test("block-zone reads, updates, deletes, and related planting changes stay inside one farm", () => {
  const zoneRoutes = compact(readSource("routes/farm-zone-routes.ts"));

  assert.match(zoneRoutes, /from block_zones zone join blocks block on block\.id = zone\.block_id join fields field on field\.id = block\.field_id where zone\.id = \$1 and field\.farm_id = \$2/);
  assert.match(zoneRoutes, /update block_zones set .* where id = \$1 and block_id in \( select block\.id from blocks block join fields field on field\.id = block\.field_id where field\.farm_id = \$6 \)/);
  assert.match(zoneRoutes, /update plantings set intended_bed_id = null, updated_at = now\(\) where farm_id = \$2 and intended_bed_id in \( select bed\.id from beds bed join blocks block on block\.id = bed\.block_id join fields field on field\.id = block\.field_id where bed\.zone_id = \$1 and field\.farm_id = \$2 \)/);
  assert.match(zoneRoutes, /delete from block_zones zone using blocks block, fields field where zone\.block_id = block\.id and block\.field_id = field\.id and zone\.id = \$1 and field\.farm_id = \$2/);
});

test("bed generation, task recording, and vehicle updates cannot affect another farm", () => {
  const server = compact(readSource("server.ts"));
  const taskRoutes = compact(readSource("routes/task-routes.ts"));
  const referenceRoutes = compact(readSource("routes/farm-reference-routes.ts"));

  assert.match(server, /select bed_width_m, path_spacing_m, name, is_road from bed_presets where id = \$1 and farm_id = \$2/);
  assert.match(server, /delete from beds bed using blocks block, fields field where bed\.block_id = block\.id and block\.field_id = field\.id and field\.farm_id = \$2 and bed\.block_id = \$1/);
  assert.match(taskRoutes, /update tasks set .* where id = \$1 and farm_id = \$5/);
  assert.match(referenceRoutes, /update tasks set tractor_profile_id = null where tractor_profile_id = \$1 and farm_id = \$2/);
  assert.match(referenceRoutes, /update task_flow_nodes set tractor_profile_id = null where tractor_profile_id = \$1 and flow_template_id in \( select id from task_flow_templates where farm_id = \$2 \)/);
});

test("dashboard farm settings and offline imagery require the current authenticated farm", () => {
  const server = compact(readSource("server.ts"));
  const dashboard = compact(readSource("routes/dashboard.ts"));
  const admin = compact(readSource("routes/admin.ts"));

  assert.doesNotMatch(server, /req\.path\.startsWith\("\/offline-imagery\/"\)/);
  assert.match(server, /app\.get\("\/api\/offline-imagery\/status", requireRole\("worker"\)/);
  assert.match(server, /app\.get\("\/api\/offline-imagery\/tiles\/:z\/:x\/:y", requireRole\("worker"\)/);
  assert.match(server, /Cache-Control", "private, max-age=31536000, immutable"/);
  assert.match(dashboard, /from farms where id = \$1 limit 1/);
  assert.match(dashboard, /where \$2::boolean = true or field\.farm_id = \$1/);
  assert.match(dashboard, /const mapQueryValues = \[auth\.farmId, auth\.isAdmin\]/);
  assert.match(admin, /update farms set maps_private = \$2, updated_at = now\(\) where id = \$1/);
});

test("admin soft-delete releases account email for reuse", () => {
  const admin = compact(readSource("routes/admin.ts"));

  assert.match(admin, /email = 'deleted-' \|\| id \|\| '-' \|\| email, is_active = false/);
});
