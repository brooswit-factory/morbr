import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const basic = (username, password) => `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;

/** Same-origin UI server. Optional upstream credentials never reach the renderer. */
export function createManagementWebServer({ serviceUrl, username, password } = {}) {
  return createServer(async (request, response) => {
    const path = new URL(request.url, "http://ui.local").pathname;
    if (path === "/management-config.js") {
      response.writeHead(200, { "content-type": types[".js"] });
      response.end(serviceUrl ? "globalThis.morbrManagement = { baseUrl: '/api/' };" : "");
      return;
    }
    if (path.startsWith("/api/")) {
      if (!serviceUrl || username === undefined || password === undefined) { response.writeHead(503).end("Management service is not configured"); return; }
      const target = new URL(path.slice(5) + new URL(request.url, "http://ui.local").search, new URL(serviceUrl.endsWith("/") ? serviceUrl : `${serviceUrl}/`));
      const upstream = await fetch(target, { method: request.method, headers: { authorization: basic(username, password), "content-type": request.headers["content-type"] ?? "application/json", accept: request.headers.accept ?? "application/json" }, body: ["GET", "HEAD"].includes(request.method) ? undefined : Readable.toWeb(request), duplex: "half" });
      response.writeHead(upstream.status, Object.fromEntries(["content-type", "cache-control"].flatMap((name) => upstream.headers.has(name) ? [[name, upstream.headers.get(name)]] : [])));
      if (!upstream.body) return response.end();
      Readable.fromWeb(upstream.body).pipe(response);
      return;
    }
    if (!/^\/(management\.html|management-ui\.js|management-http\.js)$/.test(path) && path !== "/") { response.writeHead(404).end("Not found"); return; }
    const file = path === "/" ? "management.html" : path.slice(1);
    const body = await readFile(join(directory, file));
    response.writeHead(200, { "content-type": types[file.endsWith(".html") ? ".html" : ".js"] }).end(body);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createManagementWebServer({ serviceUrl: process.env.MORBR_SERVICE_URL, username: process.env.MORBR_UI_USERNAME, password: process.env.MORBR_UI_PASSWORD });
  server.listen(process.env.PORT || 4173, "127.0.0.1", () => console.log(`Morbr management web: http://127.0.0.1:${server.address().port}`));
}
