# Gdje je zapelo?

Karta prijava problematičnih rubnjaka, prijelaza i prekida u biciklističkoj i pješačkoj infrastrukturi. Varijanta bez koridora u javnom frontendu.

## Pokretanje

```bash
npm install
npm run build
npm start
```

Za lokalni rad kopiraj `.env.example` u `.env`, upiši `KOBO_API_TOKEN` i pokreni `npm run dev`.

## Struktura

- `public/` frontend
- `server.js` HTTP server i static hosting
- `server/` Kobo, GeoJSON i proxy logika
- `analysis/` opcionalna offline OSM analiza; javni frontend ove varijante ne prikazuje koridore
- `form/` Kobo obrazac

`KOBO_API_TOKEN` se postavlja samo kao environment variable i ne sprema se u source.

Za Plus Hosting vidi `DEPLOY_PLUS.md`.
