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
  "Bed length (ft)",
  "Transplant date",
  "Tray count",
  "Cells per tray",
  "Days to harvest",
  "Field spacing in row",
  "Row spacing",
  "Rows per bed",
  "Bed cover (plastic mulch/bare)",
  "Field",
  "Block",
  "Bed",
  "Notes"
];

const templateExampleRow = [
  "Johnny's",
  "Lettuce",
  "Salanova Green",
  "2712G",
  "2026-03-15",
  "256",
  "",
  "2026-04-20",
  "2",
  "128",
  "55",
  "10",
  "12",
  "4",
  "plastic mulch",
  "East Field",
  "B1",
  "Bed 1",
  "Example row: replace field, block, and bed names with names already on your map."
];

function csvCell(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function downloadTemplate() {
  const csv = [
    templateHeaders.map(csvCell).join(","),
    templateExampleRow.map(csvCell).join(",")
  ].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "loam-ledger-planting-import-template.csv";
  link.click();
  URL.revokeObjectURL(url);
}

// Planner-facing spreadsheet importer. It intentionally supports only one
// strict planting-plan template so users can prepare predictable data before upload.
export function SpreadsheetImportCard({ tutorialActive = false, onImported }: { tutorialActive?: boolean; onImported: () => Promise<void> }) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);

  async function importSpreadsheet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedFile) {
      setStatus("Choose an .xlsx, .ods, or .csv file first.");
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
      const incompleteMessage = result.incompleteRows > 0
        ? ` ${result.incompleteRows} row${result.incompleteRows === 1 ? "" : "s"} need manual completion.`
        : "";
      const importedMapItems = (result.importedFields ?? 0) + (result.importedBlocks ?? 0) + (result.importedBeds ?? 0);
      const duplicateMapItems = (result.skippedDuplicateFields ?? 0) + (result.skippedDuplicateBlocks ?? 0) + (result.skippedDuplicateBeds ?? 0);
      const backupMessage = importedMapItems > 0 || duplicateMapItems > 0 || (result.importedRecords ?? 0) > 0 || (result.importedVehicles ?? 0) > 0
        ? ` Imported ${importedMapItems} map item${importedMapItems === 1 ? "" : "s"}, ${result.importedVehicles ?? 0} vehicle${(result.importedVehicles ?? 0) === 1 ? "" : "s"}, and ${result.importedRecords ?? 0} related record${(result.importedRecords ?? 0) === 1 ? "" : "s"}. Skipped ${duplicateMapItems} duplicate map item${duplicateMapItems === 1 ? "" : "s"}.`
        : "";
      const skippedMessage = result.skippedRows > 0
        ? ` Skipped ${result.skippedRows} row${result.skippedRows === 1 ? "" : "s"} that could not be safely restored.`
        : "";
      const warningMessage = result.warnings && result.warnings.length > 0
        ? ` ${result.warnings.slice(0, 3).join(" ")}${result.warnings.length > 3 ? " Skipped-row details are in the server response." : ""}`
        : "";
      setStatus(`Added ${result.importedPlantings} planting(s) from ${result.parsedRows} row(s).${backupMessage}${incompleteMessage}${skippedMessage}${warningMessage}`);
      await onImported();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Spreadsheet import failed.");
    } finally {
      setImporting(false);
    }
  }

  async function exportSpreadsheet() {
    try {
      setExporting(true);
      setStatus("Building export...");
      const { blob, filename } = await api.exportSpreadsheet();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
      setStatus("Export downloaded.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Spreadsheet export failed.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className={`card${tutorialActive ? " tutorial-target" : ""}`} data-tutorial-label={tutorialActive ? "Spreadsheet import/export" : undefined}>
      <h2>Spreadsheet import/export</h2>
      {tutorialActive && (
        <div className="tutorial-helper-bubble">
          <strong>Tutorial next:</strong> This is the spreadsheet import and export area. You do not need to use it now; it is here for importing a prepared crop plan or downloading a farm backup later.
        </div>
      )}
      <p className="muted">
        Upload your crop plan spreadsheet in the template format. Do not change the header row. The sample row will not import unless you edit it. Uploader will also accept farm backups
      </p>
      <form className="form-grid" onSubmit={(event) => void importSpreadsheet(event)}>
        <div className="button-row full-span">
          <button type="button" className="secondary-button" onClick={downloadTemplate}>
            Download template
          </button>
        </div>
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
        {status && <p className="muted full-span"><strong>{status}</strong></p>}
        <button className="primary-button full-span" disabled={importing || !selectedFile}>
          {importing ? "Importing..." : "Import spreadsheet"}
        </button>
        <div className="instruction-box full-span">
          Export Farm downloads a backup of farm map data, bed presets, seed records, vehicles, crop plans, task flows, tasks, harvests, and event history. Importing that backup into a new account restores records that match existing map items and plantings.
        </div>
        <button type="button" className="primary-button full-span" onClick={() => void exportSpreadsheet()} disabled={exporting || importing}>
          {exporting ? "Exporting..." : "Export farm backup"}
        </button>
      </form>
    </div>
  );
}
