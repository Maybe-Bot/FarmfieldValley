import { FormEvent, useState } from "react";
import { api } from "../api";

// The upload route accepts JSON, so the browser converts the spreadsheet file
// into a base64 string instead of sending multipart form data.
function readFileAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read spreadsheet file"));
    reader.readAsDataURL(file);
  });
}

const templateHeaders = [
  "Seed supplier",
  "Crop",
  "Variety",
  "Catalog number",
  "Start date",
  "Plant count",
  "Transplant date",
  "Tray count",
  "Cells per tray",
  "Days to harvest",
  "Field spacing in row",
  "Row spacing",
  "Rows per bed",
  "Dead at frost (y/n)",
  "Field",
  "Block",
  "Bed",
  "Notes"
];

// Planner-facing spreadsheet importer. It intentionally supports only one
// strict planting-plan template so users can prepare predictable data before upload.
export function SpreadsheetImportCard({ onImported }: { onImported: () => Promise<void> }) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  async function importSpreadsheet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedFile) {
      setStatus("Choose an .xlsx, .ods, or .csv spreadsheet first.");
      return;
    }

    try {
      setImporting(true);
      setStatus("Reading spreadsheet...");
      const contentBase64 = await readFileAsBase64(selectedFile);
      setStatus("Importing spreadsheet...");
      const result = await api.importSpreadsheet({
        fileName: selectedFile.name,
        contentBase64
      });
      await onImported();
      setStatus(`Imported ${result.importedPlantings} planting${result.importedPlantings === 1 ? "" : "s"} from ${result.parsedRows} parsed row${result.parsedRows === 1 ? "" : "s"}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Spreadsheet import failed.");
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="card">
      <h2>Import crop plan spreadsheet</h2>
      <p className="muted">
        Strict prototype importer: use the exact header row below. It imports planting plans and seed records only, maps rows to existing fields/blocks/beds, and replaces the previous spreadsheet import for this farm.
      </p>
      <form className="form-grid" onSubmit={(event) => void importSpreadsheet(event)}>
        <label className="full-span">
          <span>Spreadsheet file</span>
          <input
            type="file"
            accept=".xlsx,.ods,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.oasis.opendocument.spreadsheet,text/csv"
            onChange={(event) => {
              setSelectedFile(event.target.files?.[0] ?? null);
              setStatus(null);
            }}
          />
        </label>
        <div className="instruction-box full-span">
          <strong>Required header row:</strong>
          <code className="template-header-line">{templateHeaders.join(",")}</code>
          Dates must be YYYY-MM-DD. Spacing numbers are inches. Leave Transplant date, Tray count, and Cells per tray blank for direct-seeded crops. Bed may be blank, but Field and Block must match existing map names.
        </div>
        {status && <p className="muted full-span"><strong>{status}</strong></p>}
        <button className="primary-button full-span" disabled={importing || !selectedFile}>
          {importing ? "Importing..." : "Import spreadsheet"}
        </button>
      </form>
    </div>
  );
}
