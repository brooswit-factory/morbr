import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMorbr, createMorbrHttpServer } from "../src/index.js";
import { createHttpManagementClient } from "../src/management-http.js";
import { createManagementWebServer } from "../src/web-server.mjs";

test("same-origin web bridge keeps credentials server-side and forwards management edits", async () => {
  const root = process.env.MORBR_TEST_TMPDIR ?? tmpdir(); await mkdir(root, { recursive: true });
  const service = await createMorbr({ statePath: join(await mkdtemp(join(root, "morbr-web-")), "state.json") });
  await service.createUser({ username: "admin", password: "päss漢word", role: "admin" });
  const admin = service.authenticate({ username: "admin", password: "päss漢word" });
  const identity = { deploymentId: "browser-bridge", type: "generic" };
  await service.registerDeployment(identity);
  const instance = await service.startInstance(identity);
  const reporting = await service.issueKey(admin, { ...identity, scopes: ["reporting"], label: "browser bridge" });
  const transport = createMorbrHttpServer({ service }); const serviceAddress = await transport.start();
  const web = createManagementWebServer({ serviceUrl: `http://127.0.0.1:${serviceAddress.port}`, username: "admin", password: "päss漢word" });
  await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${web.address().port}`;
  try {
    const configuration = await (await fetch(`${baseUrl}/management-config.js`)).text();
    assert.match(configuration, /baseUrl: '\/api\//);
    const client = createHttpManagementClient({ baseUrl: `${baseUrl}/api/` });
    assert.equal((await client.getSnapshot()).role, "admin");
    const updated = await fetch(`${baseUrl}/api/config`, { method: "PATCH", headers: { origin: baseUrl, "content-type": "application/json" }, body: JSON.stringify({ bridge: true }) });
    assert.equal(updated.status, 200);
    assert.deepEqual((await client.getSnapshot()).config.value, { bridge: true });
    const received = [];
    const subscription = client.subscribeActivity((event) => received.push(event));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await service.recordActivity(reporting.token, { ...identity, instanceId: instance.id, type: "browser.changed" });
    for (let attempts = 0; !received.length && attempts < 40; attempts += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(received[0]?.type, "browser.changed");
    subscription.close();
  } finally {
    await new Promise((resolve, reject) => web.close((error) => error ? reject(error) : resolve()));
    await transport.close();
  }
});

test("same-origin web bridge rejects credential-forwarding and cross-origin write attempts", async () => {
  const root = process.env.MORBR_TEST_TMPDIR ?? tmpdir(); await mkdir(root, { recursive: true });
  const service = await createMorbr({ statePath: join(await mkdtemp(join(root, "morbr-web-security-")), "state.json") });
  await service.createUser({ username: "admin", password: "päss漢word", role: "admin" });
  const transport = createMorbrHttpServer({ service }); const serviceAddress = await transport.start();
  const web = createManagementWebServer({ serviceUrl: `http://127.0.0.1:${serviceAddress.port}`, username: "admin", password: "päss漢word" });
  await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${web.address().port}`;
  let sinkRequests = 0;
  const sink = createServer((request, response) => { sinkRequests += 1; assert.equal(request.headers.authorization, undefined); response.end("unexpected"); });
  await new Promise((resolve) => sink.listen(0, "127.0.0.1", resolve));
  const sinkUrl = `http://127.0.0.1:${sink.address().port}/capture`;
  const redirector = createServer((request, response) => response.writeHead(302, { location: sinkUrl }).end());
  await new Promise((resolve) => redirector.listen(0, "127.0.0.1", resolve));
  const redirectBridge = createManagementWebServer({ serviceUrl: `http://127.0.0.1:${redirector.address().port}`, username: "admin", password: "päss漢word" });
  await new Promise((resolve) => redirectBridge.listen(0, "127.0.0.1", resolve));
  try {
    const escaped = await fetch(`${baseUrl}/api/${sinkUrl}`);
    assert.equal(escaped.status, 404);
    assert.equal(sinkRequests, 0);
    const redirected = await fetch(`http://127.0.0.1:${redirectBridge.address().port}/api/management`);
    assert.equal(redirected.status, 502);
    assert.equal(sinkRequests, 0);

    const crossOrigin = await fetch(`${baseUrl}/api/management/users`, { method: "POST", headers: { origin: "https://untrusted.example", "content-type": "text/plain" }, body: JSON.stringify({ username: "attacker", password: "pass", role: "admin" }) });
    assert.equal(crossOrigin.status, 403);
    const wrongContentType = await fetch(`${baseUrl}/api/management/users`, { method: "POST", headers: { origin: baseUrl, "content-type": "text/plain" }, body: JSON.stringify({ username: "attacker", password: "pass", role: "admin" }) });
    assert.equal(wrongContentType.status, 415);
    const snapshot = await (await fetch(`${baseUrl}/api/management`)).json();
    assert.equal(snapshot.users.some((user) => user.username === "attacker"), false);
  } finally {
    await new Promise((resolve, reject) => redirectBridge.close((error) => error ? reject(error) : resolve()));
    await new Promise((resolve, reject) => redirector.close((error) => error ? reject(error) : resolve()));
    await new Promise((resolve, reject) => sink.close((error) => error ? reject(error) : resolve()));
    await new Promise((resolve, reject) => web.close((error) => error ? reject(error) : resolve()));
    await transport.close();
  }
});
