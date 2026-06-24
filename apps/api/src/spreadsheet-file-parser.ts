import { execFileSync } from "node:child_process";
import fs from "node:fs";

export type SpreadsheetRow = {
  sheet: string;
  rowIndex: number;
  cells: string[];
};

// Dependency-free spreadsheet reader. Python stdlib reads xlsx/ods zip/xml
// contents and returns raw cell strings; TypeScript does the template checks.
const genericSpreadsheetParser = String.raw`
import csv
import json
import sys
import zipfile
import xml.etree.ElementTree as ET

ODS_NS = {
    "table": "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
    "text": "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
}
XLSX_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
XLSX_REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"

def ods_cell_text(cell):
    parts = []
    for paragraph in cell.findall("text:p", ODS_NS):
        text = "".join(paragraph.itertext()).strip()
        if text:
            parts.append(text)
    return " ".join(parts).strip()

def parse_ods(filename):
    rows = []
    with zipfile.ZipFile(filename) as archive:
        content = archive.read("content.xml")
    root = ET.fromstring(content)
    for sheet in root.findall(".//table:table", ODS_NS):
        sheet_name = sheet.attrib.get("{" + ODS_NS["table"] + "}name", "Sheet")
        for row_index, row in enumerate(sheet.findall("table:table-row", ODS_NS), start=1):
            cells = []
            for cell in row:
                if not cell.tag.endswith("table-cell"):
                    continue
                repeated = int(cell.attrib.get("{" + ODS_NS["table"] + "}number-columns-repeated", "1"))
                value = ods_cell_text(cell)
                for _ in range(min(repeated, 80 - len(cells))):
                    cells.append(value)
                if len(cells) >= 80:
                    break
            if any(cells):
                rows.append({"sheet": sheet_name, "rowIndex": row_index, "cells": cells})
    return rows

def xlsx_column_index(cell_ref):
    letters = "".join(ch for ch in cell_ref if ch.isalpha())
    index = 0
    for char in letters:
        index = index * 26 + ord(char.upper()) - 64
    return max(0, index - 1)

def xlsx_cell_text(cell, shared_strings):
    cell_type = cell.attrib.get("t")
    if cell_type == "inlineStr":
        inline = cell.find(XLSX_NS + "is")
        return "" if inline is None else "".join(inline.itertext()).strip()
    value = cell.find(XLSX_NS + "v")
    text = "" if value is None or value.text is None else value.text.strip()
    if cell_type == "s" and text:
        return shared_strings[int(text)]
    return text

def parse_xlsx(filename):
    rows = []
    with zipfile.ZipFile(filename) as archive:
        names = set(archive.namelist())
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        rel_map = {rel.attrib["Id"]: rel.attrib["Target"] for rel in rels}
        shared_strings = []
        if "xl/sharedStrings.xml" in names:
            shared_root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            for item in shared_root.findall(XLSX_NS + "si"):
                shared_strings.append("".join(item.itertext()).strip())
        sheets = workbook.find(XLSX_NS + "sheets")
        if sheets is None:
            return rows
        for sheet in sheets:
            sheet_name = sheet.attrib.get("name", "Sheet")
            rel_id = sheet.attrib.get(XLSX_REL_NS + "id")
            target = rel_map.get(rel_id, "")
            if target.startswith("/"):
                sheet_path = target.lstrip("/")
            elif target.startswith("xl/"):
                sheet_path = target
            else:
                sheet_path = "xl/" + target
            if sheet_path not in names:
                continue
            sheet_root = ET.fromstring(archive.read(sheet_path))
            for row in sheet_root.findall(".//" + XLSX_NS + "row"):
                cells = []
                for cell in row.findall(XLSX_NS + "c"):
                    column_index = xlsx_column_index(cell.attrib.get("r", "A1"))
                    while len(cells) < column_index:
                        cells.append("")
                    cells.append(xlsx_cell_text(cell, shared_strings))
                    if len(cells) >= 80:
                        break
                if any(cells):
                    rows.append({"sheet": sheet_name, "rowIndex": int(float(row.attrib.get("r", "0"))), "cells": cells})
    return rows

def parse_csv(filename):
    rows = []
    with open(filename, newline="", encoding="utf-8-sig") as handle:
        for row_index, row in enumerate(csv.reader(handle), start=1):
            cells = [cell.strip() for cell in row]
            if any(cells):
                rows.append({"sheet": "CSV", "rowIndex": row_index, "cells": cells})
    return rows

rows = []
for filename in sys.argv[1:]:
    lower = filename.lower()
    if lower.endswith(".xlsx"):
        rows.extend(parse_xlsx(filename))
    elif lower.endswith(".ods"):
        rows.extend(parse_ods(filename))
    elif lower.endswith(".csv"):
        rows.extend(parse_csv(filename))
print(json.dumps(rows))
`;

export function supportedPlantingSpreadsheetExtension(fileName: string) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".xlsx")) return ".xlsx";
  if (lower.endsWith(".ods")) return ".ods";
  if (lower.endsWith(".csv")) return ".csv";
  throw new Error("Spreadsheet upload must be an .xlsx, .ods, or .csv file");
}

export function parsePlantingSpreadsheetFiles(files: string[]) {
  if (files.length === 0) {
    throw new Error("No planting spreadsheet file was provided");
  }
  for (const file of files) {
    if (!fs.existsSync(file)) {
      throw new Error(`Missing spreadsheet: ${file}`);
    }
  }

  const output = execFileSync("python3", ["-c", genericSpreadsheetParser, ...files], {
    encoding: "utf8",
    maxBuffer: 80 * 1024 * 1024
  });
  return JSON.parse(output) as SpreadsheetRow[];
}

