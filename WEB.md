# Morbr management UI local verification

Start the isolated web shell with `node src/web-server.mjs`, then open
`http://127.0.0.1:4173`. It serves only the management HTML/module and uses
disposable fixture DTOs. This workflow deliberately avoids the service-owned
package scripts until the FACTORY-1030 reconciliation is agreed.

Use the Authorizations section to edit generic JSON configuration or Butchr
label/scopes, then save or cancel. Deployments and Instances are read-only.
Use `npm run start:electron` for the equivalent Electron renderer when the
host provides Electron. For a disposable local service hookup, a controlled
host may set `globalThis.morbrManagement` before loading the module with
`{ baseUrl, username, password }`; the page then uses the public sanitized
HTTP/SSE bridge. It neither saves those values nor accesses service internals.
