import { Bed } from "../types";
import { MobileListLimiter } from "./MobileListLimiter";

export function WorkBedPicker({
  beds,
  selectedBedIds,
  bedPickActive,
  pickLabel,
  pickingLabel,
  onBedPickActiveChange,
  onSelectedBedIdsChange
}: {
  beds: Bed[];
  selectedBedIds: number[];
  bedPickActive: boolean;
  pickLabel: string;
  pickingLabel: string;
  onBedPickActiveChange: (active: boolean) => void;
  onSelectedBedIdsChange: (bedIds: number[]) => void;
}) {
  const plasticBedIds = beds
    .filter((item) => (item.bedPresetName ?? item.name).toLowerCase().includes("plastic"))
    .map((item) => item.id);
  const bareBedIds = beds
    .filter((item) => !plasticBedIds.includes(item.id))
    .map((item) => item.id);
  const selectedBedIdSet = new Set(selectedBedIds);

  return (
    <div className="full-span stack">
      <div className="button-row">
        <button
          type="button"
          className={bedPickActive ? "primary-button" : "secondary-button"}
          onClick={() => onBedPickActiveChange(!bedPickActive)}
        >
          {bedPickActive ? pickingLabel : pickLabel}
        </button>
        <button type="button" className="secondary-button" onClick={() => onSelectedBedIdsChange(bareBedIds)}>
          All bare beds
        </button>
        <button type="button" className="secondary-button" onClick={() => onSelectedBedIdsChange(plasticBedIds)}>
          All plastic beds
        </button>
        <button type="button" className="secondary-button" onClick={() => onSelectedBedIdsChange([])}>
          Clear beds
        </button>
      </div>
      <p className="muted">{selectedBedIds.length} bed{selectedBedIds.length === 1 ? "" : "s"} selected.</p>
      {beds.length > 0 && (
        <MobileListLimiter itemCount={beds.length} itemLabel="beds">
          <div className="checkbox-grid">
            {beds.map((item) => (
              <label className="inline-checkbox" key={item.id}>
                <input
                  type="checkbox"
                  checked={selectedBedIdSet.has(item.id)}
                  onChange={(event) => {
                    if (event.target.checked) {
                      onSelectedBedIdsChange([...selectedBedIds, item.id]);
                    } else {
                      onSelectedBedIdsChange(selectedBedIds.filter((bedId) => bedId !== item.id));
                    }
                  }}
                />
                <span>{item.name}{item.bedPresetName ? ` (${item.bedPresetName})` : ""}</span>
              </label>
            ))}
          </div>
        </MobileListLimiter>
      )}
    </div>
  );
}
