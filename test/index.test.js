import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMorbr, MorbrError } from "../src/index.js";

async function fixture() {
  const root = process.env.MORBR_TEST_TMPDIR ?? tmpdir();
  await mkdir(root, { recursive: true });
  const path = join(await mkdtemp(join(root, "morbr-test-")), "state.json");
  const service = await createMorbr({ statePath: path });
  const admin = await service.createUser({ username: "admin", password: "fixture-password", role: "admin" });
  const reader = await service.createUser({ username: "reader", password: "fixture-password", role: "reader" });
  return { path, service, admin: service.authenticate({ username: admin.username, password: "fixture-password" }), reader: service.authenticate({ username: reader.username, password: "fixture-password" }) };
}

test("reader authorization cannot mutate stored config", async () => {
  const { service, reader } = await fixture();
  await assert.rejects(service.setConfig(reader, { enabled: true }), (error) => error instanceof MorbrError && error.code === "FORBIDDEN");
});

test("revoked configuration key cannot access protected config", async () => {
  const { service, admin } = await fixture();
  const key = await service.issueKey(admin, { scopes: ["config"], label: "disposable test key" });
  await service.setConfig(admin, { interval: 30 });
  assert.deepEqual(service.getConfig(key.token), { version: 1, value: { interval: 30 } });
  await service.revokeKey(admin, key.id);
  assert.throws(() => service.getConfig(key.token), (error) => error instanceof MorbrError && error.code === "UNAUTHORIZED");
});

test("state survives reload while deployment identity is stable and instances are ephemeral", async () => {
  const { path, service, admin } = await fixture();
  const key = await service.issueKey(admin, { scopes: ["reporting"] });
  await service.registerDeployment({ deploymentId: "deploy-fixture", name: "fixture" });
  const first = await service.startInstance({ deploymentId: "deploy-fixture" });
  await service.recordActivity(key.token, { deploymentId: "deploy-fixture", instanceId: first.id, type: "started" });

  const reloaded = await createMorbr({ statePath: path });
  const second = await reloaded.startInstance({ deploymentId: "deploy-fixture" });
  assert.notEqual(first.id, second.id);
  assert.deepEqual(reloaded.listActivity(reloaded.authenticate({ username: "admin", password: "fixture-password" }), "deploy-fixture").map(({ type, deploymentId }) => ({ type, deploymentId })), [{ type: "started", deploymentId: "deploy-fixture" }]);
});

test("config snapshots are de-duplicated", async () => {
  const { service, admin } = await fixture();
  assert.equal((await service.setConfig(admin, { mode: "safe" })).version, 1);
  assert.equal((await service.setConfig(admin, { mode: "safe" })).version, 1);
});
