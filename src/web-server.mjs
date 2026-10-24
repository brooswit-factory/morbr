import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const server = createServer(async (request, response) => {
  const path = request.url === "/" ? "/management.html" : request.url;
  if (!/^\/(management\.html|management-ui\.js|management-http\.js)$/.test(path)) { response.writeHead(404).end("Not found"); return; }
  const body = await readFile(join(directory, path.slice(1)));
  response.writeHead(200, { "content-type": types[path.endsWith(".html") ? ".html" : ".js"] }).end(body);
});
server.listen(process.env.PORT || 4173, "127.0.0.1", () => console.log(`Morbr management web: http://127.0.0.1:${server.address().port}`));
