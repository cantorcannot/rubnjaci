import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { allSubmissions, attachmentUrl, isApproved, koboAttachmentGet, submission } from "./kobo.js";
import { toGeoJson } from "./geojson.js";

const CACHE_FILE = resolve("var/cache/rubnjaci.json");
const COORDINATE = /^-?\d{1,3}(?:\.\d{1,7})?$/;
const SITE_ID = /^[a-z0-9][a-z0-9:_-]{2,127}$/i;
const ALLOWED_PHOTO_FIELDS = new Set(["foto_mjerenja", "foto_konteksta"]);
const HALF_WORLD = 20037508.342789244;

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  if (body === null || body === undefined) return res.end();
  res.end(body);
}

function json(res, status, value, headers = {}) {
  send(res, status, JSON.stringify(value), { "Content-Type": "application/json; charset=utf-8", ...headers });
}

async function readStale() {
  try { return await readFile(CACHE_FILE, "utf8"); } catch { return null; }
}

async function writeStale(body) {
  try {
    await mkdir(dirname(CACHE_FILE), { recursive: true });
    await writeFile(CACHE_FILE, body, "utf8");
  } catch (error) {
    console.warn("Could not write stale Kobo cache:", error.message);
  }
}

export async function rubnjaci(env, res) {
  try {
    const body = JSON.stringify(toGeoJson(await allSubmissions(env)));
    void writeStale(body);
    send(res, 200, body, {
      "Content-Type": "application/geo+json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Rubnjaci-Source": "kobo"
    });
  } catch (error) {
    console.error("Kobo GeoJSON failed", error);
    const stale = await readStale();
    if (stale) {
      return send(res, 200, stale, {
        "Content-Type": "application/geo+json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Rubnjaci-Source": "stale",
        Warning: '110 - "Privremeno se prikazuje zadnja spremljena verzija podataka"'
      });
    }
    json(res, 503, { error: "Prijave trenutačno nisu dostupne." }, { "Cache-Control": "no-store" });
  }
}

function validCoordinates(latInput, lonInput) {
  if (latInput === null && lonInput === null) return null;
  if (!latInput || !lonInput || !COORDINATE.test(latInput) || !COORDINATE.test(lonInput)) throw new Error("invalid_coordinates");
  const lat = Number(latInput);
  const lon = Number(lonInput);
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) throw new Error("invalid_coordinates");
  return [lat, lon];
}

function latestSiteFeature(features, wantedSiteId) {
  return features
    .filter((feature) => feature.properties.site_id === wantedSiteId)
    .sort((a, b) => new Date(b.properties.datum || 0).valueOf() - new Date(a.properties.datum || 0).valueOf())[0];
}

export async function prijavi(env, requestUrl, res) {
  try {
    const target = new URL(env.KOBO_PUBLIC_FORM_URL);
    if (target.protocol !== "https:" || target.username || target.password) throw new Error("invalid_report_url");

    const siteId = requestUrl.searchParams.get("site_id")?.trim() || "";
    const recordType = requestUrl.searchParams.get("record_type")?.trim() || "";
    if (siteId && !SITE_ID.test(siteId)) return send(res, 400, "Neispravna oznaka lokacije.", { "Content-Type": "text/plain; charset=utf-8" });
    if (recordType && recordType !== "new" && recordType !== "update") return send(res, 400, "Neispravna vrsta zapisa.", { "Content-Type": "text/plain; charset=utf-8" });
    if (recordType === "update" && !siteId) return send(res, 400, "Nedostaje oznaka lokacije.", { "Content-Type": "text/plain; charset=utf-8" });

    if (recordType === "update") {
      const feature = latestSiteFeature(toGeoJson(await allSubmissions(env)).features, siteId);
      if (!feature) return send(res, 404, "Lokacija nije pronađena.", { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      const [lon, lat] = feature.geometry.coordinates;
      target.searchParams.set("d[lokacija]", `${lat} ${lon} 0 0`);
      target.searchParams.set("d[vrsta]", feature.properties.vrsta);
      target.searchParams.set("d[site_id]", siteId);
      target.searchParams.set("d[record_type]", "update");
      const returnUrl = new URL(requestUrl.origin);
      returnUrl.hash = `lokacija=${encodeURIComponent(siteId)}`;
      target.searchParams.set("return_url", returnUrl.toString());
    } else {
      const coordinates = validCoordinates(requestUrl.searchParams.get("lat"), requestUrl.searchParams.get("lon"));
      if (coordinates) target.searchParams.set("d[lokacija]", `${coordinates[0]} ${coordinates[1]} 0 0`);
      if (siteId) target.searchParams.set("d[site_id]", siteId);
      if (recordType) target.searchParams.set("d[record_type]", recordType);
    }

    res.writeHead(302, {
      Location: target.toString().replace(/\+/g, "%20"),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer"
    });
    res.end();
  } catch (error) {
    if (error.message === "invalid_coordinates") return send(res, 400, "Neispravna lokacija.", { "Content-Type": "text/plain; charset=utf-8" });
    console.error("Kobo report redirect failed", error);
    send(res, 503, "Poveznica za prijavu trenutačno nije dostupna.", { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  }
}

export async function photo(env, idText, fieldName, res) {
  const id = Number(idText);
  if (!/^\d+$/.test(idText) || !Number.isSafeInteger(id) || id <= 0 || !ALLOWED_PHOTO_FIELDS.has(fieldName)) {
    return send(res, 404, "Fotografija nije pronađena.", { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  }

  try {
    const row = await submission(env, id);
    if (!row || !isApproved(row)) return send(res, 404, "Fotografija nije pronađena.", { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    const source = attachmentUrl(env, row, fieldName);
    if (!source) return send(res, 404, "Fotografija nije pronađena.", { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });

    const upstream = await koboAttachmentGet(env, source);
    const contentType = upstream.headers.get("Content-Type") || "";
    if (!contentType.toLowerCase().startsWith("image/")) return send(res, 415, "Datoteka nije slika.", { "Content-Type": "text/plain; charset=utf-8" });
    const body = Buffer.from(await upstream.arrayBuffer());
    send(res, 200, body, {
      "Content-Type": contentType,
      "Content-Length": String(body.length),
      "Cache-Control": "public, max-age=3600"
    });
  } catch (error) {
    console.error("Kobo photo failed", error);
    send(res, 503, "Fotografija trenutačno nije dostupna.", { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  }
}

function bbox3857(z, x, y) {
  const tiles = 2 ** z;
  const span = (2 * HALF_WORLD) / tiles;
  const minX = -HALF_WORLD + x * span;
  const maxX = minX + span;
  const maxY = HALF_WORLD - y * span;
  const minY = maxY - span;
  return [minX, minY, maxX, maxY].join(",");
}

export async function ortho(env, zText, xText, yText, res) {
  const z = Number(zText);
  const x = Number(xText);
  const y = Number(yText);
  const limit = Number.isSafeInteger(z) ? 2 ** z : 0;
  if (![z, x, y].every(Number.isSafeInteger) || z < 6 || z > 19 || x < 0 || y < 0 || x >= limit || y >= limit) {
    return send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  }

  try {
    const url = new URL(env.DGU_ORTHO_WMS_URL);
    if (url.protocol !== "https:") throw new Error("DGU ortho WMS must use HTTPS");
    url.search = "";
    Object.entries({
      SERVICE: "WMS", REQUEST: "GetMap", VERSION: "1.3.0", LAYERS: env.DGU_ORTHO_LAYER,
      STYLES: "", CRS: "EPSG:3857", BBOX: bbox3857(z, x, y), WIDTH: "256", HEIGHT: "256",
      FORMAT: "image/png", TRANSPARENT: "TRUE"
    }).forEach(([key, value]) => url.searchParams.set(key, value));

    const upstream = await fetch(url, { headers: { Accept: "image/png,image/*;q=0.9,*/*;q=0.1" }, redirect: "follow" });
    if (!upstream.ok) throw new Error(`DGU WMS failed (${upstream.status})`);
    const contentType = (upstream.headers.get("Content-Type") || "").toLowerCase();
    if (!contentType.startsWith("image/")) throw new Error(`Unexpected DGU response type: ${contentType || "unknown"}`);
    const body = Buffer.from(await upstream.arrayBuffer());
    send(res, 200, body, {
      "Content-Type": contentType.split(";")[0],
      "Content-Length": String(body.length),
      "Cache-Control": "public, max-age=86400",
      "X-Ortho-Source": "DGU"
    });
  } catch (error) {
    console.error("DGU ortho tile failed", error);
    send(res, 502, "Ortofoto trenutačno nije dostupan.", { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  }
}
