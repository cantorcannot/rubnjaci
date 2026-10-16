import { field, isApproved, siteId } from "./kobo.js";

const TYPES = new Set([
  "rubnjak_nedovoljno_spusten_ili_ostecen",
  "biciklisticka_ruta_bez_adekvatne_infrastrukture",
  "pjesacka_infrastruktura_nije_adekvatno_spustena",
  "dobar_primjer"
]);

export function canonicalVrsta(value) {
  const vrsta = String(value ?? "");
  return vrsta === "rubnjak_nije_po_pravilniku" ? "rubnjak_nedovoljno_spusten_ili_ostecen" : vrsta;
}

function coordinates(input) {
  let lon;
  let lat;
  if (typeof input === "string") {
    const parts = input.trim().split(/\s+/);
    if (parts.length < 2) return undefined;
    lat = Number(parts[0]);
    lon = Number(parts[1]);
  } else if (Array.isArray(input) && input.length >= 2) {
    lat = Number(input[0]);
    lon = Number(input[1]);
  } else if (input && typeof input === "object" && input.type === "Point" && Array.isArray(input.coordinates)) {
    [lon, lat] = input.coordinates.map(Number);
  } else {
    return undefined;
  }
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) return undefined;
  return [lon, lat];
}

function text(value, maxLength = 1500) {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function optionalText(value, maxLength = 255) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function validHeight(value) {
  const height = typeof value === "number" ? value : Number(value);
  return Number.isFinite(height) && height >= 0 && height <= 30 ? height : null;
}

export function toGeoJson(rows) {
  const features = rows.flatMap((row) => {
    const vrsta = canonicalVrsta(field(row, ["vrsta"]));
    if (!isApproved(row) || !Number.isSafeInteger(row._id) || row._id <= 0 || !TYPES.has(vrsta)) return [];

    const point = coordinates(field(row, ["lokacija", "location"]));
    const currentSiteId = siteId(row);
    if (!point || !currentSiteId) return [];

    const photo = optionalText(field(row, ["foto_mjerenja"]));
    const context = optionalText(field(row, ["foto_konteksta"]));
    const prefix = `/api/photo/${row._id}`;

    return [{
      type: "Feature",
      id: row._id,
      geometry: { type: "Point", coordinates: point },
      properties: {
        site_id: currentSiteId,
        observation_id: optionalText(row._uuid, 128) ?? String(row._id),
        record_type: optionalText(field(row, ["record_type"]), 32),
        promjena_stanja: optionalText(field(row, ["promjena_stanja"]), 64),
        vrsta,
        visina_cm: validHeight(field(row, ["visina_cm"])),
        komentar: text(field(row, ["komentar"])),
        datum: optionalText(row._submission_time, 80),
        foto_mjerenja: photo ? `${prefix}/foto_mjerenja` : null,
        foto_konteksta: context ? `${prefix}/foto_konteksta` : null
      }
    }];
  });

  return {
    type: "FeatureCollection",
    features,
    meta: { schema_version: 2, generated_at: new Date().toISOString(), feature_count: features.length }
  };
}
