import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMorbin } from "@brooswit-factory/morbin";
import { createMorbr, createMorbrHttpServer } from "../src/index.js";
import { createButchrd } from "../../butchrd-final/src/index.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function eventually(check) { for (let i = 0; i < 80; i += 1) { try { if (check()) return; } catch {} await tick(); } assert.fail("timed out"); }

test("actual Morbr resource SSE refreshes capable consumers before independent fallback", async () => {
  let clock = 0; let upstreamCalls = 0; let capableCalls = 0; let incapableCalls = 0;
  const upstream = createMorbin({ providers: { source: { fetch: async () => ({ revision: ++upstreamCalls }) } }, freshness: { pull: [2, 2], upstream: [2, 2], push: [4, 4] }, now: () => clock });
  const service = await createMorbr({ statePath: join(await mkdtemp(join(tmpdir(), "factory-1033-final-")), "state.json"), morbin: upstream, upstreamFreshness: { minimumMs: 2, maximumMs: 2 }, morbinFreshness: { pull: [2, 2], upstream: [2, 2], push: [4, 4] }, demandPollIntervalMs: 1 });
  await service.createUser({ username: "admin", password: "fixture-password", role: "admin" });
  const admin = service.authenticate({ username: "admin", password: "fixture-password" });
  const http = createMorbrHttpServer({ service }); const address = await http.start();
  const makeDaemon = async (capable) => {
    const values = new Map();
    const local = createMorbin({ providers: capable ? { local: { fetch: async () => ({ revision: `local-${++capableCalls}` }) } } : { local: { fetch: async () => { incapableCalls += 1; throw new Error("must not fallback"); } } }, freshness: { pull: [5, 5], upstream: [5, 5], push: [5, 5] }, now: () => clock });
    const daemon = createButchrd({ store: { get: k => values.get(k), set: (k, v) => values.set(k, v) }, morbin: local, local: { capabilities: capable, providers: capable ? { local: {} } : {}, freshness: { pull: [5, 5], upstream: [5, 5] } } });
    const identity = { deploymentId: daemon.deploymentId, type: "generic" }; await service.registerDeployment(identity); const instance = await service.startInstance(identity); const key = await service.issueKey(admin, { ...identity, scopes: ["reporting"], label: capable ? "capable" : "incapable" });
    let reader;
    const transport = { subscribe: async ({ onEnvelope }) => { const u = `http://127.0.0.1:${address.port}/events/resource?deploymentId=${identity.deploymentId}&type=generic&instanceId=${instance.id}&provider=source&resource=r&subject=resource-r&subscriptionId=resource&streamEpoch=1`; const response = await fetch(u, { headers: { authorization: `Bearer ${key.token}` } }); reader = response.body.getReader(); void (async () => { let text = ""; for (;;) { const part = await reader.read(); if (part.done) break; text += new TextDecoder().decode(part.value); let end; while ((end = text.indexOf("\n\n")) >= 0) { const data = text.slice(0, end).match(/^data: (.+)$/m)?.[1]; text = text.slice(end + 2); if (data) onEnvelope(JSON.parse(data)); } } })(); return { close: () => void reader.cancel() }; } };
    const connected = createButchrd({ store: { get: k => values.get(k), set: (k, v) => values.set(k, v) }, morbin: local, local: { capabilities: capable, providers: capable ? { local: {} } : {}, freshness: { pull: [5, 5], upstream: [5, 5] }, transport } });
    const run = await connected.start({ mode: "connected", connectedSubscriptions: [{ id: "resource", subject: { kind: "resource", key: "resource-r" }, watchMode: "resource", provider: "local", resource: "r" }] });
    return { connected, run };
  };
  const capable = await makeDaemon(true); const incapable = await makeDaemon(false);
  try {
    await eventually(() => capable.connected.activity.some(e => e.kind === "envelope-received") && incapable.connected.activity.some(e => e.kind === "envelope-received"));
    assert.deepEqual(await capable.connected.monitoring.read("local", "r"), { revision: 1 });
    assert.equal(capableCalls, 0, "fresh upstream envelope postpones capable fallback");
    clock = 6;
    assert.deepEqual(await capable.connected.monitoring.read("local", "r"), { revision: "local-1" });
    await assert.rejects(incapable.connected.monitoring.read("local", "r"));
    assert.equal(incapableCalls, 1, "incapable consumer never gains protected fallback credential");
  } finally { capable.run.stop(); incapable.run.stop(); await http.close(); }
});
