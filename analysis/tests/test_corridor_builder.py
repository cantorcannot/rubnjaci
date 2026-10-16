from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import geopandas as gpd
from shapely.geometry import LineString, Point

MODULE_PATH = Path(__file__).resolve().parents[1] / "build_corridors.py"
spec = importlib.util.spec_from_file_location("build_corridors", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
assert spec.loader is not None
spec.loader.exec_module(module)


def make_edges():
    rows = []
    edge_no = 0

    def add(a, b, *, name="", highway="footway"):
        nonlocal edge_no
        edge_no += 1
        geometry = LineString([a, b])
        rows.append({
            "edge_id": f"e{edge_no}",
            "u": edge_no * 2,
            "v": edge_no * 2 + 1,
            "name": name,
            "highway": highway,
            "edge_length_m": geometry.length,
            "geometry": geometry,
        })

    # Two carriageways, one side cycleway and one side footway.
    for y in (0, 16):
        add((0, y), (160, y), name="Avenija Test", highway="primary")
        add((160, y), (340, y), name="Avenija Test", highway="primary")
    add((0, -12), (340, -12), highway="cycleway")
    add((0, 28), (340, 28), highway="footway")

    # Crossing footway at x=170 must still belong to the avenue profile.
    add((170, -30), (170, 45), highway="footway")

    # Nearby named cross street allows intersection membership in both corridors.
    add((170, -120), (170, 140), name="Poprečna ulica", highway="secondary")

    # Three points on a footway beside this street should create a corridor too.
    add((0, 180), (300, 180), name="Ulica Žarka Testa", highway="residential")
    add((0, 194), (300, 194), highway="footway")

    return gpd.GeoDataFrame(rows, geometry="geometry", crs="EPSG:3857")


def make_sites():
    points = [
        (25, -12),   # cycleway
        (75, 0),     # north carriageway
        (125, 28),   # footway
        (170, 8),    # intersection
        (220, 16),   # south carriageway
        (275, -12),  # cycleway
        (320, 28),   # footway
        (30, 194), (150, 194), (280, 194),  # Žarka footway
    ]
    rows = []
    for index, point in enumerate(points, start=1):
        rows.append({
            "site_id": f"s{index}",
            "datum": None,
            "vrsta": "rubnjak_nedovoljno_spusten_ili_ostecen",
            "promjena_stanja": "",
            "visina_cm": 4,
            "geometry": Point(*point),
        })
    return gpd.GeoDataFrame(rows, geometry="geometry", crs="EPSG:3857")


def build(sites=None):
    return module.build_street_corridors(
        sites if sites is not None else make_sites(),
        make_edges(),
        max_snap_m=35,
        component_join_m=22,
        side_search_m=34,
        road_membership_m=22,
        side_membership_m=8,
        multi_membership_delta_m=8,
        max_memberships=2,
        min_corridor_sites=3,
        min_corridor_span_m=100,
        evidence_padding_m=0,
        hotspot_gap_m=90,
        min_hotspot_sites=3,
        hotspot_padding_m=0,
        display_search_m=38,
        corridor_road_half_width_m=8,
        corridor_side_half_width_m=5,
        hotspot_road_half_width_m=10,
        hotspot_side_half_width_m=6,
    )


def test_corridor_membership_includes_both_carriageways_and_side_paths():
    output, matched, summary = build()

    avenue = output[(output["feature_role"] == "corridor_area") & (output["corridor_name"] == "Avenija Test")].iloc[0]
    assert avenue.site_count == 7
    assert avenue.geometry.geom_type in {"Polygon", "MultiPolygon"}
    minx, miny, maxx, maxy = avenue.geometry.bounds
    assert miny < -12 and maxy > 28
    assert maxx - minx > 280

    zarka = output[(output["feature_role"] == "corridor_area") & (output["corridor_name"] == "Ulica Žarka Testa")].iloc[0]
    assert zarka.site_count == 3

    assert summary["street_corridor_count"] >= 2
    assert summary["problem_with_membership_count"] == 10
    assert matched.loc[matched["site_id"] == "s3", "corridor_names"].iloc[0].find("Avenija Test") >= 0


def test_intersection_can_belong_to_two_corridors():
    output, matched, summary = build()
    row = matched[matched["site_id"] == "s4"].iloc[0]
    assert row.corridor_membership_count == 2
    assert "Avenija Test" in row.corridor_names
    assert "Poprečna ulica" in row.corridor_names
    assert summary["multi_membership_problem_count"] >= 1


def test_good_example_breaks_hotspot_not_corridor():
    sites = make_sites()
    blocker = gpd.GeoDataFrame([{
        "site_id": "good",
        "datum": None,
        "vrsta": "dobar_primjer",
        "promjena_stanja": "",
        "visina_cm": 0,
        "geometry": Point(100, -12),
    }], geometry="geometry", crs="EPSG:3857")
    sites = gpd.GeoDataFrame(
        list(sites.to_dict("records")) + list(blocker.to_dict("records")),
        geometry="geometry", crs="EPSG:3857",
    )

    output, _, _ = build(sites)
    avenue = output[(output["feature_role"] == "corridor_area") & (output["corridor_name"] == "Avenija Test")].iloc[0]
    assert avenue.site_count == 7

if __name__ == "__main__":
    test_corridor_membership_includes_both_carriageways_and_side_paths()
    test_intersection_can_belong_to_two_corridors()
    test_good_example_breaks_hotspot_not_corridor()
    print("corridor tests: OK")
