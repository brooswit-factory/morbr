# Morbr management UI local verification

Start the isolated web shell with `npm run start:web`, then open
`http://127.0.0.1:4173`. It serves only the management HTML/module and uses
disposable fixture DTOs. This workflow deliberately avoids the service-owned
package scripts until the FACTORY-1030 reconciliation is agreed.

Use the Authorizations section to edit generic JSON configuration or Butchr
label/scopes, then save or cancel. Deployments and Instances are read-only.
Use `npm run start:electron` for the equivalent Electron fixture renderer. For
a disposable local service hookup, start the same-origin bridge with
`MORBR_SERVICE_URL`, `MORBR_UI_USERNAME`, and `MORBR_UI_PASSWORD`, then load
that bridge in Electron with `MORBR_UI_URL=http://127.0.0.1:4173 npm run
start:electron`. The renderer receives only `/api/`; credentials stay in the
local bridge and are neither stored nor exposed to it.
