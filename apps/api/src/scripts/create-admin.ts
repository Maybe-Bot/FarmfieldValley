import { hashPassword } from "../auth";
import { pool } from "../db";

type AdminArgs = {
  email: string;
  username: string;
  password: string;
  displayName: string | null;
};

function readArg(flag: string) {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] ?? null;
}

function parseArgs(): AdminArgs {
  const email = readArg("--email")?.trim().toLowerCase() ?? "";
  const username = readArg("--username")?.trim() ?? "";
  const password = process.env.ADMIN_CREATE_PASSWORD ?? "";
  const displayName = readArg("--display-name")?.trim() ?? null;

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
    throw new Error("Use --email with a valid email address.");
  }
  if (username.length < 3 || username.length > 80) {
    throw new Error("Use --username with 3 to 80 characters.");
  }
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new Error("Set ADMIN_CREATE_PASSWORD with at least 8 characters, including one letter and one number.");
  }

  return { email, username, password, displayName: displayName || null };
}

async function run() {
  const args = parseArgs();
  const client = await pool.connect();

  try {
    await client.query("begin");
    const adminCountResult = await client.query<{ count: string }>(
      `select count(*)::text as count from app_users where is_admin = true`
    );
    if (Number(adminCountResult.rows[0]?.count ?? "0") > 0) {
      throw new Error("An admin account already exists. This command only creates the first admin.");
    }

    const farmResult = await client.query<{ id: number }>(
      `
        insert into farms (name, notes, maps_private)
        values ('Loam Ledger Administration', 'Internal admin account farm', true)
        returning id
      `
    );
    const farmId = farmResult.rows[0].id;

    const userResult = await client.query<{ id: number }>(
      `
        insert into app_users (email, username, password_hash, display_name, is_admin)
        values ($1, $2, $3, $4, true)
        returning id
      `,
      [args.email, args.username, hashPassword(args.password), args.displayName]
    );

    await client.query(
      `
        insert into farm_memberships (farm_id, user_id, role)
        values ($1, $2, 'planner')
      `,
      [farmId, userResult.rows[0].id]
    );

    await client.query("commit");
    console.log(`Admin created for username "${args.username}".`);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
