import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMorbin } from "@brooswit-factory/morbin";
import { createMorbr, createMorbrHttpServer } from "../src/index.js";
import { createButchrd } from "../../butchrd-final/src/index.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check) { for (let i = 0; i < 80; i += 1) { try { if (check()) return; } catch {} await tick(); } assert.fail("timed out"); }

test("actual Morbr demand refresh fails retryably then permits only capable local fallback", async () => {
  let clock = 0; let upstreamCalls = 0; let failUpstream = false; let capableCalls = 0;
  const upstreamArguments = []; const localArguments = [];
  const upstream = createMorbin({ providers: { source: { fetch: async resource => {
    upstreamArguments.push(resource); upstreamCalls += 1;
    if (failUpstream) {
      const error = Object.assign(new Error("retryable fake upstream outage"), { code: "PROVIDER_UNAVAILABLE", retryable: true });
      throw error;
    }
    return { revision: upstreamCalls };
  } } }, freshness: { pull: [2, 2], upstream: [2, 2], push: [4, 4] }, now: () => clock });
  const statePath = join(await mkdtemp(join(tmpdir(), "factory-1033-final-")), "state.json");
  const service = await createMorbr({ statePath, morbin: upstream, upstreamFreshness: { minimumMs: 2, maximumMs: 2 }, morbinFreshness: { pull: [2, 2], upstream: [2, 2], push: [4, 4] }, demandPollIntervalMs: 1 });
  await service.createUser({ username: "admin", password: "fixture-password", role: "admin" });
  const admin = service.authenticate({ username: "admin", password: "fixture-password" });
  const http = createMorbrHttpServer({ service }); const address = await http.start();
  const makeDaemon = async capable => {
    const values = new Map();
    // The incapable daemon intentionally has no provider object at all.  A
    // connected reporting token must not manufacture that local capability.
    const providers = capable ? { local: { fetch: async resource => {
      localArguments.push(resource); return { revision: `local-${++capableCalls}` };
    } } } : {};
    const local = createMorbin({ providers, freshness: { pull: [5, 5], upstream: [5, 5], push: [5, 5] }, now: () => clock });
    const daemon = createButchrd({ store: { get: k => values.get(k), set: (k, v) => values.set(k, v) }, morbin: local, local: { capabilities: capable, providers: capable ? { local: {} } : {}, freshness: { pull: [5, 5], upstream: [5, 5] } } });
    const identity = { deploymentId: daemon.deploymentId, type: "generic" }; await service.registerDeployment(identity); const instance = await service.startInstance(identity); const key = await service.issueKey(admin, { ...identity, scopes: ["reporting"], label: capable ? "capable" : "incapable" });
    const envelopes = []; let reader;
    const transport = { subscribe: async ({ onEnvelope }) => { const u = `http://127.0.0.1:${address.port}/events/resource?deploymentId=${identity.deploymentId}&type=generic&instanceId=${instance.id}&provider=source&resource=r&subject=resource-r&subscriptionId=resource&streamEpoch=1`; const response = await fetch(u, { headers: { authorization: `Bearer ${key.token}` } }); reader = response.body.getReader(); void (async () => { let text = ""; for (;;) { const part = await reader.read(); if (part.done) break; text += new TextDecoder().decode(part.value); let end; while ((end = text.indexOf("\n\n")) >= 0) { const data = text.slice(0, end).match(/^data: (.+)$/m)?.[1]; text = text.slice(end + 2); if (data) { const envelope = JSON.parse(data); envelopes.push(envelope); onEnvelope(envelope); } } } })(); return { close: () => void reader.cancel() }; } };
    const connected = createButchrd({ store: { get: k => values.get(k), set: (k, v) => values.set(k, v) }, morbin: local, local: { capabilities: capable, providers: capable ? { local: {} } : {}, freshness: { pull: [5, 5], upstream: [5, 5] }, pollIntervalMs: capable ? 1 : undefined, transport } });
    const run = await connected.start({ mode: "connected", connectedSubscriptions: [{ id: "resource", subject: { kind: "resource", key: "resource-r" }, watchMode: "resource", provider: "local", resource: "r" }] });
    return { connected, run, envelopes, reportingToken: key.token, hasLocalProvider: Object.hasOwn(providers, "local") };
  };
  const capable = await makeDaemon(true); const incapable = await makeDaemon(false);
  try {
    await eventually(() => capable.connected.activity.some(e => e.kind === "envelope-received") && incapable.connected.activity.some(e => e.kind === "envelope-received"));
    assert.deepEqual(await capable.connected.monitoring.read("local", "r"), { revision: 1 });
    assert.equal(capableCalls, 0, "fresh upstream envelope postpones capable fallback");
    assert.deepEqual(upstreamArguments, ["r"], "actual resource demand reaches the fake upstream with only its resource");

    // Start the capable daemon's real local watch only after the connected
    // cache is healthy; its lifecycle-owned interval must then respect that
    // upstream value rather than eagerly fetching a fallback.
    capable.fallbackRun = await capable.connected.start({ watches: [{ provider: "local", resource: "r" }] });
    await delay(5);
    assert.equal(capableCalls, 0, "the actual local watch observes the healthy upstream cache first");

    clock = 3;
    await eventually(() => upstreamCalls === 2);
    await eventually(() => capable.connected.monitoring.cacheEntry("local", "r")?.value?.revision === 2);
    assert.equal(capableCalls, 0, "healthy demand-timer refresh remains upstream-first");

    failUpstream = true;
    clock = 6;
    await eventually(() => capable.envelopes.some(e => e.kind === "error" && e.error?.code === "PROVIDER_UNAVAILABLE"));
    const wireError = capable.envelopes.find(e => e.kind === "error" && e.error?.code === "PROVIDER_UNAVAILABLE");
    const persistedError = service.listActivity(admin, capable.connected.deploymentId).find(e => e.type === "morbin.error");
    assert.equal(wireError.error.retryable, true, "the SSE wire preserves a retryable provider outage");
    assert.equal(persistedError.payload.error.retryable, true, "persisted Morbr activity preserves the retryable outage");
    assert.ok(service.morbinSubscriptions.size > 0 && service.demandPollTimer, "retryable outage leaves central demand live before explicit stop");
    clock = 9;
    await eventually(() => capableCalls === 1);
    assert.deepEqual(await capable.connected.monitoring.read("local", "r"), { revision: "local-1" });
    clock = 15;
    await eventually(() => capableCalls === 2);
    assert.deepEqual(await capable.connected.monitoring.read("local", "r"), { revision: "local-2" });
    assert.deepEqual(localArguments, ["r", "r"], "two fallback pulls use only the explicit local resource mapping");

    clock = 1_000;
    await assert.rejects(incapable.connected.monitoring.read("local", "r"));
    assert.equal(incapable.hasLocalProvider, false, "incapable consumer has no provider that an upstream token could invoke");
    const persisted = await readFile(statePath, "utf8");
    assert.ok(!persisted.includes(capable.reportingToken), "central reporting token is absent from persisted fixture activity");
    assert.ok(!JSON.stringify([...localArguments, ...upstreamArguments]).includes(capable.reportingToken), "central reporting token is absent from provider arguments");

    capable.fallbackRun.stop(); capable.run.stop(); incapable.run.stop();
    // A tick already entered before the last SSE reader closes may finish;
    // wait for both wire readers to release their real Morbr demand handles,
    // then demand must remain quiescent.
    await eventually(() => service.morbinSubscriptions.size === 0);
    const upstreamAfterClose = upstreamCalls;
    await delay(10);
    assert.equal(upstreamCalls, upstreamAfterClose, "closing both consumers stops central demand polling");
  } finally { capable.fallbackRun?.stop(); capable.run.stop(); incapable.run.stop(); await http.close(); }
});
