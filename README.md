# Morbr

Morbr is a generic central service for persisted configuration and deployment
activity. It is not an autonomous task launcher and it does not execute events.

## Auth and state boundary

- Users authenticate with a username and password; only salted password digests
  are persisted. Authentication returns an opaque, server-issued session and
  roles are resolved from persisted state. The first user must be an `admin`;
  later users require an authenticated admin. `reader` can only view activity.
- Configuration/reporting keys are distinct from user roles, scope-limited,
  bound to one deployment and service type, and stored as one-way digests.
  Revocation is central and takes effect immediately; protected requests fail
  safely with `UNAUTHORIZED` or `FORBIDDEN`.
- Deployments use client-supplied stable IDs that survive reloads. Every start
  creates a fresh ephemeral runtime instance ID. Activity is retained against
  both identities.
- State is local JSON with replace-on-write persistence. Test credentials are
  disposable fixtures only; no live credential or deployment configuration is
  included.

Morbin config/event-stream integration is deliberately outside this initial
service implementation: Morbr consumes the approved pinned Morbin library
(`39e47eb8089e6ef17426e8607beec21759b30c40`) through its public API. Morbr
adapts resource-stream envelopes into persisted activity and can ingest upstream
events through Morbin; it does not copy polling or replay mechanics and never
passes a Morbr credential to a provider. Config consumers receive an immediate
snapshot and each committed, de-duplicated change in version order until their
scoped key is revoked. Terminal Morbin stream errors are retained as safe plain
data (`code`, `message`, `retryable: false`) for live consumers and reloads.

## Build and verify

Requires Node.js 20 or newer.

```sh
npm ci
npm run build
npm test
```
