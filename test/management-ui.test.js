import test from "node:test";
import assert from "node:assert/strict";
import { createFixtureManagementClient, createManagementApp, managementSections } from "../src/management-ui.js";

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute() {}
  addEventListener(name, listener) { this.listeners[name] = listener; }
  async click() { await this.listeners.click?.(); }
  set textContent(value) { this.text = value; }
  get textContent() { return this.text; }
}
const document = { createElement: (tag) => new Node(tag) };
const find = (node, predicate) => predicate(node) ? node : (node.children ?? []).filter((child) => typeof child !== "string").map((child) => find(child, predicate)).find(Boolean);

test("UI renders four sections and keeps reader mutation controls absent", async () => {
  const app = createManagementApp({ document, client: createFixtureManagementClient({ role: "reader", canManage: false }) });
  await app.render();
  assert.deepEqual(managementSections, ["Authorizations", "Deployments", "Instances", "Users"]);
  assert.equal(Boolean(find(app.root.children[2], (node) => node.tag === "button" && /Edit|Toggle/.test(node.text))), false);
  await app.root.children[1].children[2].click();
  assert.equal(app.activeSection, "Instances");
});

test("UI validates and persists generic config and Butchr scopes", async () => {
  const client = createFixtureManagementClient({ config: { version: 4, value: { generic: { intervalSeconds: 30 }, other: { keep: true } } } });
  const app = createManagementApp({ document, client });
  await app.render();
  const generic = app.root.children[2].children[1];
  await find(generic, (node) => node.text === "Edit JSON configuration").click();
  const json = find(generic, (node) => node.tag === "textarea");
  json.value = '{"intervalSeconds":45}';
  await find(generic, (node) => node.text === "Save").click();
  assert.deepEqual((await client.getSnapshot()).config.value, { generic: { intervalSeconds: 45 }, other: { keep: true } });
  let butchr = app.root.children[2].children[2];
  await find(butchr, (node) => node.text === "Edit Butchr authorization").click();
  find(butchr, (node) => node.tag === "input" && node !== butchr.children[1].children[0]).value = "root";
  await find(butchr, (node) => node.text === "Save").click();
  assert.match(find(butchr, (node) => node.tag === "p" && node.text).text, /nonempty subset/);
  find(butchr, (node) => node.tag === "input" && node !== butchr.children[1].children[0]).value = "config, reporting";
  await find(butchr, (node) => node.text === "Save").click();
  assert.deepEqual((await client.getSnapshot()).authorizations[1].scopes, ["config", "reporting"]);
});

test("obsolete async snapshots cannot overwrite newer navigation", async () => {
  let firstResolve; let secondResolve; let calls = 0;
  const first = new Promise((resolve) => { firstResolve = resolve; }); const second = new Promise((resolve) => { secondResolve = resolve; });
  const snapshot = { role: "reader", canManage: false, config: { version: 0, value: {} }, authorizations: [{ id: "old", label: "old", deploymentId: "d", type: "generic", scopes: [], revoked: false }], deployments: [], instances: [], users: [{ username: "reader", role: "reader" }], activity: [], counts: {} };
  const app = createManagementApp({ document, client: { getSnapshot: () => (++calls === 1 ? first : second), subscribeActivity: () => ({ close() {} }) } });
  const pending = app.render(); const navigate = app.root.children[1].children[3].click();
  secondResolve(snapshot); await navigate; firstResolve(snapshot); await pending;
  assert.equal(app.activeSection, "Users");
  assert.equal(Boolean(find(app.root.children[2], (node) => node.tag === "article")), false);
});

test("UI distinguishes missing client and agent measurements from zero", async () => {
  const unknown = createManagementApp({ document, client: createFixtureManagementClient({ counts: {} }) });
  await unknown.render(); await unknown.root.children[1].children[1].click();
  assert.match(find(unknown.root.children[2], (node) => node.tag === "p").text, /Connected clients: not measured; agents: not measured/);
  const zero = createManagementApp({ document, client: createFixtureManagementClient({ counts: { connectedClients: 0, agents: 0 } }) });
  await zero.render(); await zero.root.children[1].children[1].click();
  assert.match(find(zero.root.children[2], (node) => node.tag === "p").text, /Connected clients: 0; agents: 0/);
});
