# Morbr

Morbr is an isolated client/integration package for the Morbin architecture.

## Build and verify

Requires Node.js 20 or newer. A clean checkout is reproducible with:

```sh
npm ci
npm run build
npm test
```

## Dependency consumption

Morbr does not consume legacy `butchr`. When it begins consuming Morbin, use a
pinned commit or workspace dependency until an approved package release exists:

```json
{ "dependencies": { "@brooswit-factory/morbin": "github:brooswit-factory/morbin#<commit>" } }
```
