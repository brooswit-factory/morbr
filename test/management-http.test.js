import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMorbr, createMorbrHttpServer } from "../src/index.js";
import { createHttpManagementClient } from "../src/management-http.js";

const identity = { deploymentId: "ui-fixture", type: "generic" };
const waitFor = async (check) => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for activity event");
};

test("HTTP management bridge uses sanitized DTOs and propagates edits/activity", async () => {
  const root = process.env.MORBR_TEST_TMPDIR ?? tmpdir();
  await mkdir(root, { recursive: true });
  const service = await createMorbr({ statePath: join(await mkdtemp(join(root, "morbr-ui-http-")), "state.json") });
  const password = "fixturé漢";
  await service.createUser({ username: "admin", password, role: "admin" });
  const admin = service.authenticate({ username: "admin", password });
  await service.createUser(admin, { username: "reader", password, role: "reader" });
  await service.registerDeployment({ ...identity, name: "UI fixture" });
  const instance = await service.startInstance(identity);
  const reporting = await service.issueKey(admin, { ...identity, scopes: ["reporting"], label: "test reporting" });
  const transport = createMorbrHttpServer({ service });
  const address = await transport.start();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const client = createHttpManagementClient({ baseUrl, username: "admin", password });
    const initial = await client.getSnapshot();
    assert.deepEqual(initial.instances[0], { id: instance.id, deploymentId: identity.deploymentId, startedAt: instance.startedAt });
    assert.equal(JSON.stringify(initial).match(/passwordDigest|salt|token/i), null);
    await client.setConfig({ generic: { intervalSeconds: 45 }, other: { keep: true } });
    assert.deepEqual((await client.getSnapshot()).config.value, { generic: { intervalSeconds: 45 }, other: { keep: true } });
    const observed = [];
    const subscription = client.subscribeActivity((event) => observed.push(event));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await service.recordActivity(reporting.token, { ...identity, instanceId: instance.id, type: "fixture.changed" });
    await waitFor(() => observed.length === 1);
    assert.deepEqual(observed[0], { id: observed[0].id, deploymentId: identity.deploymentId, instanceId: instance.id, type: "fixture.changed", recordedAt: observed[0].recordedAt });
    subscription.close();
    const reader = createHttpManagementClient({ baseUrl, username: "reader", password });
    await assert.rejects(() => reader.setConfig({ forbidden: true }), /FORBIDDEN/);
  } finally {
    await transport.close();
  }
});
