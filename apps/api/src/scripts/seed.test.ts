import test from "node:test";
import assert from "node:assert/strict";
import { assertDestructiveSeedAllowed } from "./seed";

function makeCountClient(count: number) {
  return {
    async query() {
      return { rows: [{ count: String(count) }] };
    }
  };
}

test("assertDestructiveSeedAllowed allows an empty database without confirmation", async () => {
  const previous = process.env.FARMFIELD_VALLEY_CONFIRM_DESTRUCTIVE_SEED;
  delete process.env.FARMFIELD_VALLEY_CONFIRM_DESTRUCTIVE_SEED;

  try {
    await assertDestructiveSeedAllowed(makeCountClient(0) as never);
  } finally {
    process.env.FARMFIELD_VALLEY_CONFIRM_DESTRUCTIVE_SEED = previous;
  }
});

test("assertDestructiveSeedAllowed blocks existing data without explicit confirmation", async () => {
  const previous = process.env.FARMFIELD_VALLEY_CONFIRM_DESTRUCTIVE_SEED;
  delete process.env.FARMFIELD_VALLEY_CONFIRM_DESTRUCTIVE_SEED;

  try {
    await assert.rejects(
      () => assertDestructiveSeedAllowed(makeCountClient(3) as never),
      /Refusing to run db:seed/
    );
  } finally {
    process.env.FARMFIELD_VALLEY_CONFIRM_DESTRUCTIVE_SEED = previous;
  }
});

test("assertDestructiveSeedAllowed permits existing data with explicit destructive confirmation", async () => {
  const previous = process.env.FARMFIELD_VALLEY_CONFIRM_DESTRUCTIVE_SEED;
  process.env.FARMFIELD_VALLEY_CONFIRM_DESTRUCTIVE_SEED = "yes";

  try {
    await assertDestructiveSeedAllowed(makeCountClient(3) as never);
  } finally {
    process.env.FARMFIELD_VALLEY_CONFIRM_DESTRUCTIVE_SEED = previous;
  }
});
