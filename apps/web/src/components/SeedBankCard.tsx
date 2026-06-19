import { FormEvent, useMemo, useState } from "react";
import { api } from "../api";
import { DashboardData, SeedItem } from "../types";
import { MobileListLimiter } from "./MobileListLimiter";

type SeedLotDraft = {
  lotNumber: string;
  stockQuantity: string;
};

type SeedDraft = {
  family: string;
  cropType: string;
  varietyName: string;
  breedName: string;
  supplier: string;
  catalogNumber: string;
  lots: SeedLotDraft[];
  daysToMaturity: string;
};

const emptyDraft: SeedDraft = {
  family: "",
  cropType: "",
  varietyName: "",
  breedName: "",
  supplier: "",
  catalogNumber: "",
  lots: [],
  daysToMaturity: ""
};

function seedToDraft(seed: SeedItem): SeedDraft {
  return {
    family: seed.family ?? "",
    cropType: seed.cropType,
    varietyName: seed.varietyName ?? "",
    breedName: seed.breedName ?? "",
    supplier: seed.supplier ?? "",
    catalogNumber: seed.catalogNumber ?? "",
    lots: seed.lots.length > 0
      ? seed.lots.map((lot) => ({
          lotNumber: lot.lotNumber,
          stockQuantity: lot.stockQuantity == null ? "" : String(lot.stockQuantity)
        }))
      : seed.lotNumber
        ? [{ lotNumber: seed.lotNumber, stockQuantity: seed.stockQuantity == null ? "" : String(seed.stockQuantity) }]
        : [],
    daysToMaturity: seed.daysToMaturity == null ? "" : String(seed.daysToMaturity)
  };
}

function parseStockQuantity(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return { value: null };
  }

  const normalized = trimmed.replace(/,/g, "");
  if (!/^\d+(?:\s*\+\s*\d+)*$/.test(normalized)) {
    return { value: null, error: "Stock must be a whole number or addition like 2000+2000+1000." };
  }

  const total = normalized
    .split("+")
    .map((part) => Number(part.trim()))
    .reduce((sum, part) => sum + part, 0);
  if (!Number.isSafeInteger(total) || total > 2147483647) {
    return { value: null, error: "Stock is too large." };
  }
  return { value: total };
}

function normalizedLotPayload(lots: SeedLotDraft[]) {
  return lots
    .map((lot) => ({
      lotNumber: lot.lotNumber.trim(),
      stockQuantity: parseStockQuantity(lot.stockQuantity).value
    }))
    .filter((lot) => lot.lotNumber || lot.stockQuantity != null);
}

function seedPayload(farmId: number, draft: SeedDraft) {
  return {
    farmId,
    family: draft.family.trim() || null,
    cropType: draft.cropType.trim(),
    varietyName: draft.varietyName.trim() || null,
    breedName: draft.breedName.trim() || null,
    supplier: draft.supplier.trim() || null,
    catalogNumber: draft.catalogNumber.trim() || null,
    lots: normalizedLotPayload(draft.lots),
    daysToMaturity: draft.daysToMaturity.trim() ? Number(draft.daysToMaturity) : null
  };
}

export function SeedBankCard({
  data,
  canPlan,
  onSave
}: {
  data: DashboardData;
  canPlan: boolean;
  onSave: () => Promise<void>;
}) {
  const farmId = data.farm?.id ?? null;
  const [showArchived, setShowArchived] = useState(false);
  const [showInStockOnly, setShowInStockOnly] = useState(false);
  const [editingSeedId, setEditingSeedId] = useState<number | null>(null);
  const [addDraft, setAddDraft] = useState<SeedDraft>(emptyDraft);
  const [editDraft, setEditDraft] = useState<SeedDraft>(emptyDraft);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const seedItems = useMemo(
    () => data.seedItems.filter((seed) => seed.farmId === farmId),
    [data.seedItems, farmId]
  );
  const visibleSeeds = seedItems.filter((seed) => {
    if (!showArchived && seed.archivedAt != null) {
      return false;
    }
    if (showInStockOnly && !(seed.stockQuantity != null && seed.stockQuantity > 0)) {
      return false;
    }
    return true;
  });
  const plantingCountsBySeed = useMemo(() => {
    const counts = new Map<number, number>();
    for (const planting of data.plantings) {
      if (planting.seedItemId != null) {
        counts.set(planting.seedItemId, (counts.get(planting.seedItemId) ?? 0) + 1);
      }
    }
    return counts;
  }, [data.plantings]);

  function updateAddDraft(field: keyof SeedDraft, value: string) {
    setAddDraft((current) => ({ ...current, [field]: value }));
  }

  function updateEditDraft(field: keyof SeedDraft, value: string) {
    setEditDraft((current) => ({ ...current, [field]: value }));
  }

  function updateLot(draftKind: "add" | "edit", index: number, field: keyof SeedLotDraft, value: string) {
    const updater = draftKind === "add" ? setAddDraft : setEditDraft;
    updater((current) => ({
      ...current,
      lots: current.lots.map((lot, lotIndex) => lotIndex === index ? { ...lot, [field]: value } : lot)
    }));
  }

  function addLot(draftKind: "add" | "edit") {
    const updater = draftKind === "add" ? setAddDraft : setEditDraft;
    updater((current) => ({
      ...current,
      lots: [...current.lots, { lotNumber: "", stockQuantity: "" }]
    }));
  }

  function removeLot(draftKind: "add" | "edit", index: number) {
    const updater = draftKind === "add" ? setAddDraft : setEditDraft;
    updater((current) => ({
      ...current,
      lots: current.lots.filter((_, lotIndex) => lotIndex !== index)
    }));
  }

  function validateSeedDraft(currentDraft: SeedDraft) {
    if (!currentDraft.cropType.trim()) {
      return "Crop is required.";
    }
    if (currentDraft.daysToMaturity.trim()) {
      const daysToMaturity = Number(currentDraft.daysToMaturity);
      if (!Number.isInteger(daysToMaturity) || daysToMaturity <= 0) {
        return "Days to maturity must be a whole number above zero.";
      }
    }
    const seenLots = new Set<string>();
    for (const lot of currentDraft.lots) {
      const lotNumber = lot.lotNumber.trim();
      const stockQuantity = parseStockQuantity(lot.stockQuantity);
      if (stockQuantity.error) {
        return stockQuantity.error;
      }
      if (!lotNumber && stockQuantity.value != null) {
        return "Lot number is required when stock is entered.";
      }
      if (lotNumber) {
        const key = lotNumber.toLowerCase();
        if (seenLots.has(key)) {
          return `Duplicate lot number: ${lotNumber}`;
        }
        seenLots.add(key);
      }
    }
    return null;
  }

  async function saveNewSeed(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canPlan || farmId == null) {
      return;
    }
    const validationError = validateSeedDraft(addDraft);
    if (validationError) {
      setStatus(validationError);
      return;
    }
    try {
      setSaving(true);
      setStatus("Adding seed record...");
      await api.createSeedItem(seedPayload(farmId, addDraft));
      setAddDraft(emptyDraft);
      await onSave();
      setStatus(null);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Seed record could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  function startEditingSeed(seed: SeedItem) {
    setEditingSeedId(seed.id);
    setEditDraft(seedToDraft(seed));
    setStatus(null);
  }

  function cancelEditingSeed() {
    setEditingSeedId(null);
    setEditDraft(emptyDraft);
    setStatus(null);
  }

  async function saveEditedSeed(seed: SeedItem) {
    if (!canPlan || farmId == null) {
      return;
    }
    const validationError = validateSeedDraft(editDraft);
    if (validationError) {
      setStatus(validationError);
      return;
    }
    try {
      setSaving(true);
      setStatus("Saving seed record...");
      await api.updateSeedItem(seed.id, seedPayload(farmId, editDraft));
      setEditingSeedId(null);
      setEditDraft(emptyDraft);
      await onSave();
      setStatus(null);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Seed record could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  async function archiveSeed(seed: SeedItem) {
    if (!canPlan) {
      return;
    }
    try {
      setStatus(seed.archivedAt == null ? "Archiving seed record..." : "Restoring seed record...");
      if (seed.archivedAt == null) {
        await api.archiveSeedItem(seed.id);
        if (editingSeedId === seed.id) {
          setEditingSeedId(null);
        }
      } else {
        await api.restoreSeedItem(seed.id);
      }
      await onSave();
      setStatus(null);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Seed record could not be changed.");
    }
  }

  function renderLotEditor(draftKind: "add" | "edit", lots: SeedLotDraft[]) {
    return (
      <div className="seed-lot-editor full-span">
        <div className="seed-lot-header">
          <span>Lots</span>
          <button type="button" className="secondary-button compact-button" onClick={() => addLot(draftKind)}>
            Add lot
          </button>
        </div>
        {lots.length === 0 ? (
          <p className="muted">No lots entered.</p>
        ) : (
          <div className="seed-lot-list">
            {lots.map((lot, index) => (
              <div className="seed-lot-row" key={index}>
                <label>
                  <span>Lot number</span>
                  <input value={lot.lotNumber} onChange={(event) => updateLot(draftKind, index, "lotNumber", event.target.value)} maxLength={160} />
                </label>
                <label>
                  <span>Stock</span>
                  <input value={lot.stockQuantity} onChange={(event) => updateLot(draftKind, index, "stockQuantity", event.target.value)} />
                </label>
                <button type="button" className="secondary-button compact-button" onClick={() => removeLot(draftKind, index)}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <section className="content-grid split-grid">
      <div className="card">
        <div className="section-header">
          <div className="title-block">
            <h2>Seed Bank</h2>
            <p className="muted">{seedItems.filter((seed) => seed.archivedAt == null).length} active records</p>
          </div>
          <div className="seed-bank-filter-row">
            <label className="inline-checkbox seed-bank-archive-toggle">
              <input type="checkbox" checked={showInStockOnly} onChange={(event) => setShowInStockOnly(event.target.checked)} />
              <span>In stock</span>
            </label>
            <label className="inline-checkbox seed-bank-archive-toggle">
              <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
              <span>Show archived</span>
            </label>
          </div>
        </div>
        {status && <p className="muted"><strong>{status}</strong></p>}
        {visibleSeeds.length === 0 ? (
          <p className="muted">No seed records yet.</p>
        ) : (
          <MobileListLimiter itemCount={visibleSeeds.length} itemLabel="seed records" forceExpanded={editingSeedId != null}>
            <table className="data-table seed-bank-table">
            <thead>
              <tr>
                <th>Seed</th>
                <th>Supplier</th>
                <th>Stock</th>
                <th>Maturity</th>
                <th>Plan links</th>
                <th>Status</th>
                {canPlan && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {visibleSeeds.map((seed) => (
                editingSeedId === seed.id ? (
                  <tr key={seed.id}>
                    <td colSpan={canPlan ? 7 : 6}>
                      <div className="seed-bank-inline-editor">
                        <div className="form-grid">
                          <label>
                            <span>Crop</span>
                            <input value={editDraft.cropType} onChange={(event) => updateEditDraft("cropType", event.target.value)} required />
                          </label>
                          <label>
                            <span>Variety</span>
                            <input value={editDraft.varietyName} onChange={(event) => updateEditDraft("varietyName", event.target.value)} />
                          </label>
                          <label>
                            <span>Family</span>
                            <input value={editDraft.family} onChange={(event) => updateEditDraft("family", event.target.value)} />
                          </label>
                          <label>
                            <span>Breed/type</span>
                            <input value={editDraft.breedName} onChange={(event) => updateEditDraft("breedName", event.target.value)} />
                          </label>
                          <label>
                            <span>Supplier</span>
                            <input value={editDraft.supplier} onChange={(event) => updateEditDraft("supplier", event.target.value)} />
                          </label>
                          <label>
                            <span>Catalog number</span>
                            <input value={editDraft.catalogNumber} onChange={(event) => updateEditDraft("catalogNumber", event.target.value)} />
                          </label>
                          <label>
                            <span>Days to maturity</span>
                            <input
                              type="number"
                              min="1"
                              step="1"
                              value={editDraft.daysToMaturity}
                              onChange={(event) => updateEditDraft("daysToMaturity", event.target.value)}
                            />
                          </label>
                          {renderLotEditor("edit", editDraft.lots)}
                        </div>
                        <div className="button-row seed-bank-actions">
                          <button type="button" className="primary-button compact-button" onClick={() => void saveEditedSeed(seed)} disabled={saving}>
                            Save
                          </button>
                          <button type="button" className="secondary-button compact-button" onClick={cancelEditingSeed} disabled={saving}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr key={seed.id}>
                    <td>
                      <strong>{seed.cropType}{seed.varietyName ? ` / ${seed.varietyName}` : ""}</strong>
                      <div className="table-subtle">{[seed.family, seed.breedName].filter(Boolean).join(" / ") || "—"}</div>
                    </td>
                    <td>{seed.supplier || "—"}</td>
                    <td>{seed.stockQuantity == null ? "—" : seed.stockQuantity.toLocaleString()}</td>
                    <td>{seed.daysToMaturity == null ? "—" : `${seed.daysToMaturity} days`}</td>
                    <td>{plantingCountsBySeed.get(seed.id) ?? 0}</td>
                    <td><span className="status-pill">{seed.archivedAt == null ? "Active" : "Archived"}</span></td>
                    {canPlan && (
                      <td>
                        <div className="button-row seed-bank-actions">
                          <button type="button" className="secondary-button compact-button" onClick={() => startEditingSeed(seed)}>
                            Edit
                          </button>
                          <button type="button" className={seed.archivedAt == null ? "danger-button compact-button" : "secondary-button compact-button"} onClick={() => void archiveSeed(seed)}>
                            {seed.archivedAt == null ? "Archive" : "Restore"}
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                )
              ))}
            </tbody>
            </table>
          </MobileListLimiter>
        )}
      </div>
      <div className="card">
        <div className="section-header">
          <h2>Add seed</h2>
        </div>
        {canPlan ? (
          <form className="form-grid" onSubmit={(event) => void saveNewSeed(event)}>
            <label>
              <span>Crop</span>
              <input value={addDraft.cropType} onChange={(event) => updateAddDraft("cropType", event.target.value)} required />
            </label>
            <label>
              <span>Variety</span>
              <input value={addDraft.varietyName} onChange={(event) => updateAddDraft("varietyName", event.target.value)} />
            </label>
            <label>
              <span>Family</span>
              <input value={addDraft.family} onChange={(event) => updateAddDraft("family", event.target.value)} />
            </label>
            <label>
              <span>Breed/type</span>
              <input value={addDraft.breedName} onChange={(event) => updateAddDraft("breedName", event.target.value)} />
            </label>
            <label>
              <span>Supplier</span>
              <input value={addDraft.supplier} onChange={(event) => updateAddDraft("supplier", event.target.value)} />
            </label>
            <label>
              <span>Catalog number</span>
              <input value={addDraft.catalogNumber} onChange={(event) => updateAddDraft("catalogNumber", event.target.value)} />
            </label>
            <label>
              <span>Days to maturity</span>
              <input
                type="number"
                min="1"
                step="1"
                value={addDraft.daysToMaturity}
                onChange={(event) => updateAddDraft("daysToMaturity", event.target.value)}
              />
            </label>
            {renderLotEditor("add", addDraft.lots)}
            <button type="submit" className="primary-button full-span" disabled={saving}>
              {saving ? "Saving..." : "Add seed"}
            </button>
          </form>
        ) : (
          <p className="muted">Worker accounts can view seed records but cannot change them.</p>
        )}
      </div>
    </section>
  );
}
