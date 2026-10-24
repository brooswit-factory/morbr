import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMorbin } from "@brooswit-factory/morbin";
import { createManagementClient, createMorbr, MorbrError } from "../src/index.js";

const generic = { deploymentId: "deploy-generic", type: "generic" };
const butchr = { deploymentId: "deploy-butchr", type: "butchr" };

async function fixture() {
  const root = process.env.MORBR_TEST_TMPDIR ?? tmpdir();
  await mkdir(root, { recursive: true });
  const path = join(await mkdtemp(join(root, "morbr-test-")), "state.json");
  const service = await createMorbr({ statePath: path });
  await service.createUser({ username: "admin", password: "fixture-password", role: "admin" });
  const admin = service.authenticate({ username: "admin", password: "fixture-password" });
  await service.createUser(admin, { username: "reader", password: "fixture-password", role: "reader" });
  await service.registerDeployment(generic);
  await service.registerDeployment(butchr);
  return { path, service, admin, reader: service.authenticate({ username: "reader", password: "fixture-password" }) };
}

const nextTurn = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitFor(check) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (check()) return;
    await nextTurn();
  }
  assert.fail("timed out waiting for asynchronous stream delivery");
}

function forbidden(error) {
  return error instanceof MorbrError && ["UNAUTHORIZED", "FORBIDDEN"].includes(error.code);
}

test("principals are server-issued, immutable sessions with controlled bootstrap", async () => {
  const { service, admin, reader } = await fixture();
  await assert.rejects(service.setConfig({ sessionId: reader.sessionId, role: "admin" }, { enabled: true }), forbidden);
  await assert.rejects(service.setConfig({ role: "admin" }, { enabled: true }), forbidden);
  await assert.rejects(service.createUser({ username: "other-admin", password: "fixture-password", role: "admin" }), forbidden);
  await service.createUser(admin, { username: "second-admin", password: "fixture-password", role: "admin" });
  assert.equal((await service.setConfig(admin, { enabled: true })).version, 1);
});

test("revoked configuration key cannot access protected config", async () => {
  const { service, admin } = await fixture();
  const key = await service.issueKey(admin, { scopes: ["config"], ...generic, label: "disposable test key" });
  await service.setConfig(admin, { interval: 30 });
  assert.deepEqual(service.getConfig(key.token, generic), { version: 1, value: { interval: 30 } });
  await service.revokeKey(admin, key.id);
  assert.throws(() => service.getConfig(key.token, generic), (error) => error instanceof MorbrError && error.code === "UNAUTHORIZED");
});

test("keys are constrained to their deployment and service type", async () => {
  const { service, admin } = await fixture();
  const key = await service.issueKey(admin, { scopes: ["config", "reporting"], ...generic });
  const genericInstance = await service.startInstance(generic);
  const butchrInstance = await service.startInstance(butchr);
  await service.recordActivity(key.token, { ...generic, instanceId: genericInstance.id, type: "started" });
  await assert.rejects(service.recordActivity(key.token, { ...butchr, instanceId: butchrInstance.id, type: "started" }), forbidden);
  await assert.throws(() => service.getConfig(key.token, butchr), forbidden);
});

test("state survives reload while deployment identity is stable and instances are ephemeral", async () => {
  const { path, service, admin } = await fixture();
  const key = await service.issueKey(admin, { scopes: ["reporting"], ...generic });
  const first = await service.startInstance(generic);
  await service.recordActivity(key.token, { ...generic, instanceId: first.id, type: "started" });

  const reloaded = await createMorbr({ statePath: path });
  const second = await reloaded.startInstance(generic);
  assert.notEqual(first.id, second.id);
  const reloadedAdmin = reloaded.authenticate({ username: "admin", password: "fixture-password" });
  assert.deepEqual(reloaded.listActivity(reloadedAdmin, generic.deploymentId).map(({ type, deploymentId }) => ({ type, deploymentId })), [{ type: "started", deploymentId: generic.deploymentId }]);
});

test("config and accepted activity payloads are isolated from caller mutation", async () => {
  const { service, admin } = await fixture();
  const config = { mode: "safe" };
  const key = await service.issueKey(admin, { scopes: ["config", "reporting"], ...generic });
  await service.setConfig(admin, config);
  config.mode = "unsafe";
  assert.deepEqual(service.getConfig(key.token, generic), { version: 1, value: { mode: "safe" } });

  const instance = await service.startInstance(generic);
  const payload = { detail: "kept" };
  await service.recordActivity(key.token, { ...generic, instanceId: instance.id, type: "started", payload });
  payload.detail = "mutated";
  assert.equal(service.listActivity(admin, generic.deploymentId)[0].payload.detail, "kept");
});

test("serialized saves retain the latest config and key revocation after overlap", async () => {
  const { path, service, admin } = await fixture();
  const key = await service.issueKey(admin, { scopes: ["config"], ...generic });
  const first = service.setConfig(admin, { padding: "x".repeat(1_000_000) });
  const second = service.setConfig(admin, { version: 2 });
  const revoke = service.revokeKey(admin, key.id);
  await Promise.all([first, second, revoke]);

  const reloaded = await createMorbr({ statePath: path });
  assert.deepEqual(reloaded.state.config, { version: 2, value: { version: 2 } });
  assert.throws(() => reloaded.getConfig(key.token, generic), (error) => error instanceof MorbrError && error.code === "UNAUTHORIZED");
});

test("configuration subscribers receive isolated snapshots and stop after revocation", async () => {
  const { service, admin } = await fixture();
  const key = await service.issueKey(admin, { scopes: ["config"], ...generic });
  const received = [];
  service.subscribeConfig(key.token, generic, (config) => received.push(config));
  await service.setConfig(admin, { revision: 1 });
  received[1].value.revision = "tampered";
  assert.deepEqual(service.getConfig(key.token, generic), { version: 1, value: { revision: 1 } });
  await service.revokeKey(admin, key.id);
  await service.setConfig(admin, { revision: 2 });
  assert.equal(received.length, 2);
});

test("overlapping config commits are delivered once each in committed version order", async () => {
  const { service, admin } = await fixture();
  const key = await service.issueKey(admin, { scopes: ["config"], ...generic });
  const versions = [];
  service.subscribeConfig(key.token, generic, (config) => versions.push(config.version));
  await Promise.all([
    service.setConfig(admin, { step: "first" }),
    service.setConfig(admin, { step: "second" }),
  ]);
  assert.deepEqual(versions, [0, 1, 2]);
});

test("Morbin events are consumed through the pinned library and persisted without key propagation", async () => {
  const morbin = createMorbin({ providers: { fake: { fetch: async () => ({ id: "resource-1", revision: 1 }) } } });
  const root = process.env.MORBR_TEST_TMPDIR ?? tmpdir();
  const path = join(await mkdtemp(join(root, "morbr-morbin-")), "state.json");
  const service = await createMorbr({ statePath: path, morbin });
  await service.createUser({ username: "admin", password: "fixture-password", role: "admin" });
  const admin = service.authenticate({ username: "admin", password: "fixture-password" });
  await service.registerDeployment(generic);
  const key = await service.issueKey(admin, { scopes: ["reporting"], ...generic });
  const instance = await service.startInstance(generic);
  const observed = [];
  const stream = service.subscribeMorbinEvents(admin, { reportingToken: key.token, identity: generic, instanceId: instance.id, provider: "fake", resource: "resource-1", listener: (event) => observed.push(event) });
  await waitFor(() => observed.length === 1);
  assert.equal(observed[0].kind, "snapshot");
  assert.equal(service.listActivity(admin, generic.deploymentId)[0].type, "morbin.snapshot");
  await service.ingestMorbinEvent(key.token, generic, { provider: "fake", resource: "resource-1", value: { id: "resource-1", revision: 2 }, cursor: "c2" });
  await waitFor(() => observed.length === 2);
  assert.equal(observed[1].data.revision, 2);
  stream.close();
});

test("terminal Morbin errors retain safe plain-data details live and after reload", async () => {
  const terminal = Object.assign(new Error("access revoked"), { code: "UNAUTHORIZED", retryable: false });
  const morbin = createMorbin({ providers: { denied: { fetch: async () => { throw terminal; } } } });
  const root = process.env.MORBR_TEST_TMPDIR ?? tmpdir();
  await mkdir(root, { recursive: true });
  const path = join(await mkdtemp(join(root, "morbr-error-")), "state.json");
  const service = await createMorbr({ statePath: path, morbin });
  await service.createUser({ username: "admin", password: "fixture-password", role: "admin" });
  const admin = service.authenticate({ username: "admin", password: "fixture-password" });
  await service.registerDeployment(generic);
  const key = await service.issueKey(admin, { scopes: ["reporting"], ...generic });
  const instance = await service.startInstance(generic);
  const observed = [];
  service.subscribeMorbinEvents(admin, { reportingToken: key.token, identity: generic, instanceId: instance.id, provider: "denied", resource: "resource-1", listener: (event) => observed.push(event) });
  await waitFor(() => observed.length === 1);
  assert.deepEqual(observed[0].error, { code: "UNAUTHORIZED", message: "UNAUTHORIZED", retryable: false });

  const reloaded = await createMorbr({ statePath: path });
  const reloadedAdmin = reloaded.authenticate({ username: "admin", password: "fixture-password" });
  assert.deepEqual(reloaded.listActivity(reloadedAdmin, generic.deploymentId)[0].payload.error, { code: "UNAUTHORIZED", message: "UNAUTHORIZED", retryable: false });
});

test("management client exposes sanitized DTOs and keeps mutations server-authorized", async () => {
  const { service, admin, reader } = await fixture();
  const adminClient = createManagementClient(service, admin);
  const readerClient = createManagementClient(service, reader);
  const key = await adminClient.issueAuthorization({ scopes: ["reporting"], ...generic, label: "dashboard" });
  const instance = await service.startInstance(generic);
  const events = [];
  const activity = adminClient.subscribeActivity((event) => events.push(event));
  await service.recordActivity(key.token, { ...generic, instanceId: instance.id, type: "started", payload: { internal: "not-for-ui" } });

  const snapshot = adminClient.getSnapshot();
  assert.equal(snapshot.canManage, true);
  assert.deepEqual(snapshot.authorizations[0], { id: key.id, label: "dashboard", deploymentId: generic.deploymentId, type: "generic", scopes: ["reporting"], revoked: false });
  assert.equal(snapshot.users.some((user) => "passwordDigest" in user || "salt" in user), false);
  assert.equal(snapshot.activity[0].payload, undefined);
  assert.equal(events[0].payload, undefined);
  assert.equal(snapshot.counts.instances, 1);
  await assert.rejects(readerClient.updateUser("admin", { role: "reader" }), forbidden);
  await adminClient.updateAuthorization(key.id, { label: "renamed", scopes: ["config", "reporting"] });
  await adminClient.updateUser("reader", { role: "admin" });
  assert.equal(adminClient.getSnapshot().users.find((user) => user.username === "reader").role, "admin");
  activity.close();
});
