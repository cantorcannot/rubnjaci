# Plus Hosting / cPanel

Preporučena verzija: **Node.js 24**.

1. Uploadaj projekt izvan `public_html`, npr. u `rubnjaci/`.
2. U cPanelu otvori **Setup Node.js App**.
3. Odaberi Node.js 24 i `Production`.
4. Application root: direktorij projekta.
5. Application URL: željena poddomena.
6. Startup file: `server.js`.
7. Postavi environment varijable iz `.env.example`. `KOBO_API_TOKEN` je tajna.
8. U terminalu ili cPanel npm sučelju pokreni:

```bash
npm install
npm run build
```

9. Restartaj Node aplikaciju.

Aplikacija koristi `PORT` koji dodjeljuje hosting. Ne postavljaj ga ručno ako ga cPanel već daje.

## Brza provjera

- `/` otvara kartu
- `/api/rubnjaci` vraća GeoJSON
- `/prijavi` preusmjerava na Kobo obrazac
- ortofoto radi kroz `/api/ortho/...`

Python iz `analysis/` nije potreban web serveru. U ovoj varijanti frontend ne učitava ni prikazuje koridore.
