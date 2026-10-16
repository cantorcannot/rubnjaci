#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import geopandas as gpd
import osmnx as ox

DEFAULT_FILTER = (
    '["highway"~"primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|'
    'residential|living_street|unclassified|service|cycleway|footway|pedestrian|path|steps|track"]'
)

EXTRA_WAY_TAGS = [
    "bicycle", "cycleway", "cycleway:left", "cycleway:right", "foot", "sidewalk",
    "surface", "smoothness", "crossing", "crossing:signals", "kerb", "lit",
]


def safe_scalar(value):
    if isinstance(value, (list, tuple, set)):
        return "; ".join(str(item) for item in value if item is not None)
    return value


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--place", default="Zagreb, Croatia")
    parser.add_argument("--output", default="analysis/data/zagreb_network.gpkg")
    parser.add_argument("--metadata", default="analysis/data/zagreb_network.meta.json")
    parser.add_argument("--intersection-tolerance", type=float, default=0.0)
    parser.add_argument("--custom-filter", default=DEFAULT_FILTER)
    parser.add_argument("--cache-folder", default="analysis/.osmnx-cache")
    parser.add_argument("--overpass-url", default="https://overpass-api.de/api")
    parser.add_argument("--query-area-size", type=float, default=50_000_000)
    parser.add_argument("--request-timeout", type=int, default=120)
    args = parser.parse_args()

    output = Path(args.output)
    metadata_path = Path(args.metadata)
    output.parent.mkdir(parents=True, exist_ok=True)
    metadata_path.parent.mkdir(parents=True, exist_ok=True)

    ox.settings.use_cache = True
    ox.settings.cache_folder = args.cache_folder
    ox.settings.overpass_url = args.overpass_url
    ox.settings.max_query_area_size = args.query_area_size
    ox.settings.requests_timeout = args.request_timeout
    for tag in EXTRA_WAY_TAGS:
        if tag not in ox.settings.useful_tags_way:
            ox.settings.useful_tags_way.append(tag)

    print(f"[network] downloading {args.place!r}")
    graph = ox.graph.graph_from_place(
        args.place,
        network_type="walk",
        simplify=True,
        retain_all=True,
        custom_filter=args.custom_filter,
    )
    graph = ox.projection.project_graph(graph)

    if args.intersection_tolerance > 0:
        graph = ox.simplification.consolidate_intersections(
            graph,
            tolerance=args.intersection_tolerance,
            rebuild_graph=True,
            reconnect_edges=True,
        )

    graph = ox.convert.to_undirected(graph)
    nodes, edges = ox.convert.graph_to_gdfs(graph, nodes=True, edges=True, fill_edge_geometry=True)
    nodes = nodes.reset_index()
    edges = edges.reset_index()

    for frame in (nodes, edges):
        for column in frame.columns:
            if column != "geometry" and frame[column].dtype == "object":
                frame[column] = frame[column].map(safe_scalar)

    duplicates = edges.geometry.to_wkb().duplicated(keep="first")
    if duplicates.any():
        print(f"[network] dropping {int(duplicates.sum()):,} duplicate edge geometries")
        edges = edges.loc[~duplicates].copy().reset_index(drop=True)

    edges["edge_id"] = [f"e-{u}-{v}-{key}" for u, v, key in zip(edges["u"], edges["v"], edges["key"])]
    edges["edge_length_m"] = edges.geometry.length.astype(float)

    edge_columns = [
        column for column in [
            "edge_id", "u", "v", "key", "osmid", "name", "highway", "bicycle", "cycleway",
            "foot", "sidewalk", "surface", "smoothness", "crossing", "kerb", "edge_length_m",
            "geometry",
        ] if column in edges.columns
    ]
    edges = gpd.GeoDataFrame(edges[edge_columns], geometry="geometry", crs=edges.crs)
    if output.exists():
        output.unlink()
    nodes.to_file(output, layer="nodes", driver="GPKG")
    edges.to_file(output, layer="edges", driver="GPKG")

    metadata = {
        "schema_version": 2,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "place": args.place,
        "crs": str(edges.crs),
        "intersection_tolerance_m": args.intersection_tolerance,
        "custom_filter": args.custom_filter,
        "node_count": int(len(nodes)),
        "edge_count": int(len(edges)),
        "osmnx_version": ox.__version__,
    }
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[network] wrote {output}")
    print(f"[network] wrote {metadata_path}")


if __name__ == "__main__":
    main()
