import * as maplibregl from "https://unpkg.com/maplibre-gl@6.11.2/dist/maplibre-gl.mjs";

const SOURCE_ID = "problematic-corridors";
const LAYERS = ["corridor-fill", "corridor-outline", "hotspot-fill", "hotspot-outline"];
const COLOR = "#332288";
let initialized = false;
let popup = null;

function injectUi() {
  if (document.getElementById("corridor-toggle-row")) return;

  const filters = document.getElementById("filters");
  if (!filters) return;

  const row = document.createElement("label");
  row.id = "corridor-toggle-row";
  row.className = "filter-row corridor-filter-row";
  row.innerHTML = `
    <input id="corridor-toggle" type="checkbox" checked>
    <span class="dot corridor-dot" aria-hidden="true"></span>
    <span class="filter-label">Problematični koridori</span>
  `;

  filters.insertAdjacentElement("afterend", row);

  const style = document.createElement("style");
  style.textContent = `
    .corridor-filter-row {
      margin-top: 10px;
      padding-top: 11px;
      border-top: 1px solid var(--line, #d9ddd5);
    }
    .corridor-dot {
      background: #332288;
      box-shadow: 0 0 0 4px rgba(51,34,136,.15);
    }
    .corridor-popup {
      min-width: 190px;
      color: #17372e;
      font: 500 12px/1.45 Montserrat, system-ui, sans-serif;
    }
    .corridor-popup strong {
      display: block;
      margin-bottom: 4px;
      font-size: 13px;
    }
    .corridor-popup .corridor-meta {
      color: #52685f;
    }
    @media (max-width: 740px) {
      .corridor-filter-row {
        margin-top: 6px;
        min-height: 53px;
        padding: 7px 8px;
        border: 1px solid #d7ded6;
        border-radius: 10px;
        background: #fff;
      }
    }
  `;
  document.head.appendChild(style);

  row.querySelector("input").addEventListener("change", (event) => {
    const visibility = event.target.checked ? "visible" : "none";
    const map = window.__rubnjaciMap;
    if (!map) return;
    for (const id of LAYERS) {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visibility);
    }
  });

  const about = document.querySelector(".about-map");
  if (about && !about.querySelector(".corridor-about")) {
    const p = document.createElement("p");
    p.className = "corridor-about";
    p.textContent = "Problematični koridori povezuju više prijava duž istog prometnog poteza. Zasjenjeno područje određeno je automatski iz prikupljenih podataka.";
    about.appendChild(p);
  }
}

function featureText(feature) {
  const p = feature.properties || {};
  const role = p.feature_role;
  const name = p.corridor_name || "Problematični koridor";
  const sites = Number(p.site_count || 0);
  const span = Number(p.evidence_span_m || 0);
  const gap = Number(p.largest_gap_m || 0);
  const hotspotSites = Number(p.hotspot_site_count || 0);
  const hotspotSpan = Number(p.hotspot_span_m || 0);

  const root = document.createElement("div");
  root.className = "corridor-popup";

  const title = document.createElement("strong");
  title.textContent = name;
  root.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "corridor-meta";

  if (role === "hotspot_area") {
    meta.textContent = `Hotspot · ${hotspotSites} prijava · ${Math.round(hotspotSpan)} m`;
  } else {
    meta.textContent = `${sites} prijava · ${Math.round(span)} m raspona · najveći razmak ${Math.round(gap)} m`;
  }
  root.appendChild(meta);
  return root;
}

async function loadCorridors(map) {
  if (initialized) return;
  initialized = true;
  injectUi();

  let data;
  try {
    const response = await fetch("/data/corridors.geojson", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    data = await response.json();
  } catch (error) {
    console.error("Corridor GeoJSON load failed", error);
    const row = document.getElementById("corridor-toggle-row");
    if (row) row.hidden = true;
    return;
  }

  if (map.getSource(SOURCE_ID)) return;

  map.addSource(SOURCE_ID, { type: "geojson", data });

  const beforeId = map.getLayer("clusters") ? "clusters" : undefined;

  map.addLayer({
    id: "corridor-fill",
    type: "fill",
    source: SOURCE_ID,
    filter: ["==", ["get", "feature_role"], "corridor_area"],
    paint: {
      "fill-color": COLOR,
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 10, 0.13, 14, 0.18, 17, 0.22]
    }
  }, beforeId);

  map.addLayer({
    id: "corridor-outline",
    type: "line",
    source: SOURCE_ID,
    filter: ["==", ["get", "feature_role"], "corridor_area"],
    paint: {
      "line-color": COLOR,
      "line-opacity": 0.72,
      "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.2, 14, 2.2, 17, 3]
    }
  }, beforeId);

  map.addLayer({
    id: "hotspot-fill",
    type: "fill",
    source: SOURCE_ID,
    filter: ["==", ["get", "feature_role"], "hotspot_area"],
    paint: {
      "fill-color": COLOR,
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 10, 0.22, 14, 0.30, 17, 0.36]
    }
  }, beforeId);

  map.addLayer({
    id: "hotspot-outline",
    type: "line",
    source: SOURCE_ID,
    filter: ["==", ["get", "feature_role"], "hotspot_area"],
    paint: {
      "line-color": COLOR,
      "line-opacity": 0.9,
      "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.4, 14, 2.5, 17, 3.4]
    }
  }, beforeId);

  for (const layer of ["hotspot-fill", "corridor-fill"]) {
    map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
    map.on("click", layer, (event) => {
      if (!event.features?.length) return;
      popup?.remove();
      popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: "300px" })
        .setLngLat(event.lngLat)
        .setDOMContent(featureText(event.features[0]))
        .addTo(map);
    });
  }

  console.info("Corridor dev layer loaded", data.meta || {});
}

function start(map) {
  if (!map || initialized) return;
  if (map.loaded() && map.getLayer("clusters")) {
    loadCorridors(map);
  } else {
    map.once("idle", () => loadCorridors(map));
  }
}

window.addEventListener("rubnjaci:map-ready", (event) => start(event.detail?.map));
if (window.__rubnjaciMap) start(window.__rubnjaciMap);
