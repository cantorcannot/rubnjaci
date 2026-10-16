import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getEnv } from "./server/env.js";
import { ortho, photo, prijavi, rubnjaci } from "./server/routes.js";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = resolve(ROOT, process.env.PUBLIC_DIR || "dist/public");
const FALLBACK_PUBLIC_DIR = resolve(ROOT, "public");
const env = getEnv();
const port = Number(process.env.PORT || 3000);

const MIME = new Map([
  [".html", "text/html; charset=utf-8"], [".css", "text/css; charset=utf-8"], [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"], [".geojson", "application/geo+json; charset=utf-8"], [".png", "image/png"],
  [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".svg", "image/svg+xml"], [".webmanifest", "application/manifest+json; charset=utf-8"]
]);

function securityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "geolocation=(self), camera=(), microphone=()");
}

async function publicRoot() {
  try { if ((await stat(PUBLIC_DIR)).isDirectory()) return PUBLIC_DIR; } catch {}
  return FALLBACK_PUBLIC_DIR;
}

async function serveStatic(url, req, res) {
  const root = await publicRoot();
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return false; }
  if (pathname === "/") pathname = "/index.html";
  const candidate = resolve(root, `.${pathname}`);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return false;

  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
    const body = req.method === "HEAD" ? null : await readFile(candidate);
    const extension = extname(candidate).toLowerCase();
    res.setHeader("Content-Type", MIME.get(extension) || "application/octet-stream");
    res.setHeader("Content-Length", String(info.size));
    const noStore = pathname === "/config.json" || extension === ".geojson";
    res.setHeader("Cache-Control", noStore ? "no-store" : [".html", ".css", ".js"].includes(extension) ? "no-cache" : "public, max-age=604800");
    res.writeHead(200);
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProto === "https" ? "https" : req.socket.encrypted ? "https" : "http";
  const url = new URL(req.url || "/", `${protocol}://${req.headers.host || "localhost"}`);

  try {
    if (req.method === "GET" && url.pathname === "/api/rubnjaci") return void await rubnjaci(env, res);
    if (req.method === "GET" && url.pathname === "/prijavi") return void await prijavi(env, url, res);

    const photoMatch = url.pathname.match(/^\/api\/photo\/(\d+)\/(foto_mjerenja|foto_konteksta)$/);
    if (req.method === "GET" && photoMatch) return void await photo(env, photoMatch[1], photoMatch[2], res);

    const orthoMatch = url.pathname.match(/^\/api\/ortho\/(\d+)\/(\d+)\/(\d+)\.(?:png|jpg|jpeg)$/i);
    if (req.method === "GET" && orthoMatch) return void await ortho(env, orthoMatch[1], orthoMatch[2], orthoMatch[3], res);

    if ((req.method === "GET" || req.method === "HEAD") && await serveStatic(url, req, res)) return;
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end("Not found");
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end("Interna greška poslužitelja.");
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Gdje je zapelo? listening on port ${port}`);
});
