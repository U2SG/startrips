import { addProtocol } from "maplibre-gl";
import { Protocol } from "pmtiles";

// MapLibre's protocol registry is global, so the `pmtiles://` handler is added
// once per page. Remounting the detail map must not register it again: one
// Protocol instance keeps the archive header/directory cache shared.
let registered = false;

export function ensurePmtilesProtocol() {
  if (registered) return;
  addProtocol("pmtiles", new Protocol().tile);
  registered = true;
}
