import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const basic = (username, password) => `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
const managementRoute = (method, route) =>
  (method === "GET" && ["/management", "/events/activity"].includes(route)) ||
  (method === "PATCH" && route === "/config") ||
  (method === "POST" && ["/management/users", "/management/authorizations"].includes(route)) ||
  (["PATCH", "DELETE"].includes(method) && /^\/management\/(users|authorizations)\/[A-Za-z0-9_-]+$/.test(route));
const writesJson = (method) => !["GET", "HEAD", "DELETE"].includes(method);
const jsonContentType = (value) => value?.split(";", 1)[0].trim().toLowerCase() === "application/json";

/** Same-origin UI server. Optional upstream credentials never reach the renderer. */
export function createManagementWebServer({ serviceUrl, username, password } = {}) {
  const serviceOrigin = serviceUrl && new URL(serviceUrl).origin;
  return createServer(async (request, response) => {
    const requestUrl = new URL(request.url, "http://ui.local");
    const path = requestUrl.pathname;
    if (path === "/management-config.js") {
      response.writeHead(200, { "content-type": types[".js"] });
      response.end(serviceUrl ? "globalThis.morbrManagement = { baseUrl: '/api/' };" : "");
      return;
    }
    if (path.startsWith("/api/")) {
      if (!serviceUrl || username === undefined || password === undefined) { response.writeHead(503).end("Management service is not configured"); return; }
      const suppliedOrigin = request.headers.origin;
      const expectedOrigin = `http://${request.headers.host}`;
      if (suppliedOrigin && suppliedOrigin !== expectedOrigin) { response.writeHead(403).end("Cross-origin management requests are not allowed"); return; }
      const route = path.slice(4);
      if (!managementRoute(request.method, route)) { response.writeHead(404).end("Not found"); return; }
      if (writesJson(request.method) && !jsonContentType(request.headers["content-type"])) { response.writeHead(415).end("Management writes require application/json"); return; }
      const target = new URL(`${route}${requestUrl.search}`, serviceOrigin);
      if (target.origin !== serviceOrigin) { response.writeHead(400).end("Invalid management destination"); return; }
      let upstream;
      try {
        upstream = await fetch(target, { method: request.method, redirect: "error", headers: { authorization: basic(username, password), ...(writesJson(request.method) ? { "content-type": request.headers["content-type"] } : {}), accept: request.headers.accept ?? "application/json" }, body: ["GET", "HEAD"].includes(request.method) ? undefined : Readable.toWeb(request), duplex: "half" });
      } catch {
        response.writeHead(502).end("Management service request failed");
        return;
      }
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
