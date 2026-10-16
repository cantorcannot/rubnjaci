#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import re
import unicodedata
import urllib.request
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import geopandas as gpd
import pandas as pd
from shapely.geometry import GeometryCollection, LineString, MultiLineString, MultiPolygon, Polygon
from shapely.ops import linemerge, substring, unary_union

PROBLEM_TYPES = {
    "rubnjak_nedovoljno_spusten_ili_ostecen": "Loš rubnjak",
    "rubnjak_nije_po_pravilniku": "Loš rubnjak",
    "biciklisticka_ruta_bez_adekvatne_infrastrukture": "Ruta bez infrastrukture",
    "pjesacka_infrastruktura_nije_adekvatno_spustena": "Pješački prijelaz",
}
BLOCKING_TYPES = {"dobar_primjer"}
RESOLVED_STATUSES = {"sanirano", "rijeseno"}

ROAD_HIGHWAYS = {
    "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
    "secondary", "secondary_link", "tertiary", "tertiary_link", "residential",
    "living_street", "unclassified",
}
SIDE_HIGHWAYS = {"cycleway", "footway", "path", "pedestrian", "steps", "service"}


@dataclass
class StreetComponent:
    corridor_id: str
    name: str
    name_key: str
    roads: gpd.GeoDataFrame
    road_linework: Any
    side_linework: Any
    membership_area: Any


def read_json_source(path: str | None, url: str | None) -> dict[str, Any]:
    if path:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    if not url:
        raise ValueError("Provide --reports-file or --reports-url")
    request = urllib.request.Request(url, headers={"Accept": "application/geo+json", "User-Agent": "Rubnjaci/8"})
    with urllib.request.urlopen(request, timeout=45) as response:
        return json.load(response)


def canonical_type(value: Any) -> str:
    value = str(value or "")
    return "rubnjak_nedovoljno_spusten_ili_ostecen" if value == "rubnjak_nije_po_pravilniku" else value


def latest_sites(feature_collection: dict[str, Any]) -> gpd.GeoDataFrame:
    rows: list[dict[str, Any]] = []
    for index, feature in enumerate(feature_collection.get("features", [])):
        geometry = feature.get("geometry") or {}
        coordinates = geometry.get("coordinates") or []
        if geometry.get("type") != "Point" or len(coordinates) < 2:
            continue
        properties = dict(feature.get("properties") or {})
        rows.append({
            "site_id": str(properties.get("site_id") or feature.get("id") or f"site-{index + 1}"),
            "datum": pd.to_datetime(properties.get("datum"), errors="coerce", utc=True),
            "vrsta": canonical_type(properties.get("vrsta")),
            "promjena_stanja": str(properties.get("promjena_stanja") or ""),
            "visina_cm": properties.get("visina_cm"),
            "geometry": gpd.points_from_xy(
                [float(coordinates[0])], [float(coordinates[1])], crs="EPSG:4326"
            )[0],
        })

    columns = ["site_id", "datum", "vrsta", "promjena_stanja", "visina_cm", "geometry"]
    if not rows:
        return gpd.GeoDataFrame(columns=columns, geometry="geometry", crs="EPSG:4326")

    frame = gpd.GeoDataFrame(rows, geometry="geometry", crs="EPSG:4326")
    frame["_order"] = range(len(frame))
    frame = frame.sort_values(["site_id", "datum", "_order"], na_position="first")
    return frame.groupby("site_id", as_index=False, sort=False).tail(1).drop(columns="_order")


def split_values(value: Any) -> list[str]:
    if value is None:
        return []
    try:
        if pd.isna(value):
            return []
    except (TypeError, ValueError):
        pass
    text = str(value).strip()
    if not text or text.lower() == "nan":
        return []
    return [part.strip() for part in re.split(r"\s*;\s*", text) if part.strip()]


def highway_values(value: Any) -> set[str]:
    return {part.lower() for part in split_values(value)}


def normalize_name(value: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", str(value or "")).strip())


def name_key(value: str) -> str:
    return normalize_name(value).casefold()


def has_highway(value: Any, allowed: set[str]) -> bool:
    return bool(highway_values(value) & allowed)


def nearest_edges(sites: gpd.GeoDataFrame, edges: gpd.GeoDataFrame, max_distance: float) -> gpd.GeoDataFrame:
    if sites.empty:
        return sites.copy()

    fields = [
        "edge_id", "u", "v", "name", "highway", "cycleway", "bicycle", "foot",
        "sidewalk", "crossing", "kerb", "geometry",
    ]
    right = edges[[field for field in fields if field in edges.columns]].copy()
    joined = gpd.sjoin_nearest(
        sites.reset_index(drop=True), right, how="left", max_distance=max_distance, distance_col="snap_distance_m"
    )
    joined["_edge_sort"] = joined.get("edge_id", pd.Series(index=joined.index, dtype="object")).fillna("")
    joined = joined.sort_values(["site_id", "snap_distance_m", "_edge_sort"], na_position="last")
    joined = joined.groupby("site_id", as_index=False, sort=False).head(1)
    joined = joined.drop(columns=["index_right", "_edge_sort"], errors="ignore")
    return joined.rename(columns={"name": "snapped_name"})


def build_named_roads(edges: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    rows: list[dict[str, Any]] = []
    for row in edges.itertuples():
        if not has_highway(getattr(row, "highway", None), ROAD_HIGHWAYS):
            continue
        for raw_name in split_values(getattr(row, "name", None)):
            name = normalize_name(raw_name)
            if not name:
                continue
            rows.append({
                "corridor_name": name,
                "corridor_name_key": name_key(name),
                "edge_id": getattr(row, "edge_id", ""),
                "geometry": row.geometry,
            })
    if not rows:
        return gpd.GeoDataFrame(
            columns=["corridor_name", "corridor_name_key", "edge_id", "geometry"],
            geometry="geometry", crs=edges.crs,
        )
    return gpd.GeoDataFrame(rows, geometry="geometry", crs=edges.crs)


def line_parts(geometries: Any) -> list[LineString]:
    values = [geometry for geometry in geometries if geometry is not None and not geometry.is_empty]
    if not values:
        return []
    united = unary_union(values)
    if isinstance(united, LineString):
        return [united]
    merged = linemerge(united)
    if isinstance(merged, LineString):
        return [merged]
    if isinstance(merged, MultiLineString):
        return [part for part in merged.geoms if part.length > 0]
    if isinstance(merged, GeometryCollection):
        return [part for part in merged.geoms if isinstance(part, LineString) and part.length > 0]
    return []


def polygon_parts(geometry: Any) -> list[Polygon]:
    if geometry is None or geometry.is_empty:
        return []
    if isinstance(geometry, Polygon):
        return [geometry]
    if isinstance(geometry, MultiPolygon):
        return [part for part in geometry.geoms if not part.is_empty]
    if isinstance(geometry, GeometryCollection):
        parts: list[Polygon] = []
        for item in geometry.geoms:
            parts.extend(polygon_parts(item))
        return parts
    return []


def stable_corridor_id(name: str, geometry: Any) -> str:
    minx, miny, maxx, maxy = geometry.bounds
    token = f"{name_key(name)}|{minx:.1f}|{miny:.1f}|{maxx:.1f}|{maxy:.1f}"
    digest = hashlib.sha1(token.encode("utf-8")).hexdigest()[:8]
    slug = re.sub(
        r"[^a-z0-9]+", "-",
        unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower(),
    ).strip("-")
    return f"street-{slug[:34] or 'corridor'}-{digest}"


def build_street_components(
    edges: gpd.GeoDataFrame,
    *,
    component_join_m: float,
    side_search_m: float,
    road_membership_m: float,
    side_membership_m: float,
) -> list[StreetComponent]:
    named_roads = build_named_roads(edges)
    side_edges = edges[edges["highway"].map(lambda value: has_highway(value, SIDE_HIGHWAYS))].copy()
    side_index = side_edges.sindex if not side_edges.empty else None
    components: list[StreetComponent] = []

    for key, roads in named_roads.groupby("corridor_name_key", sort=False):
        joined = unary_union([geometry.buffer(component_join_m) for geometry in roads.geometry])
        for island in polygon_parts(joined):
            part_roads = roads[roads.geometry.intersects(island)].copy()
            if part_roads.empty:
                continue
            road_linework = unary_union(part_roads.geometry.tolist())
            name = normalize_name(part_roads["corridor_name"].mode().iloc[0])

            side_linework = GeometryCollection()
            side_window = road_linework.buffer(side_search_m)
            if side_index is not None:
                indexes = list(side_index.query(side_window, predicate="intersects"))
                clipped = []
                for geometry in side_edges.iloc[indexes].geometry:
                    piece = geometry.intersection(side_window)
                    if piece is not None and not piece.is_empty:
                        clipped.append(piece)
                if clipped:
                    side_linework = unary_union(clipped)

            membership_parts = [road_linework.buffer(road_membership_m)]
            if not side_linework.is_empty:
                membership_parts.append(side_linework.buffer(side_membership_m))
            membership_area = unary_union(membership_parts)
            components.append(StreetComponent(
                corridor_id=stable_corridor_id(name, road_linework),
                name=name,
                name_key=key,
                roads=part_roads,
                road_linework=road_linework,
                side_linework=side_linework,
                membership_area=membership_area,
            ))

    return components


def assign_memberships(
    matched: gpd.GeoDataFrame,
    components: list[StreetComponent],
    *,
    multi_membership_delta_m: float,
    max_memberships: int,
) -> tuple[gpd.GeoDataFrame, dict[str, list[int]]]:
    result = matched.copy()
    result["corridor_ids"] = ""
    result["corridor_names"] = ""
    result["corridor_membership_count"] = 0
    if result.empty or not components:
        return result, {}

    areas = gpd.GeoDataFrame(
        [{"component_index": index, "geometry": component.membership_area} for index, component in enumerate(components)],
        geometry="geometry", crs=result.crs,
    )
    area_index = areas.sindex
    memberships: dict[str, list[int]] = {}

    for row_index, row in result.iterrows():
        point = row.geometry
        candidate_indexes = list(area_index.query(point, predicate="intersects"))
        if not candidate_indexes:
            continue

        candidates = []
        snapped_name = name_key(split_values(row.get("snapped_name"))[0]) if split_values(row.get("snapped_name")) else ""
        snapped_is_road = has_highway(row.get("highway"), ROAD_HIGHWAYS)
        for area_row in areas.iloc[candidate_indexes].itertuples():
            component_index = int(area_row.component_index)
            component = components[component_index]
            distance = float(component.road_linework.distance(point))
            direct = snapped_is_road and snapped_name == component.name_key
            candidates.append((0 if direct else 1, distance, component_index))

        candidates.sort()
        best_direct_rank, best_distance, _ = candidates[0]
        selected = []
        for direct_rank, distance, component_index in candidates:
            if len(selected) >= max_memberships:
                break
            if direct_rank == 0 or distance <= best_distance + multi_membership_delta_m:
                selected.append(component_index)
            elif best_direct_rank == 0:
                continue

        site_id = str(row["site_id"])
        memberships[site_id] = selected
        names = [components[index].name for index in selected]
        ids = [components[index].corridor_id for index in selected]
        result.at[row_index, "corridor_ids"] = "; ".join(ids)
        result.at[row_index, "corridor_names"] = "; ".join(names)
        result.at[row_index, "corridor_membership_count"] = len(selected)

    return result, memberships


def best_axis(component: StreetComponent, points: list[Any]) -> LineString | None:
    parts = line_parts(component.roads.geometry)
    if not parts:
        return None
    ranked = []
    for part in parts:
        distances = [float(part.distance(point)) for point in points]
        support = sum(distance <= 80.0 for distance in distances)
        ranked.append((support, -sum(min(distance, 100.0) for distance in distances), float(part.length), part))
    ranked.sort(key=lambda item: item[:3], reverse=True)
    return ranked[0][3]


def blockers_between(measures: list[float], a: float, b: float) -> bool:
    low, high = sorted((float(a), float(b)))
    return any(low < measure < high for measure in measures)


def hotspot_groups(
    ordered_rows: list[tuple[str, float]],
    blocker_measures: list[float],
    max_gap_m: float,
    min_sites: int,
) -> list[list[tuple[str, float]]]:
    if not ordered_rows:
        return []
    groups: list[list[tuple[str, float]]] = [[ordered_rows[0]]]
    for row in ordered_rows[1:]:
        previous = groups[-1][-1]
        if row[1] - previous[1] <= max_gap_m and not blockers_between(blocker_measures, previous[1], row[1]):
            groups[-1].append(row)
        else:
            groups.append([row])
    return [group for group in groups if len(group) >= min_sites]


def buffered_extent(
    component: StreetComponent,
    axis_segment: Any,
    *,
    search_m: float,
    road_half_width_m: float,
    side_half_width_m: float,
) -> Any:
    if axis_segment is None or axis_segment.is_empty:
        return None
    window = axis_segment.buffer(search_m)
    pieces = []
    road_piece = component.road_linework.intersection(window)
    if not road_piece.is_empty:
        pieces.append(road_piece.buffer(road_half_width_m, cap_style=1, join_style=1))
    if component.side_linework is not None and not component.side_linework.is_empty:
        side_piece = component.side_linework.intersection(window)
        if not side_piece.is_empty:
            pieces.append(side_piece.buffer(side_half_width_m, cap_style=1, join_style=1))
    return unary_union(pieces) if pieces else axis_segment.buffer(road_half_width_m)


def type_summary(rows: gpd.GeoDataFrame) -> tuple[Counter, str]:
    counts = Counter(rows["vrsta"].tolist())
    if not counts:
        return counts, ""
    dominant, _ = counts.most_common(1)[0]
    return counts, PROBLEM_TYPES.get(dominant, dominant)


def build_street_corridors(
    sites: gpd.GeoDataFrame,
    edges: gpd.GeoDataFrame,
    *,
    max_snap_m: float,
    component_join_m: float,
    side_search_m: float,
    road_membership_m: float,
    side_membership_m: float,
    multi_membership_delta_m: float,
    max_memberships: int,
    min_corridor_sites: int,
    min_corridor_span_m: float,
    evidence_padding_m: float,
    hotspot_gap_m: float,
    min_hotspot_sites: int,
    hotspot_padding_m: float,
    display_search_m: float,
    corridor_road_half_width_m: float,
    corridor_side_half_width_m: float,
    hotspot_road_half_width_m: float,
    hotspot_side_half_width_m: float,
) -> tuple[gpd.GeoDataFrame, gpd.GeoDataFrame, dict[str, Any]]:
    projected = sites.to_crs(edges.crs)
    matched = nearest_edges(projected, edges, max_snap_m)
    matched = matched[matched["edge_id"].notna()].copy()
    matched["is_problem"] = matched["vrsta"].isin(PROBLEM_TYPES) & ~matched["promjena_stanja"].isin(RESOLVED_STATUSES)
    matched["is_blocker"] = matched["vrsta"].isin(BLOCKING_TYPES) | matched["promjena_stanja"].isin(RESOLVED_STATUSES)

    components = build_street_components(
        edges,
        component_join_m=component_join_m,
        side_search_m=side_search_m,
        road_membership_m=road_membership_m,
        side_membership_m=side_membership_m,
    )
    matched, memberships = assign_memberships(
        matched,
        components,
        multi_membership_delta_m=multi_membership_delta_m,
        max_memberships=max_memberships,
    )

    site_rows = {str(row.site_id): index for index, row in matched.iterrows()}
    problem_ids = set(matched.loc[matched["is_problem"], "site_id"].astype(str))
    blocker_ids = set(matched.loc[matched["is_blocker"], "site_id"].astype(str))

    members_by_component: dict[int, list[str]] = {index: [] for index in range(len(components))}
    blockers_by_component: dict[int, list[str]] = {index: [] for index in range(len(components))}
    for site_id, component_indexes in memberships.items():
        target = members_by_component if site_id in problem_ids else blockers_by_component if site_id in blocker_ids else None
        if target is None:
            continue
        for component_index in component_indexes:
            target[component_index].append(site_id)

    features: list[dict[str, Any]] = []
    displayed_problem_ids: set[str] = set()
    corridor_summaries = []
    hotspot_count = 0

    for component_index, component in enumerate(components):
        member_ids = members_by_component[component_index]
        if len(member_ids) < min_corridor_sites:
            continue
        member_rows = matched.loc[[site_rows[site_id] for site_id in member_ids]].copy()
        axis = best_axis(component, member_rows.geometry.tolist())
        if axis is None:
            continue

        member_rows["corridor_measure_m"] = [float(axis.project(point)) for point in member_rows.geometry]
        member_rows = member_rows.sort_values("corridor_measure_m")
        measures = member_rows["corridor_measure_m"].astype(float).tolist()
        span = max(measures) - min(measures) if len(measures) > 1 else 0.0
        if span < min_corridor_span_m:
            continue

        blocker_rows = matched.loc[
            [site_rows[site_id] for site_id in blockers_by_component[component_index]]
        ].copy() if blockers_by_component[component_index] else matched.iloc[0:0].copy()
        blocker_measures = sorted(float(axis.project(point)) for point in blocker_rows.geometry)

        start = max(0.0, min(measures) - evidence_padding_m)
        end = min(float(axis.length), max(measures) + evidence_padding_m)
        evidence_axis = substring(axis, start, end)
        corridor_area = buffered_extent(
            component,
            evidence_axis,
            search_m=display_search_m,
            road_half_width_m=corridor_road_half_width_m,
            side_half_width_m=corridor_side_half_width_m,
        )
        if corridor_area is None or corridor_area.is_empty:
            continue

        gaps = [right - left for left, right in zip(measures, measures[1:])]
        groups = hotspot_groups(
            list(zip(member_rows["site_id"].astype(str), measures)),
            blocker_measures,
            hotspot_gap_m,
            min_hotspot_sites,
        )
        counts, dominant_label = type_summary(member_rows)
        common = {
            "corridor_id": component.corridor_id,
            "corridor_name": component.name,
            "site_count": int(len(member_rows)),
            "evidence_span_m": round(float(span), 1),
            "largest_gap_m": round(float(max(gaps) if gaps else 0.0), 1),
            "hotspot_count": int(len(groups)),
            "dominant_type_label": dominant_label,
        }
        features.append({**common, "feature_role": "corridor_area", "geometry": corridor_area})
        displayed_problem_ids.update(member_rows["site_id"].astype(str))
        corridor_summaries.append((len(member_rows), component.name, span))

        for hotspot_index, group in enumerate(groups, start=1):
            hotspot_measures = [measure for _, measure in group]
            hotspot_start = max(0.0, min(hotspot_measures) - hotspot_padding_m)
            hotspot_end = min(float(axis.length), max(hotspot_measures) + hotspot_padding_m)
            hotspot_axis = substring(axis, hotspot_start, hotspot_end)
            hotspot_area = buffered_extent(
                component,
                hotspot_axis,
                search_m=display_search_m,
                road_half_width_m=hotspot_road_half_width_m,
                side_half_width_m=hotspot_side_half_width_m,
            )
            if hotspot_area is None or hotspot_area.is_empty:
                continue
            features.append({
                **common,
                "feature_role": "hotspot_area",
                "hotspot_index": hotspot_index,
                "hotspot_site_count": len(group),
                "hotspot_span_m": round(float(max(hotspot_measures) - min(hotspot_measures)), 1),
                "geometry": hotspot_area,
            })
            hotspot_count += 1

        for row_index in member_rows.index:
            existing_ids = [value for value in split_values(matched.at[row_index, "displayed_corridor_ids"])] if "displayed_corridor_ids" in matched.columns else []
            existing_names = [value for value in split_values(matched.at[row_index, "displayed_corridor_names"])] if "displayed_corridor_names" in matched.columns else []
            if component.corridor_id not in existing_ids:
                existing_ids.append(component.corridor_id)
                existing_names.append(component.name)
            matched.at[row_index, "displayed_corridor_ids"] = "; ".join(existing_ids)
            matched.at[row_index, "displayed_corridor_names"] = "; ".join(existing_names)

    columns = [
        "corridor_id", "corridor_name", "feature_role", "site_count", "evidence_span_m",
        "largest_gap_m", "hotspot_count", "dominant_type_label", "hotspot_index",
        "hotspot_site_count", "hotspot_span_m", "geometry",
    ]
    output = (
        gpd.GeoDataFrame(features, geometry="geometry", crs=edges.crs)
        if features else gpd.GeoDataFrame(columns=columns, geometry="geometry", crs=edges.crs)
    )

    corridor_summaries.sort(reverse=True)
    membership_counts = pd.to_numeric(matched["corridor_membership_count"], errors="coerce") if len(matched) else pd.Series(dtype=float)
    summary = {
        "matched_site_count": int(len(matched)),
        "active_problem_count": int(matched["is_problem"].sum()) if len(matched) else 0,
        "problem_with_membership_count": int(sum(site_id in memberships for site_id in problem_ids)),
        "displayed_problem_count": int(len(displayed_problem_ids)),
        "street_corridor_count": int(sum(feature.get("feature_role") == "corridor_area" for feature in features)),
        "hotspot_count": int(hotspot_count),
        "feature_count": int(len(output)),
        "multi_membership_problem_count": int(
            matched.loc[matched["is_problem"], "corridor_membership_count"].gt(1).sum()
        ) if len(matched) else 0,
        "top_corridors": [
            {"name": name, "site_count": int(count), "evidence_span_m": round(float(span), 1)}
            for count, name, span in corridor_summaries[:10]
        ],
        "snap_distance_m": {
            "median": round(float(matched["snap_distance_m"].median()), 3) if len(matched) else None,
            "p95": round(float(matched["snap_distance_m"].quantile(0.95)), 3) if len(matched) else None,
            "max": round(float(matched["snap_distance_m"].max()), 3) if len(matched) else None,
        },
        "membership_count": {
            "median": round(float(membership_counts.median()), 3) if len(membership_counts) else None,
            "max": int(membership_counts.max()) if len(membership_counts) else 0,
        },
    }
    return output, matched, summary


def _json_default(value: Any) -> Any:
    if value is pd.NaT:
        return None
    if isinstance(value, (pd.Timestamp, datetime)):
        return value.isoformat()
    item = getattr(value, "item", None)
    if callable(item):
        try:
            return item()
        except (TypeError, ValueError):
            pass
    raise TypeError(f"Object of type {value.__class__.__name__} is not JSON serializable")


def write_geojson_with_meta(frame: gpd.GeoDataFrame, path: Path, meta: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.loads(frame.to_crs("EPSG:4326").to_json(drop_id=True, default=_json_default))
    payload["meta"] = meta
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=_json_default), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--reports-file")
    source.add_argument("--reports-url")
    parser.add_argument("--network", default="analysis/data/zagreb_network.gpkg")
    parser.add_argument("--network-meta", default="analysis/data/zagreb_network.meta.json")
    parser.add_argument("--output", default="public/data/corridors.geojson")
    parser.add_argument("--matched-output", default="analysis/output/matched_sites.geojson")
    parser.add_argument("--summary-output", default="analysis/output/corridor_summary.json")

    parser.add_argument("--max-snap-m", type=float, default=55.0)
    parser.add_argument("--component-join-m", type=float, default=30.0)
    parser.add_argument("--side-search-m", type=float, default=45.0)
    parser.add_argument("--road-membership-m", type=float, default=28.0)
    parser.add_argument("--side-membership-m", type=float, default=10.0)
    parser.add_argument("--multi-membership-delta-m", type=float, default=8.0)
    parser.add_argument("--max-memberships", type=int, default=2)

    parser.add_argument("--min-corridor-sites", type=int, default=3)
    parser.add_argument("--min-corridor-span-m", type=float, default=175.0)
    parser.add_argument("--evidence-padding-m", type=float, default=20.0)
    parser.add_argument("--hotspot-gap-m", type=float, default=120.0)
    parser.add_argument("--min-hotspot-sites", type=int, default=3)
    parser.add_argument("--hotspot-padding-m", type=float, default=12.0)

    parser.add_argument("--display-search-m", type=float, default=70.0)
    parser.add_argument("--corridor-road-half-width-m", type=float, default=14.0)
    parser.add_argument("--corridor-side-half-width-m", type=float, default=7.0)
    parser.add_argument("--hotspot-road-half-width-m", type=float, default=18.0)
    parser.add_argument("--hotspot-side-half-width-m", type=float, default=9.0)
    args = parser.parse_args()

    network_path = Path(args.network)
    if not network_path.exists():
        raise SystemExit(f"Network snapshot not found: {network_path}. Run build_network.py first.")

    print("[corridors] loading reports")
    sites = latest_sites(read_json_source(args.reports_file, args.reports_url))
    print(f"[corridors] {len(sites):,} current sites")

    edges = gpd.read_file(network_path, layer="edges")
    network_meta_path = Path(args.network_meta)
    network_meta = json.loads(network_meta_path.read_text(encoding="utf-8")) if network_meta_path.exists() else {}

    corridors, matched, summary = build_street_corridors(
        sites,
        edges,
        max_snap_m=args.max_snap_m,
        component_join_m=args.component_join_m,
        side_search_m=args.side_search_m,
        road_membership_m=args.road_membership_m,
        side_membership_m=args.side_membership_m,
        multi_membership_delta_m=args.multi_membership_delta_m,
        max_memberships=args.max_memberships,
        min_corridor_sites=args.min_corridor_sites,
        min_corridor_span_m=args.min_corridor_span_m,
        evidence_padding_m=args.evidence_padding_m,
        hotspot_gap_m=args.hotspot_gap_m,
        min_hotspot_sites=args.min_hotspot_sites,
        hotspot_padding_m=args.hotspot_padding_m,
        display_search_m=args.display_search_m,
        corridor_road_half_width_m=args.corridor_road_half_width_m,
        corridor_side_half_width_m=args.corridor_side_half_width_m,
        hotspot_road_half_width_m=args.hotspot_road_half_width_m,
        hotspot_side_half_width_m=args.hotspot_side_half_width_m,
    )

    now = datetime.now(timezone.utc).isoformat()
    output_meta = {
        "schema_version": 8,
        "model_version": "street-corridors-v8",
        "generated_at": now,
        "network_generated_at": network_meta.get("generated_at"),
        "network_schema_version": network_meta.get("schema_version"),
        "parameters": {
            "component_join_m": args.component_join_m,
            "side_search_m": args.side_search_m,
            "road_membership_m": args.road_membership_m,
            "side_membership_m": args.side_membership_m,
            "min_corridor_sites": args.min_corridor_sites,
            "min_corridor_span_m": args.min_corridor_span_m,
            "hotspot_gap_m": args.hotspot_gap_m,
        },
        **summary,
    }

    write_geojson_with_meta(corridors, Path(args.output), output_meta)
    write_geojson_with_meta(matched, Path(args.matched_output), {"generated_at": now, "schema_version": 8})
    summary_path = Path(args.summary_output)
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(json.dumps(output_meta, ensure_ascii=False, indent=2), encoding="utf-8")

    print(
        f"[corridors] {summary['problem_with_membership_count']}/{summary['active_problem_count']} active problems "
        f"match a street corridor; {summary['displayed_problem_count']} are in displayed corridors"
    )
    print(
        f"[corridors] {summary['street_corridor_count']} corridors; {summary['hotspot_count']} hotspots; "
        f"{summary['multi_membership_problem_count']} intersection/multi-corridor reports"
    )
    if summary["top_corridors"]:
        top = ", ".join(f"{item['name']} ({item['site_count']})" for item in summary["top_corridors"][:8])
        print(f"[corridors] top: {top}")
    snap = summary["snap_distance_m"]
    print(f"[corridors] snap median {snap['median']} m; p95 {snap['p95']} m; max {snap['max']} m")
    print(f"[corridors] wrote {args.output}")


if __name__ == "__main__":
    main()
