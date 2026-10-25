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

Morbin remains a separate shared-library implementation: Morbr consumes the
approved pinned Morbin library
(`39e47eb8089e6ef17426e8607beec21759b30c40`) through its public API. Morbr
adapts resource-stream envelopes into persisted activity and can ingest upstream
events through Morbin; it does not copy polling or replay mechanics and never
passes a Morbr credential to a provider. Config consumers receive an immediate
snapshot and each committed, de-duplicated change in version order until their
scoped key is revoked. Terminal Morbin stream errors are retained as safe plain
data (`code`, `message`, `retryable: false`) for live consumers and reloads.

## Upstream freshness and active demand

`createMorbr` accepts the actual configured `upstreamFreshness` bounds as
`{ minimumMs, maximumMs }`; the default is Morbin's upstream `[4000, 6000]`
range. `upstreamFreshnessBounds()` and the sanitized management snapshot expose
those bounds plus `demandPollIntervalMs` to connected composition. Supplying
`connectedPollMinimumMs` validates the contract that the connected consumer's
minimum is strictly greater than Morbr's upstream maximum.

Morbr owns only the lifecycle around Morbin's existing `watchResource` and
`poll` APIs. An authorized subscription maps explicitly to its `provider` and
`resource`, starts active stale-demand polling, and records the resulting
Morbin envelopes as activity. Closing the final subscription stops that timer.
Morbr does not parse opaque consumer subjects, build a fallback registry, or
give a consumer central credentials.

## Current transport scope

The exported service implements persisted local state, config subscriptions,
Morbin resource-stream consumption, and `ingestMorbinEvent` for authorized
upstream/client event chaining. `createMorbrHttpServer` supplies a runnable
HTTP boundary: Basic-authenticated `/management` and `/config`, bearer-key
SSE `/events/config`, bearer reporting-key SSE `/events/resource`,
Basic-authenticated `/events/activity`, and signed `/webhooks/:name` ingestion.
`/events/resource` takes explicit `provider` and `resource` values plus an
opaque `subject`; it preserves that subject and publishes the configured
upstream freshness bounds, without parsing it or distributing credentials to a
consumer. `start({host, port})` and `close()` make startup and shutdown
explicit for local or remote hosting.

Webhook bindings are startup-only injected fixtures containing a secret,
scoped reporting token, identity, and optional instance ID. Fixture signatures
are `sha256=<HMAC-SHA256(JSON.stringify(parsedBody))>` in
`x-morbr-signature`; this is deliberately documented test policy, not a
production canonicalization/replay-protection design. Production transport
configuration still needs an explicit raw-body signing and replay policy.
FACTORY-1033 owns full cross-repository verification.

## Management UI boundary

`createManagementClient(service, session)` is the only intended service surface
for the FACTORY-1031 management UI. `getSnapshot()` returns these sanitized DTOs:
`authorizations` (id/label/deployment/type/scopes/revoked), `deployments`,
`instances`, `users` (username/role), activity metadata, counts, and config.
It never returns raw state, password/key digests, salts, or principal records.

The facade exposes `setConfig`, `createUser`, `updateUser`,
`issueAuthorization`, `updateAuthorization`, `revokeAuthorization`, and
`subscribeActivity`. All mutations remain server-role-authorized; a reader can
read a snapshot but cannot use an admin mutation. Activity subscription events
contain metadata only, never the stored payload.

## Build and verify

Requires Node.js 20 or newer.

```sh
npm ci
npm run build
npm test
```
