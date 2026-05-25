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
  link.download = "farmfield-valley-planting-import-template.csv";
  link.click();
  URL.revokeObjectURL(url);
}

// Planner-facing spreadsheet importer. It intentionally supports only one
// strict planting-plan template so users can prepare predictable data before upload.
export function SpreadsheetImportCard({ tutorialActive = false, onImported }: { tutorialActive?: boolean; onImported: () => Promise<void> }) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [replaceExistingImport, setReplaceExistingImport] = useState(false);
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
        contentBase64,
        replaceExistingImport
      });
      await onImported();
      const incompleteMessage = result.incompleteRows > 0
        ? ` ${result.incompleteRows} row${result.incompleteRows === 1 ? "" : "s"} need manual completion.`
        : "";
      setStatus(`${replaceExistingImport ? "Replaced the previous spreadsheet import and imported" : "Added"} ${result.importedPlantings} planting${result.importedPlantings === 1 ? "" : "s"} from ${result.parsedRows} parsed row${result.parsedRows === 1 ? "" : "s"}.${incompleteMessage}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Spreadsheet import failed.");
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className={`card${tutorialActive ? " tutorial-target" : ""}`} data-tutorial-label={tutorialActive ? "Spreadsheet uploader" : undefined}>
      <h2>Import crop plan spreadsheet</h2>
      {tutorialActive && (
        <div className="tutorial-helper-bubble">
          <strong>Tutorial next:</strong> This is the spreadsheet uploader. You do not need to use it now; it is here for importing a prepared crop plan later.
        </div>
      )}
      <p className="muted">
        Strict prototype importer: use the exact header row below. It imports planting plans and seed records only, maps rows to existing fields/blocks/beds, and adds them to the current crop plan.
      </p>
      <form className="form-grid" onSubmit={(event) => void importSpreadsheet(event)}>
        <div className="button-row full-span">
          <button type="button" className="secondary-button" onClick={downloadTemplate}>
            Download CSV template
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
        <div className="instruction-box full-span">
          <strong>Required header row:</strong>
          <code className="template-header-line">{templateHeaders.join(",")}</code>
          Dates must be YYYY-MM-DD. Spacing numbers are inches. Bed length is feet. Bed cover may be blank, plastic mulch, or bare. For direct-seeded crops, you can leave Plant count blank and fill in Bed length instead. Leave Transplant date, Tray count, and Cells per tray blank for direct-seeded crops. If important cells are blank, the row still imports with a red review marker so you can edit it later.
        </div>
        <label className="inline-checkbox full-span">
          <input
            type="checkbox"
            checked={replaceExistingImport}
            onChange={(event) => setReplaceExistingImport(event.target.checked)}
          />
          <span>Replace earlier spreadsheet-imported rows from this farm</span>
        </label>
        {status && <p className="muted full-span"><strong>{status}</strong></p>}
        <button className="primary-button full-span" disabled={importing || !selectedFile}>
          {importing ? "Importing..." : "Import spreadsheet"}
        </button>
      </form>
    </div>
  );
}
