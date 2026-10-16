const SITE_ID = /^[a-z0-9][a-z0-9:_-]{2,127}$/i;

export function config(env) {
  const base = new URL(env.KOBO_BASE_URL);
  if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/" || base.search || base.hash) {
    throw new Error("KOBO_BASE_URL must be an HTTPS origin");
  }
  if (!/^[A-Za-z0-9]+$/.test(env.KOBO_ASSET_UID)) throw new Error("Invalid Kobo asset UID");
  if (!env.KOBO_API_TOKEN) throw new Error("Kobo API token is missing");
  return { origin: base.origin, dataPath: `/api/v2/assets/${env.KOBO_ASSET_UID}/data/` };
}

export function field(row, names) {
  if (!row) return undefined;
  for (const name of names) {
    const value = row[name];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined || value === null || value === "") continue;
    if (names.some((name) => key.endsWith(`/${name}`))) return value;
  }
  return undefined;
}

export function rootUuid(row) {
  if (!row) return undefined;
  const direct = field(row, ["meta/rootUuid", "rootUuid", "root_uuid"]);
  if (direct !== undefined) return direct;
  if (row.meta && typeof row.meta === "object" && !Array.isArray(row.meta)) {
    return row.meta.rootUuid ?? row.meta.root_uuid;
  }
  return undefined;
}

function generatedSiteId(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const compact = String(value).trim().replace(/^uuid:/i, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return compact ? `zg-${compact.slice(0, 20)}` : undefined;
}

export function siteId(row) {
  const explicit = field(row, ["site_id", "siteId"]);
  if (explicit !== undefined) {
    const value = String(explicit).trim();
    if (SITE_ID.test(value)) return value;
  }
  return generatedSiteId(rootUuid(row) ?? row._uuid ?? row._id);
}

export function isApproved(row) {
  return row?._validation_status?.uid === "validation_status_approved";
}

export async function koboGet(env, url) {
  const { origin, dataPath } = config(env);
  if (url.origin !== origin || !url.pathname.startsWith(dataPath)) throw new Error("Kobo URL outside asset data");
  const response = await fetch(url, {
    headers: { Authorization: `Token ${env.KOBO_API_TOKEN}`, Accept: "application/json" },
    redirect: "follow"
  });
  if (!response.ok) throw new Error(`Kobo request failed (${response.status})`);
  return response;
}

export async function allSubmissions(env) {
  const { origin, dataPath } = config(env);
  let next = new URL(`${dataPath}?format=json&limit=1000`, origin);
  const rows = [];

  for (let page = 0; next && page < 20; page++) {
    if (next.origin !== origin || next.pathname !== dataPath) throw new Error("Unexpected Kobo pagination URL");
    const response = await koboGet(env, next);
    const data = await response.json();
    if (!Array.isArray(data.results)) throw new Error("Invalid Kobo data response");
    rows.push(...data.results);
    next = data.next ? new URL(data.next, next) : undefined;
  }

  if (next) throw new Error("Too many Kobo pages");
  return rows;
}

export async function submission(env, id) {
  const { origin, dataPath } = config(env);
  const url = new URL(`${dataPath}${id}/?format=json`, origin);
  const response = await fetch(url, {
    headers: { Authorization: `Token ${env.KOBO_API_TOKEN}`, Accept: "application/json" },
    redirect: "manual"
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Kobo submission request failed (${response.status})`);
  const row = await response.json();
  return row._id === id ? row : undefined;
}

export function attachmentUrl(env, row, fieldName) {
  const { origin, dataPath } = config(env);
  const filename = field(row, [fieldName]);
  if (typeof filename !== "string" || !filename || filename.length > 255 || filename.includes("/") || filename.includes("\\")) return undefined;

  const candidates = (row._attachments ?? []).filter((candidate) => {
    if (candidate.is_deleted === true || typeof candidate.question_xpath !== "string") return false;
    return candidate.question_xpath === fieldName || candidate.question_xpath.endsWith(`/${fieldName}`);
  });

  const attachment = candidates.find((candidate) => {
    if (typeof candidate.filename !== "string") return false;
    return candidate.filename === filename || candidate.filename.endsWith(`/${filename}`);
  }) ?? candidates[0];

  if (!attachment || typeof attachment.download_url !== "string") return undefined;
  const url = new URL(attachment.download_url);
  if (url.origin !== origin || !url.pathname.startsWith(`${dataPath}${row._id}/attachments/`)) return undefined;
  return url;
}

export async function koboAttachmentGet(env, url) {
  const { origin, dataPath } = config(env);
  if (url.origin !== origin || !url.pathname.startsWith(dataPath)) throw new Error("Kobo attachment URL outside asset data");

  let current = url;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const onKobo = current.origin === origin && current.pathname.startsWith(dataPath);
    const headers = { Accept: "image/*" };
    if (onKobo) headers.Authorization = `Token ${env.KOBO_API_TOKEN}`;
    const response = await fetch(current, { headers, redirect: "manual" });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("Location");
      if (!location) throw new Error("Kobo attachment redirect without Location header");
      const next = new URL(location, current);
      if (next.protocol !== "https:") throw new Error("Kobo attachment redirect must use HTTPS");
      current = next;
      continue;
    }

    if (!response.ok) throw new Error(`Kobo attachment request failed (${response.status})`);
    return response;
  }
  throw new Error("Too many Kobo attachment redirects");
}
