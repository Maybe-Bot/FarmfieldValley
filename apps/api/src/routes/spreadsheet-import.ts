import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PoolClient } from "pg";
import { z } from "zod";
import { AuthContext } from "../auth";
import { pool } from "../db";
import {
  importPlantingSpreadsheetRowsForFarm,
  parsePlantingSpreadsheetFiles,
  supportedPlantingSpreadsheetExtension
} from "../planting-spreadsheet-import";
import { buildFarmExportWorkbook } from "../spreadsheet-export";
import { FarmRole } from "../types";

type ConnectedClient = PoolClient;

type SpreadsheetImportRouteDeps = {
  // These dependencies still live in server.ts while this prototype is being
  // split up. Passing them in avoids changing auth/undo behavior during refactor.
  asyncHandler: (
    handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void>
  ) => express.RequestHandler;
  currentAuth: (req: express.Request) => AuthContext | null;
  requireRole: (role?: FarmRole) => express.RequestHandler;
  createUndoSnapshot: (client: ConnectedClient, auth: AuthContext, label: string) => Promise<void>;
  pruneUndoSnapshots: (client: ConnectedClient, auth: AuthContext) => Promise<void>;
};

const spreadsheetImportSchema = z.object({
  fileName: z.string().trim().min(1).max(240),
  contentBase64: z.string().min(1)
});

export function registerSpreadsheetImportRoutes(app: express.Express, deps: SpreadsheetImportRouteDeps) {
  app.get("/api/export/spreadsheet", deps.requireRole("planner"), deps.asyncHandler(async (req, res) => {
    const auth = deps.currentAuth(req) as AuthContext;
    const client = await pool.connect();
    try {
      const workbook = await buildFarmExportWorkbook(client, auth.farmId);
      const date = new Date().toISOString().slice(0, 10);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="loam-ledger-backup-${date}.xlsx"`);
      res.send(workbook);
    } finally {
      client.release();
    }
  }));

  // User-facing spreadsheet upload. It accepts both the smaller crop-plan
  // template and full farm backup exports. Both paths are append-only.
  app.post("/api/import/spreadsheet", deps.requireRole("planner"), deps.asyncHandler(async (req, res) => {
    const auth = deps.currentAuth(req) as AuthContext;
    const body = spreadsheetImportSchema.parse(req.body);
    const extension = supportedPlantingSpreadsheetExtension(body.fileName);
    const rawBase64 = body.contentBase64.includes(",")
      ? body.contentBase64.slice(body.contentBase64.indexOf(",") + 1)
      : body.contentBase64;
    const buffer = Buffer.from(rawBase64, "base64");
    if (buffer.length === 0) {
      throw new Error("Spreadsheet upload was empty");
    }
    if (buffer.length > 10 * 1024 * 1024) {
      throw new Error("Spreadsheet upload is too large for this prototype");
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "loam-ledger-spreadsheet-"));
    const tempFile = path.join(tempDir, `upload${extension}`);
    const client = await pool.connect();

    try {
      await fs.writeFile(tempFile, buffer);
      const rows = parsePlantingSpreadsheetFiles([tempFile]);
      if (rows.length === 0) {
        throw new Error("Spreadsheet did not contain any readable rows");
      }

      await client.query("begin");
      await deps.createUndoSnapshot(client, auth, "Import spreadsheet crop plan");
      const result = await importPlantingSpreadsheetRowsForFarm(client, rows, auth.farmId);
      await deps.pruneUndoSnapshots(client, auth);
      await client.query("commit");
      res.status(201).json(result);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }));
}
