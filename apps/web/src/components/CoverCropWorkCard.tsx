import { FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import { BlockZone, ZoneActualState } from "../types";
import { formatDate } from "../display-utils";
import { dateInputValue, todayDateInputValue } from "../unit-utils";
import { formatZoneActualStateLabel } from "../planting-display";

const zoneActualStateOptions: ZoneActualState[] = [
  "needs_cleanup",
  "needs_amendment",
  "needs_tillage",
  "ready_for_bed_making",
  "beds_made",
  "partially_planted",
  "fully_planted",
  "cover_crop_established",
  "finished"
];

export function CoverCropWorkCard({
  zone,
  onSave
}: {
  zone: BlockZone;
  onSave: () => Promise<void>;
}) {
  const [actualSeedDate, setActualSeedDate] = useState(dateInputValue(zone.actualCoverCropSeedDate));
  const [actualTerminateDate, setActualTerminateDate] = useState(dateInputValue(zone.actualCoverCropTerminateDate));
  const [actualState, setActualState] = useState<ZoneActualState>(zone.actualState);
  const [notes, setNotes] = useState(zone.notes ?? "");
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setActualSeedDate(dateInputValue(zone.actualCoverCropSeedDate));
    setActualTerminateDate(dateInputValue(zone.actualCoverCropTerminateDate));
    setActualState(zone.actualState);
    setNotes(zone.notes ?? "");
    setStatus(null);
  }, [zone]);

  async function saveCoverCropWork(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (actualSeedDate && actualSeedDate > todayDateInputValue()) {
      setStatus("Actual seeded date cannot be in the future.");
      return;
    }
    if (actualTerminateDate && actualTerminateDate > todayDateInputValue()) {
      setStatus("Actual termination date cannot be in the future.");
      return;
    }

    try {
      setSaving(true);
      setStatus("Saving cover crop record...");
      await api.updateCoverCropWork(zone.id, {
        actualState,
        actualCoverCropSeedDate: actualSeedDate || null,
        actualCoverCropTerminateDate: actualTerminateDate || null,
        notes: notes.trim() || null
      });
      await onSave();
      setStatus("Cover crop record saved.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save cover crop record.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <h2>Cover crop record</h2>
      <p className="muted">{zone.coverCropName ?? zone.name} in {zone.blockName}</p>
      <dl className="detail-list">
        <div><dt>Planned seeding date</dt><dd>{formatDate(zone.plannedCoverCropSeedDate)}</dd></div>
        <div><dt>Planned termination date</dt><dd>{formatDate(zone.plannedCoverCropTerminateDate)}</dd></div>
      </dl>
      {status && <p className="muted"><strong>{status}</strong></p>}
      <form className="form-grid" onSubmit={(event) => void saveCoverCropWork(event)}>
        <label>
          <span>Actual seeded date</span>
          <input type="date" value={actualSeedDate} onChange={(event) => setActualSeedDate(event.target.value)} />
        </label>
        <label>
          <span>Actual termination date</span>
          <input type="date" value={actualTerminateDate} onChange={(event) => setActualTerminateDate(event.target.value)} />
        </label>
        <label>
          <span>Current use</span>
          <select value={actualState} onChange={(event) => setActualState(event.target.value as ZoneActualState)}>
            {zoneActualStateOptions.map((option) => <option key={option} value={option}>{formatZoneActualStateLabel(option)}</option>)}
          </select>
        </label>
        <div className="button-row">
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setActualSeedDate(todayDateInputValue());
              setActualState("cover_crop_established");
            }}
          >
            Seeded today
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setActualTerminateDate(todayDateInputValue());
              setActualState("finished");
            }}
          >
            Terminated today
          </button>
        </div>
        <label className="full-span">
          <span>Notes</span>
          <textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </label>
        <button type="submit" className="primary-button full-span" disabled={saving}>
          {saving ? "Saving..." : "Save cover crop record"}
        </button>
      </form>
    </div>
  );
}
