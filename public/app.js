import * as maplibregl from "https://unpkg.com/maplibre-gl@6.11.2/dist/maplibre-gl.mjs";

(() => {
  const labels = {
    rubnjak_nedovoljno_spusten_ili_ostecen: "Loše izveden rubnjak",
    biciklisticka_ruta_bez_adekvatne_infrastrukture: "Rubnjak na ruti bez biciklističke infrastrukture",
    pjesacka_infrastruktura_nije_adekvatno_spustena: "Pješačka infrastruktura nije spuštena",
    dobar_primjer: "Dobar primjer"
  };

  const shortLabels = {
    rubnjak_nedovoljno_spusten_ili_ostecen: "Loše izveden rubnjak",
    biciklisticka_ruta_bez_adekvatne_infrastrukture: "Ruta bez infrastrukture",
    pjesacka_infrastruktura_nije_adekvatno_spustena: "Pješačka infrastruktura",
    dobar_primjer: "Dobar primjer"
  };

  function canonicalType(value) {
    const type = String(value || "");
    return type === "rubnjak_nije_po_pravilniku"
      ? "rubnjak_nedovoljno_spusten_ili_ostecen"
      : type;
  }

  const statusLabels = {
    bez_bitne_promjene: "Bez bitne promjene",
    bez_promjene: "Bez promjene",
    poboljsano: "Poboljšano",
    pogorsano: "Pogoršano",
    sanirano: "Sanirano",
    rijeseno: "Sanirano"
  };

  const categoryColors = [
    "match", ["get", "vrsta"],
    "rubnjak_nije_po_pravilniku", "#D55E00",
    "rubnjak_nedovoljno_spusten_ili_ostecen", "#D55E00",
    "biciklisticka_ruta_bez_adekvatne_infrastrukture", "#CC79A7",
    "pjesacka_infrastruktura_nije_adekvatno_spustena", "#0072B2",
    "dobar_primjer", "#009E73",
    "#777"
  ];

  const $ = (id) => document.getElementById(id);
  const empty = () => ({ type: "FeatureCollection", features: [] });

  let rawData = empty();
  let currentData = empty();
  let sites = new Map();
  let map;
  let mapReady = false;
  let picking = false;
  let pickMarker = null;
  let userLocationMarker = null;
  let mapMode = "map";
  let runtimeConfig = {};
  let selectedSiteId = null;
  let selectedObservationIndex = 0;
  let lastFocusedElement = null;
  let mobilePanelExpanded = false;
  let navigationControl = null;
  let navigationControlPosition = null;

  const mobileMedia = window.matchMedia("(max-width: 740px)");

  function isMobile() {
    return mobileMedia.matches;
  }

  function syncMobilePanelA11y() {
    const collapsed = isMobile() && !mobilePanelExpanded;
    const tools = $("sidebar-tools");
    if (tools) tools.inert = collapsed;
  }

  function setMobilePanel(expanded) {
    mobilePanelExpanded = isMobile() && Boolean(expanded);
    const sidebar = $("sidebar");
    const toggle = $("mobile-panel-toggle");
    if (sidebar) sidebar.classList.toggle("is-expanded", mobilePanelExpanded);
    if (toggle) toggle.setAttribute("aria-expanded", String(mobilePanelExpanded));
    syncMobilePanelA11y();
  }

  function updateMobileFilterCount() {
    const all = [...document.querySelectorAll("#filters input")];
    const active = all.filter((input) => input.checked).length;
    const output = $("mobile-filter-count");
    if (output) output.textContent = `${active}/${all.length}`;
  }

  function showStatus(message = "", { error = false } = {}) {
    const status = $("status");
    if (!status) return;
    status.textContent = message;
    status.hidden = !message;
    status.classList.toggle("error", Boolean(error));
  }

  function placeNavigationControl() {
    if (!map) return;
    const desiredPosition = isMobile() ? "top-right" : "bottom-right";
    if (navigationControl && navigationControlPosition === desiredPosition) return;
    if (navigationControl) map.removeControl(navigationControl);
    navigationControl = new maplibregl.NavigationControl({ showCompass: false });
    navigationControlPosition = desiredPosition;
    map.addControl(navigationControl, desiredPosition);
  }

  function setPickingLabels(active) {
    const mobileLabel = $("pick-start-header");
    const sidebarLabel = $("pick-start");
    const label = active ? "Označavanje..." : "Označi i prijavi";
    if (mobileLabel) mobileLabel.textContent = label;
    if (sidebarLabel) sidebarLabel.textContent = label;
  }

  function parseMaybeJson(value) {
    if (typeof value !== "string") return value;
    const text = value.trim();
    if (!text || (!text.startsWith("[") && !text.startsWith("{"))) return value;
    try { return JSON.parse(text); } catch { return value; }
  }

  function firstValue(object, keys) {
    for (const key of keys) {
      const value = object?.[key];
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return null;
  }

  function numeric(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value.replace(",", "."));
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  }

  function validPoint(geometry) {
    return geometry?.type === "Point" && Array.isArray(geometry.coordinates) && geometry.coordinates.length >= 2
      && geometry.coordinates.every((value) => Number.isFinite(Number(value)));
  }

  function observationDateValue(properties) {
    const value = firstValue(properties, ["datum", "observed_at", "observation_date", "_submission_time", "submission_time", "submitted_at"]);
    if (!value) return 0;
    const time = new Date(value).valueOf();
    return Number.isFinite(time) ? time : 0;
  }

  function observationId(properties, fallback = "") {
    return String(firstValue(properties, ["observation_id", "_uuid", "uuid", "_id", "id"]) ?? fallback);
  }

  function siteIdForFeature(feature, fallbackIndex) {
    const p = feature?.properties || {};
    const stable = firstValue(p, ["site_id", "siteId", "rootUuid", "root_uuid", "meta/rootUuid", "meta_rootUuid"]);
    if (stable) return String(stable);
    if (feature?.id !== undefined && feature?.id !== null) return String(feature.id);
    const uuid = firstValue(p, ["_uuid", "uuid", "_id"]);
    if (uuid) return String(uuid);
    return `lokacija-${fallbackIndex + 1}`;
  }

  function observationFrom(value, fallbackGeometry, fallbackProperties, fallbackId) {
    if (!value || typeof value !== "object") return null;
    if (value.type === "Feature") {
      const properties = { ...(value.properties || {}) };
      return {
        id: observationId(properties, value.id ?? fallbackId),
        properties,
        geometry: validPoint(value.geometry) ? value.geometry : fallbackGeometry
      };
    }

    const properties = { ...fallbackProperties, ...value };
    delete properties.history;
    delete properties.observations;
    return {
      id: observationId(properties, fallbackId),
      properties,
      geometry: validPoint(value.geometry) ? value.geometry : fallbackGeometry
    };
  }

  function extractObservations(feature, fallbackIndex) {
    const p = { ...(feature.properties || {}) };
    const embedded = parseMaybeJson(p.observations ?? p.history);
    delete p.observations;
    delete p.history;

    const base = {
      id: observationId(p, feature.id ?? `zapis-${fallbackIndex + 1}`),
      properties: p,
      geometry: feature.geometry
    };

    if (!Array.isArray(embedded) || embedded.length === 0) return [base];

    const observations = embedded
      .map((item, index) => observationFrom(item, feature.geometry, p, `${base.id}-${index + 1}`))
      .filter(Boolean);

    const baseKey = `${base.id}|${observationDateValue(base.properties)}`;
    const hasBase = observations.some((item) => `${item.id}|${observationDateValue(item.properties)}` === baseKey);
    if (!hasBase) observations.push(base);
    return observations;
  }

  function dedupeObservations(observations) {
    const seen = new Set();
    return observations.filter((observation, index) => {
      const p = observation.properties || {};
      const key = observation.id
        ? `id:${observation.id}`
        : `v:${observationDateValue(p)}|${firstValue(p, ["vrsta"]) || ""}|${numeric(firstValue(p, ["visina_cm"])) ?? ""}|${firstValue(p, ["foto_mjerenja"]) || ""}|${index}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function normalizeData(data) {
    const grouped = new Map();

    data.features.forEach((feature, index) => {
      if (!validPoint(feature.geometry)) return;
      const defaultSiteId = siteIdForFeature(feature, index);
      const observations = extractObservations(feature, index);

      for (const observation of observations) {
        if (!validPoint(observation.geometry)) continue;
        const ownSiteId = firstValue(observation.properties, ["site_id", "siteId", "rootUuid", "root_uuid", "meta/rootUuid", "meta_rootUuid"]);
        const siteId = String(ownSiteId || defaultSiteId);
        if (!grouped.has(siteId)) grouped.set(siteId, []);
        grouped.get(siteId).push(observation);
      }
    });

    const siteMap = new Map();
    const currentFeatures = [];

    for (const [siteId, records] of grouped) {
      const observations = dedupeObservations(records).sort((a, b) => {
        const dateDiff = observationDateValue(a.properties) - observationDateValue(b.properties);
        return dateDiff || String(a.id).localeCompare(String(b.id), "hr");
      });
      if (!observations.length) continue;

      const latest = observations[observations.length - 1];
      const latestProperties = { ...latest.properties, site_id: siteId, history_count: observations.length };
      delete latestProperties.history;
      delete latestProperties.observations;

      const currentFeature = {
        type: "Feature",
        id: siteId,
        geometry: latest.geometry,
        properties: latestProperties
      };

      siteMap.set(siteId, {
        siteId,
        observations,
        latestIndex: observations.length - 1,
        currentFeature
      });
      currentFeatures.push(currentFeature);
    }

    return {
      sites: siteMap,
      current: { type: "FeatureCollection", features: currentFeatures }
    };
  }

  function typeOf(properties) {
    return canonicalType(firstValue(properties, ["vrsta", "vrsta_kod"]));
  }

  function heightOf(properties) {
    return numeric(firstValue(properties, ["visina_cm", "visina_rubnjaka_cm", "height_cm"]));
  }

  function commentOf(properties) {
    return String(firstValue(properties, ["komentar", "comment"]) || "").trim();
  }

  function measurementPhotoOf(properties) {
    return firstValue(properties, ["foto_mjerenja", "foto_problema", "photo", "photo_measurement"]);
  }

  function contextPhotoOf(properties) {
    return firstValue(properties, ["foto_konteksta", "foto_sireg_konteksta", "context_photo"]);
  }

  function changeStatusOf(properties) {
    return String(firstValue(properties, ["promjena_stanja", "change_status", "status_promjene"]) || "");
  }

  function selectedTypes() {
    return new Set([...document.querySelectorAll("#filters input:checked")].map((input) => input.value));
  }

  function pluralLocationLabel(count) {
    if (count === 1) return "prijavljena lokacija";
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return "prijavljene lokacije";
    return "prijavljenih lokacija";
  }

  function refreshFilter() {
    const selected = selectedTypes();
    updateMobileFilterCount();
    const features = currentData.features.filter((feature) => selected.has(typeOf(feature.properties)));
    $("result-count").textContent = String(features.length);
    $("result-count-label").textContent = pluralLocationLabel(features.length);

    const source = mapReady ? map.getSource("rubnjaci") : null;
    if (source) source.setData({ type: "FeatureCollection", features });

    if (selectedSiteId) {
      const site = sites.get(selectedSiteId);
      if (!site || !selected.has(typeOf(site.currentFeature.properties))) closeSheet({ updateHash: true, restoreFocus: false });
    }
  }

  function distanceMeters(a, b) {
    const toRad = (value) => value * Math.PI / 180;
    const [lon1, lat1] = a;
    const [lon2, lat2] = b;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const rLat1 = toRad(lat1);
    const rLat2 = toRad(lat2);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  function nearbySites(lon, lat) {
    const radius = Number.isFinite(runtimeConfig.nearbyRadiusMeters) ? runtimeConfig.nearbyRadiusMeters : 40;
    const limit = Number.isFinite(runtimeConfig.nearbyLimit) ? runtimeConfig.nearbyLimit : 3;
    return currentData.features
      .filter((feature) => typeOf(feature.properties) !== "dobar_primjer")
      .map((feature) => ({
        feature,
        distance: distanceMeters([lon, lat], feature.geometry.coordinates)
      }))
      .filter((item) => item.distance <= radius)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);
  }

  function renderNearbyReports(lon, lat) {
    const container = $("nearby-reports");
    const list = $("nearby-list");
    const confirm = $("pick-confirm");
    if (!container || !list || !confirm) return;

    const nearby = nearbySites(lon, lat);
    list.replaceChildren();
    container.hidden = nearby.length === 0;
    confirm.textContent = nearby.length ? "Ipak prijavi novu lokaciju" : "Nastavi na prijavu";

    for (const item of nearby) {
      const p = item.feature.properties || {};
      const type = typeOf(p);
      const height = heightOf(p);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "nearby-item";
      button.dataset.siteId = String(p.site_id ?? item.feature.id ?? "");

      const main = document.createElement("span");
      main.className = "nearby-item-main";
      const distance = `${Math.max(1, Math.round(item.distance))} m`;
      main.textContent = `${distance} · ${shortLabels[type] || labels[type] || "Prijava"}`;

      const meta = document.createElement("span");
      meta.className = "nearby-item-meta";
      const parts = [];
      if (height !== null) parts.push(`${height.toLocaleString("hr-HR")} cm`);
      const date = formatDate(p);
      if (date && date !== "Datum nije dostupan") parts.push(date);
      meta.textContent = parts.join(" · ");

      button.append(main, meta);
      button.addEventListener("click", () => {
        const siteId = button.dataset.siteId;
        stopPicking();
        if (siteId) selectSite(siteId, { flyTo: true });
      });
      list.appendChild(button);
    }
  }

  function setPickedLocation(lngLat) {
    const lon = Number(lngLat.lng.toFixed(6));
    const lat = Number(lngLat.lat.toFixed(6));

    if (!pickMarker) {
      pickMarker = new maplibregl.Marker({ color: "#ffdb00", draggable: true })
        .setLngLat([lon, lat])
        .addTo(map);
      pickMarker.on("dragend", () => setPickedLocation(pickMarker.getLngLat()));
    } else {
      pickMarker.setLngLat([lon, lat]);
    }

    $("pick-coordinates").textContent = `Označeno: ${lat.toLocaleString("hr-HR")}, ${lon.toLocaleString("hr-HR")}. Povuci točku ako treba.`;
    renderNearbyReports(lon, lat);
    $("pick-confirm").disabled = false;
  }

  function stopPicking() {
    picking = false;
    if (pickMarker) pickMarker.remove();
    pickMarker = null;
    $("pick-controls").hidden = true;
    $("nearby-reports").hidden = true;
    $("nearby-list").replaceChildren();
    $("pick-confirm").textContent = "Nastavi na prijavu";
    document.body.classList.remove("map-picking");
    setPickingLabels(false);
    map.getCanvas().style.cursor = "";
  }

  function download(name, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function csvCell(value) {
    if (typeof value === "number") return String(value);
    const text = value == null ? "" : String(value);
    const safe = /^[=+@-]/.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  }

  function observationRows() {
    const rows = [];
    for (const site of sites.values()) {
      site.observations.forEach((observation, index) => {
        const p = observation.properties;
        const coords = observation.geometry.coordinates;
        const type = typeOf(p);
        rows.push([
          site.siteId,
          observation.id,
          index + 1,
          site.observations.length,
          firstValue(p, ["datum", "observed_at", "observation_date", "_submission_time", "submission_time", "submitted_at"]),
          type,
          labels[type] || type,
          coords[1],
          coords[0],
          heightOf(p),
          changeStatusOf(p),
          commentOf(p),
          measurementPhotoOf(p),
          contextPhotoOf(p)
        ]);
      });
    }
    return rows;
  }

  function exportCsv() {
    const columns = ["site_id", "zapis_id", "redni_broj_zapisa", "broj_zapisa", "datum", "vrsta_kod", "vrsta", "geografska_sirina", "geografska_duzina", "visina_cm", "promjena_stanja", "komentar", "foto_mjerenja", "foto_konteksta"];
    const text = "\ufeff" + [columns, ...observationRows()].map((row) => row.map(csvCell).join(",")).join("\r\n");
    download("rubnjaci-svi-odobreni-zapisi.csv", text, "text/csv;charset=utf-8");
  }

  function exportGeoJson() {
    download("rubnjaci-zadnje-stanje.geojson", JSON.stringify(currentData, null, 2), "application/geo+json;charset=utf-8");
  }

  function openPhoto(url, caption) {
    if (!url) return;
    $("photo-full").src = url;
    $("photo-caption").textContent = caption;
    $("photo-dialog").showModal();
  }

  function closePhoto() {
    if ($("photo-dialog").open) $("photo-dialog").close();
    $("photo-full").removeAttribute("src");
  }

  function formatDate(properties) {
    const raw = firstValue(properties, ["datum", "observed_at", "observation_date", "_submission_time", "submission_time", "submitted_at"]);
    if (!raw) return "Datum nije dostupan";
    const date = new Date(raw);
    if (Number.isNaN(date.valueOf())) return String(raw);
    return date.toLocaleDateString("hr-HR", { day: "numeric", month: "long", year: "numeric" });
  }

  function staleText(properties, isLatest) {
    if (!isLatest) return "";
    const timestamp = observationDateValue(properties);
    if (!timestamp) return "";
    const staleAfterDays = Number.isFinite(runtimeConfig.staleAfterDays) ? runtimeConfig.staleAfterDays : 365;
    const ageDays = Math.floor((Date.now() - timestamp) / 86400000);
    if (ageDays < staleAfterDays) return "";
    if (ageDays < 730) return "Stanje nije provjereno više od godinu dana.";
    const years = Math.floor(ageDays / 365);
    return `Stanje nije provjereno oko ${years} godine.`;
  }

  function changeText(site, index) {
    if (index <= 0) return "";
    const previous = heightOf(site.observations[index - 1].properties);
    const current = heightOf(site.observations[index].properties);
    if (previous === null || current === null || previous === current) return "";
    const difference = Math.abs(current - previous);
    const formatted = difference.toLocaleString("hr-HR", { maximumFractionDigits: 1 });
    return current < previous ? `${formatted} cm manje nego prije` : `${formatted} cm više nego prije`;
  }

  function setHash(siteId) {
    const url = new URL(window.location.href);
    if (siteId) url.hash = `lokacija=${encodeURIComponent(siteId)}`;
    else url.hash = "";
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function hashSiteId() {
    const match = window.location.hash.match(/^#lokacija=(.+)$/);
    if (!match) return null;
    try { return decodeURIComponent(match[1]); } catch { return match[1]; }
  }

  function setSelectedSource(site) {
    if (!mapReady) return;
    const source = map.getSource("selected-rubnjak");
    if (!source) return;
    source.setData(site ? { type: "FeatureCollection", features: [site.currentFeature] } : empty());
  }

  function buildUpdateUrl(site) {
    const base = runtimeConfig.updateUrl || runtimeConfig.reportUrl || "/prijavi";
    const target = new URL(base, window.location.origin);
    target.searchParams.set("site_id", site.siteId);
    target.searchParams.set("record_type", "update");
    return target.toString();
  }

  function renderObservation() {
    const site = sites.get(selectedSiteId);
    if (!site) return;
    selectedObservationIndex = Math.max(0, Math.min(selectedObservationIndex, site.observations.length - 1));
    const observation = site.observations[selectedObservationIndex];
    const p = observation.properties;
    const type = typeOf(p);
    const isLatest = selectedObservationIndex === site.latestIndex;
    const historyCount = site.observations.length;

    $("detail-type").textContent = labels[type] || "Prijava";
    $("detail-date").textContent = formatDate(p);

    const height = heightOf(p);
    $("detail-height").textContent = height === null ? "" : `Visina: ${height.toLocaleString("hr-HR")} cm`;

    const comment = commentOf(p);
    $("detail-comment").textContent = comment || "Bez dodatnog komentara.";

    const change = changeText(site, selectedObservationIndex);
    $("detail-change").hidden = !change;
    $("detail-change").textContent = change;

    const stale = staleText(p, isLatest);
    $("detail-age").hidden = !stale;
    $("detail-age").textContent = stale;

    const imageUrl = measurementPhotoOf(p);
    const image = $("detail-image");
    image.hidden = !imageUrl;
    if (imageUrl) image.src = imageUrl;
    else image.removeAttribute("src");

    const contextUrl = contextPhotoOf(p);
    const context = $("detail-context");
    context.hidden = !contextUrl;
    context.onclick = contextUrl ? () => openPhoto(contextUrl, "Fotografija konteksta") : null;

    const historyNav = $("history-nav");
    historyNav.hidden = historyCount < 2;
    $("history-count").textContent = `${selectedObservationIndex + 1} od ${historyCount}`;
    $("history-caption").textContent = "zapisa o stanju";
    $("history-prev").disabled = selectedObservationIndex === 0;
    $("history-next").disabled = isLatest;

    const chip = $("detail-record-chip");
    const changeStatus = changeStatusOf(p);
    const chipText = statusLabels[changeStatus] || (historyCount > 1 ? (isLatest ? "Zadnje stanje" : "Raniji zapis") : "");
    chip.hidden = !chipText;
    chip.textContent = chipText;
    chip.dataset.kind = changeStatus || (isLatest ? "latest" : "earlier");

    const updatesEnabled = runtimeConfig.updatesEnabled === true;
    $("detail-update").hidden = !updatesEnabled;
    if (updatesEnabled) $("detail-update").href = buildUpdateUrl(site);
  }

  function selectSite(siteId, options = {}) {
    const site = sites.get(String(siteId));
    if (!site) return false;
    if (isMobile()) setMobilePanel(false);
    const sheetWasHidden = $("detail-sheet").hidden;
    selectedSiteId = site.siteId;
    selectedObservationIndex = options.observationIndex ?? site.latestIndex;
    if (sheetWasHidden) lastFocusedElement = document.activeElement;
    setSelectedSource(site);
    renderObservation();
    $("detail-sheet").hidden = false;
    $("sheet-backdrop").hidden = false;
    if (options.updateHash !== false) setHash(site.siteId);
    if (options.focus !== false) $("sheet-close").focus({ preventScroll: true });

    if (options.flyTo && mapReady) {
      const zoom = Number.isFinite(runtimeConfig.deepLinkZoom) ? runtimeConfig.deepLinkZoom : 16;
      map.easeTo({ center: site.currentFeature.geometry.coordinates, zoom: Math.max(map.getZoom(), zoom), duration: 600 });
    }
    return true;
  }

  function closeSheet(options = {}) {
    const { updateHash = true, restoreFocus = true } = options;
    $("detail-sheet").hidden = true;
    $("sheet-backdrop").hidden = true;
    $("detail-image").removeAttribute("src");
    setSelectedSource(null);
    selectedSiteId = null;
    selectedObservationIndex = 0;
    if (updateHash) setHash(null);
    if (restoreFocus && lastFocusedElement instanceof HTMLElement) lastFocusedElement.focus({ preventScroll: true });
    lastFocusedElement = null;
  }

  function openFromHash() {
    const id = hashSiteId();
    if (!id || !sites.size || !mapReady) return;
    selectSite(id, { updateHash: false, focus: false, flyTo: true });
  }

  async function copySelectedLink() {
    if (!selectedSiteId) return;
    setHash(selectedSiteId);
    const link = window.location.href;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = link;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    const button = $("detail-copy");
    const original = "Kopiraj poveznicu";
    button.textContent = "Poveznica kopirana";
    setTimeout(() => { button.textContent = original; }, 1600);
  }

  function showUserLocation(position) {
    const { longitude, latitude, accuracy } = position.coords;
    const point = [longitude, latitude];

    if (!userLocationMarker) {
      const element = document.createElement("div");
      element.className = "user-location-marker";
      element.setAttribute("role", "img");
      element.setAttribute("aria-label", "Moja lokacija");
      userLocationMarker = new maplibregl.Marker({ element, anchor: "center" }).setLngLat(point).addTo(map);
    } else {
      userLocationMarker.setLngLat(point);
    }

    const markerElement = userLocationMarker.getElement();
    markerElement.title = Number.isFinite(accuracy)
      ? `Moja lokacija, procijenjena točnost ±${Math.round(accuracy)} m`
      : "Moja lokacija";

    $("locate").classList.add("has-location");
    const targetZoom = Number.isFinite(runtimeConfig.locationZoom) ? runtimeConfig.locationZoom : 16;
    map.flyTo({ center: point, zoom: Math.max(map.getZoom(), targetZoom), essential: true });
  }


  function orthophotoTileUrl() {
    return runtimeConfig.orthophotoTileUrl || "/api/ortho/{z}/{x}/{y}.png";
  }

  function updateMapModeButtons() {
    document.querySelectorAll("[data-map-mode]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.mapMode === mapMode));
    });
  }

  function setMapMode(mode) {
    mapMode = mode === "orthophoto" ? "orthophoto" : "map";
    if (map?.getLayer("dgu-orthophoto")) {
      map.setLayoutProperty("dgu-orthophoto", "visibility", mapMode === "orthophoto" ? "visible" : "none");
    } else if (mapMode === "orthophoto" && mapReady) {
      mapMode = "map";
    }
    updateMapModeButtons();
  }

  function addLayers() {
    const clusterRadius = Number.isFinite(runtimeConfig.clusterRadius) ? runtimeConfig.clusterRadius : 24;
    const clusterMaxZoom = Number.isFinite(runtimeConfig.clusterMaxZoom) ? runtimeConfig.clusterMaxZoom : 12;

    if (runtimeConfig.orthophotoEnabled !== false) {
      map.addSource("dgu-orthophoto", {
        type: "raster",
        tiles: [orthophotoTileUrl()],
        tileSize: 256,
        minzoom: 6,
        maxzoom: 19,
        attribution: runtimeConfig.orthophotoAttribution || "Sadrži podatke Geoportala Državne geodetske uprave"
      });
      const firstSymbolLayer = map.getStyle().layers?.find((layer) => layer.type === "symbol")?.id;
      map.addLayer({
        id: "dgu-orthophoto",
        type: "raster",
        source: "dgu-orthophoto",
        layout: { visibility: "none" },
        paint: { "raster-opacity": 1 }
      }, firstSymbolLayer);
    }

    map.addSource("rubnjaci", {
      type: "geojson",
      data: empty(),
      cluster: true,
      clusterRadius,
      clusterMaxZoom
    });

    map.addSource("selected-rubnjak", { type: "geojson", data: empty() });

    map.addLayer({
      id: "clusters",
      type: "circle",
      source: "rubnjaci",
      filter: ["has", "point_count"],
      paint: {
        "circle-color": "#173e31",
        "circle-opacity": 0.92,
        "circle-radius": ["step", ["get", "point_count"], 15, 5, 18, 15, 22],
        "circle-stroke-color": "#f6f4ed",
        "circle-stroke-width": 2.5
      }
    });

    map.addLayer({
      id: "cluster-count",
      type: "symbol",
      source: "rubnjaci",
      filter: ["has", "point_count"],
      layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 11 },
      paint: { "text-color": "#fff" }
    });

    map.addLayer({
      id: "selected-halo",
      type: "circle",
      source: "selected-rubnjak",
      paint: {
        "circle-radius": 14,
        "circle-color": "#ffdb00",
        "circle-opacity": 0.22,
        "circle-stroke-color": "#c7a900",
        "circle-stroke-width": 1.5
      }
    });

    map.addLayer({
      id: "points",
      type: "circle",
      source: "rubnjaci",
      filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-color": categoryColors,
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 6.5, 15, 8, 18, 9],
        "circle-stroke-color": "#fff",
        "circle-stroke-width": 2
      }
    });

    map.addLayer({
      id: "selected-point",
      type: "circle",
      source: "selected-rubnjak",
      paint: {
        "circle-color": categoryColors,
        "circle-radius": 9,
        "circle-stroke-color": "#fff",
        "circle-stroke-width": 2.5
      }
    });

    map.on("click", "clusters", (event) => {
      if (picking) return;
      if (isMobile()) setMobilePanel(false);
      if (selectedSiteId) closeSheet({ restoreFocus: false });
      const features = map.queryRenderedFeatures(event.point, { layers: ["clusters"] });
      if (!features.length) return;
      const feature = features[0];
      map.getSource("rubnjaci").getClusterExpansionZoom(feature.properties.cluster_id)
        .then((zoom) => map.easeTo({ center: feature.geometry.coordinates, zoom }));
    });

    map.on("click", "points", (event) => {
      if (picking || !event.features?.length) return;
      const feature = event.features[0];
      const id = feature.properties.site_id ?? feature.id;
      if (id !== undefined && id !== null) selectSite(String(id));
    });

    map.on("click", (event) => {
      if (picking) setPickedLocation(event.lngLat);
    });

    map.on("dragstart", () => {
      if (isMobile() && mobilePanelExpanded && !picking) setMobilePanel(false);
    });

    for (const layer of ["clusters", "points"]) {
      map.on("mouseenter", layer, () => { if (!picking) map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = picking ? "crosshair" : ""; });
    }

    mapReady = true;
    setMapMode(mapMode);
    refreshFilter();
    openFromHash();
  }

  async function loadData(apiUrl) {
    try {
      const response = await fetch(apiUrl, {
        cache: "no-store",
        headers: { Accept: "application/geo+json" }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data.type !== "FeatureCollection" || !Array.isArray(data.features)) throw new Error("Neispravan GeoJSON");

      rawData = data;
      const normalized = normalizeData(data);
      sites = normalized.sites;
      currentData = normalized.current;
      refreshFilter();
      const source = response.headers.get("X-Rubnjaci-Source");
      if (source === "stale") {
        showStatus("Prikazana je zadnja dostupna verzija podataka.");
      } else if (!currentData.features.length) {
        showStatus("Još nema odobrenih prijava.");
      } else {
        showStatus();
      }
      openFromHash();
    } catch (error) {
      showStatus("Prijave se trenutačno ne mogu učitati. Pokušaj ponovno kasnije.", { error: true });
      console.error(error);
    }
  }

  async function init() {
    runtimeConfig = await fetch("/config.json", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : {})
      .catch(() => ({}));

    document.querySelectorAll("[data-report-link]").forEach((link) => {
      link.href = runtimeConfig.reportUrl || "/prijavi";
    });

    const mapModeToggle = $("map-mode-toggle");
    if (mapModeToggle) {
      mapModeToggle.hidden = runtimeConfig.orthophotoEnabled === false;
      mapModeToggle.addEventListener("click", (event) => {
        const button = event.target.closest("[data-map-mode]");
        if (button) setMapMode(button.dataset.mapMode);
      });
    }

    map = new maplibregl.Map({
      container: "map",
      style: runtimeConfig.mapStyle || "https://tiles.openfreemap.org/styles/liberty",
      center: runtimeConfig.initialCenter || [15.9819, 45.815],
      zoom: runtimeConfig.initialZoom || 11.5,
      attributionControl: true
    });

    window.__rubnjaciMap = map;
    placeNavigationControl();
    map.on("load", addLayers);
    map.on("load", () => window.dispatchEvent(new CustomEvent("rubnjaci:map-ready", { detail: { map } })));

    document.querySelectorAll("#filters input").forEach((input) => input.addEventListener("change", refreshFilter));
    $("mobile-panel-toggle").addEventListener("click", () => {
      if (picking) return;
      setMobilePanel(!mobilePanelExpanded);
    });
    const handleBreakpointChange = () => {
      setMobilePanel(false);
      placeNavigationControl();
      map.resize();
    };
    if (mobileMedia.addEventListener) mobileMedia.addEventListener("change", handleBreakpointChange);
    else mobileMedia.addListener?.(handleBreakpointChange);
    window.visualViewport?.addEventListener("resize", () => map.resize());
    setMobilePanel(false);
    $("sheet-close").addEventListener("click", () => closeSheet());
    $("sheet-backdrop").addEventListener("click", () => closeSheet());
    $("history-prev").addEventListener("click", () => {
      if (selectedObservationIndex > 0) {
        selectedObservationIndex -= 1;
        renderObservation();
      }
    });
    $("history-next").addEventListener("click", () => {
      const site = sites.get(selectedSiteId);
      if (site && selectedObservationIndex < site.latestIndex) {
        selectedObservationIndex += 1;
        renderObservation();
      }
    });
    $("detail-copy").addEventListener("click", copySelectedLink);

    $("detail-image").addEventListener("click", () => openPhoto($("detail-image").src, "Fotografija prijave"));
    $("detail-image").addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openPhoto($("detail-image").src, "Fotografija prijave");
      }
    });
    $("photo-close").addEventListener("click", closePhoto);
    $("photo-dialog").addEventListener("click", (event) => { if (event.target === $("photo-dialog")) closePhoto(); });
    $("photo-dialog").addEventListener("close", () => $("photo-full").removeAttribute("src"));

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !$("photo-dialog").open && !$("detail-sheet").hidden) closeSheet();
      if (!$("detail-sheet").hidden && event.key === "ArrowLeft" && !$("history-prev").disabled) $("history-prev").click();
      if (!$("detail-sheet").hidden && event.key === "ArrowRight" && !$("history-next").disabled) $("history-next").click();
    });

    window.addEventListener("hashchange", () => {
      const id = hashSiteId();
      if (!id && selectedSiteId) closeSheet({ updateHash: false, restoreFocus: false });
      else if (id && id !== selectedSiteId) selectSite(id, { updateHash: false, focus: false, flyTo: true });
    });

    $("download-csv").addEventListener("click", exportCsv);
    $("download-geojson").addEventListener("click", exportGeoJson);

    const startPicking = () => {
      closeSheet({ restoreFocus: false });
      if (isMobile()) setMobilePanel(false);
      picking = true;
      document.body.classList.add("map-picking");
      $("pick-controls").hidden = false;
      $("pick-coordinates").textContent = "Označi mjesto problema na karti. Točku možeš pomaknuti prije nastavka.";
      $("nearby-reports").hidden = true;
      $("nearby-list").replaceChildren();
      $("pick-confirm").textContent = "Nastavi na prijavu";
      $("pick-confirm").disabled = true;
      setPickingLabels(true);
      map.getCanvas().style.cursor = "crosshair";
    };

    $("pick-start-header").addEventListener("click", startPicking);
    $("pick-start")?.addEventListener("click", startPicking);
    $("pick-cancel").addEventListener("click", stopPicking);
    $("pick-confirm").addEventListener("click", () => {
      if (!pickMarker) return;
      const point = pickMarker.getLngLat();
      const target = new URL(runtimeConfig.reportUrl || "/prijavi", window.location.origin);
      target.searchParams.set("lat", point.lat.toFixed(6));
      target.searchParams.set("lon", point.lng.toFixed(6));
      window.location.assign(target);
    });

    $("locate").addEventListener("click", () => {
      if (!navigator.geolocation) {
        showStatus("Ovaj preglednik ne podržava lokaciju.", { error: true });
        return;
      }

      $("locate").classList.add("is-locating");
      navigator.geolocation.getCurrentPosition(
        (position) => {
          $("locate").classList.remove("is-locating");
          showUserLocation(position);
        },
        () => {
          $("locate").classList.remove("is-locating");
          showStatus("Lokacija nije dostupna ili pristup nije dopušten.", { error: true });
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
      );
    });

    await loadData(runtimeConfig.apiUrl || "/api/rubnjaci");
  }

  init().catch((error) => {
    showStatus("Karta se ne može pokrenuti.", { error: true });
    console.error(error);
  });
})();
