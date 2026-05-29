/**
 * Imports only seed catalog records from the private master-plan spreadsheet.
 *
 * This is intentionally narrower than db:import-demo: it does not replace crop
 * plans, map records, task flows, or field work. It reads Seed_Order for the
 * seed list and uses Start Chart to infer days to maturity.
 */
import fs from "node:fs";
import path from "node:path";
import { PoolClient } from "pg";
import { pool } from "../db";
import { importSeedCatalogRowsForFarm, parseSpreadsheetFiles } from "./import-demo-data";

type FarmRow = { id: number; name: string };

const projectRoot = path.resolve(__dirname, "../../../..");
const defaultDemoDataDir = process.env.LOAM_LEDGER_DEMO_DATA_DIR
  ? path.resolve(process.env.LOAM_LEDGER_DEMO_DATA_DIR)
  : path.join(projectRoot, "demo data");

function collectSeedCatalogFiles() {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  if (args.length > 0) {
    return args.map((arg) => path.resolve(arg));
  }
  if (!fs.existsSync(defaultDemoDataDir)) {
    throw new Error(`Missing demo data folder: ${defaultDemoDataDir}`);
  }
  return fs.readdirSync(defaultDemoDataDir)
    .filter((name) => name.endsWith(".xlsx") || name.endsWith(".ods"))
    .sort()
    .map((name) => path.join(defaultDemoDataDir, name));
}

async function listFarms(client: PoolClient) {
  const result = await client.query<FarmRow>(`select id, name from farms order by id`);
  return result.rows;
}

async function resolveFarmId(client: PoolClient) {
  const explicitFarmId = process.env.FARM_ID ? Number(process.env.FARM_ID) : null;
  if (explicitFarmId != null && Number.isInteger(explicitFarmId) && explicitFarmId > 0) {
    return explicitFarmId;
  }

  if (process.env.FARM_NAME) {
    const result = await client.query<FarmRow>(
      `select id, name from farms where lower(name) = lower($1) order by id`,
      [process.env.FARM_NAME]
    );
    if (result.rows.length === 1) {
      return result.rows[0].id;
    }
    throw new Error(`FARM_NAME matched ${result.rows.length} farms: ${process.env.FARM_NAME}`);
  }

  if (process.env.USERNAME) {
    const result = await client.query<FarmRow>(
      `
        select farm.id, farm.name
        from app_users app_user
        join farms farm on farm.id = app_user.farm_id
        where lower(app_user.username) = lower($1)
        order by farm.id
      `,
      [process.env.USERNAME]
    );
    if (result.rows.length === 1) {
      return result.rows[0].id;
    }
    throw new Error(`USERNAME matched ${result.rows.length} farms: ${process.env.USERNAME}`);
  }

  const farms = await listFarms(client);
  if (farms.length === 1) {
    return farms[0].id;
  }

  const farmList = farms.map((farm) => `${farm.id}: ${farm.name}`).join("\n");
  throw new Error(`Choose a farm with FARM_ID, FARM_NAME, or USERNAME. Available farms:\n${farmList}`);
}

async function run() {
  const client = await pool.connect();
  try {
    if (process.argv.includes("--list-farms")) {
      const farms = await listFarms(client);
      for (const farm of farms) {
        console.log(`${farm.id}\t${farm.name}`);
      }
      return;
    }

    const farmId = await resolveFarmId(client);
    const files = collectSeedCatalogFiles();
    const rows = parseSpreadsheetFiles(files);
    await client.query("begin");
    const importedSeedItems = await importSeedCatalogRowsForFarm(client, rows, farmId);
    await client.query("commit");
    console.log(`Imported seed catalog records: ${importedSeedItems}`);
    console.log(`Farm ID: ${farmId}`);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
