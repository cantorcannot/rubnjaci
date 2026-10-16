# Analiza koridora

Python alati su offline dio projekta i nisu potrebni Node web serveru.

```powershell
python -m venv .venv-corridors
.\.venv-corridors\Scripts\Activate.ps1
pip install -r analysis\requirements.txt
python analysis\build_network.py
python analysis\build_corridors.py --reports-url https://DOMENA/api/rubnjaci
```

`build_network.py` po defaultu dijeli Overpass upit na manje dijelove (`50 km²`, timeout `120 s`). Po potrebi se mogu promijeniti:

```powershell
python analysis\build_network.py --query-area-size 100000000 --request-timeout 180 --overpass-url https://overpass-api.de/api
```

Generirani `analysis/data/` i `analysis/output/` nisu dio source paketa. Frontend koristi `public/data/corridors.geojson`.
