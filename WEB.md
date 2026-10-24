# Morbr management UI local verification

Requires Node.js 22.12 or later (Node 24 is the qualified GUI runtime) and
Electron 43.8.3 from the lockfile. Start the isolated fixture shell with
`npm run start:web`, then open `http://127.0.0.1:4173`. With no service
environment variables it intentionally uses disposable fixture DTOs; this is
useful for renderer-only development, not integrated-service verification.

Use the Authorizations section to edit generic JSON configuration or Butchr
label/scopes, then save or cancel. Deployments and Instances are read-only.
Use `npm run start:electron` for the equivalent Electron fixture renderer. For
the integrated disposable-service mode, run the bridge with a local service
and disposable admin credentials, for example:

```
MORBR_SERVICE_URL=http://127.0.0.1:7718 MORBR_UI_USERNAME=admin MORBR_UI_PASSWORD=local-only npm run start:web
MORBR_UI_URL=http://127.0.0.1:4173 npm run start:electron
```

The renderer receives only `/api/`; credentials remain in the local bridge and
are neither stored nor exposed to it. Do not use live credentials.
