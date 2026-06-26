import { api } from "../api";
import { DashboardData } from "../types";
import { handleForm } from "../form-utils";

export function HarvestForm({ data, onSave }: { data: DashboardData; onSave: () => Promise<void> }) {
  const plantableBeds = data.beds.filter((bed) => bed.source !== "road");

  return (
    <div className="card">
      <h2>Log harvest</h2>
      <form
        className="form-grid"
        onSubmit={(event) =>
          void handleForm(event, async (form) => {
            await api.createHarvest({
              plantingId: Number(form.get("plantingId")),
              bedId: Number(form.get("bedId")),
              harvestDate: String(form.get("harvestDate")),
              quantity: Number(form.get("quantity")),
              unit: String(form.get("unit")),
              notes: String(form.get("notes") || "")
            });
            await onSave();
          })
        }
      >
        <label>
          <span>Planting</span>
          <select name="plantingId">
            {data.plantings.map((planting) => <option key={planting.id} value={planting.id}>{planting.title}</option>)}
          </select>
        </label>
        <label>
          <span>Bed</span>
          <select name="bedId">
            {plantableBeds.map((bed) => <option key={bed.id} value={bed.id}>{bed.name}</option>)}
          </select>
        </label>
        <label><span>Date</span><input name="harvestDate" type="date" required /></label>
        <label><span>Quantity</span><input name="quantity" type="number" step="0.1" required /></label>
        <label>
          <span>Unit</span>
          <select name="unit" defaultValue="lb">
            <option value="lb">lb</option>
            <option value="kg">kg</option>
            <option value="heads">heads</option>
            <option value="bunches">bunches</option>
          </select>
        </label>
        <label className="full-span"><span>Notes</span><textarea name="notes" rows={3} defaultValue="Harvest note" /></label>
        <button className="primary-button full-span">Log harvest</button>
      </form>
    </div>
  );
}
