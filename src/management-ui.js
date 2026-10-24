/** Browser/Electron management UI using only the sanitized FACTORY-1030 facade. */
export const managementSections = ["Authorizations", "Deployments", "Instances", "Users"];

const fixture = {
  role: "admin", canManage: true,
  config: { version: 1, value: { generic: { intervalSeconds: 30, metadata: { region: "local" } }, other: { keep: true } } },
  authorizations: [
    { id: "auth-generic", type: "generic", label: "Telemetry relay", deploymentId: "deploy-local", scopes: ["config", "reporting"], revoked: false },
    { id: "auth-butchr", type: "butchr", label: "Butchr control plane", deploymentId: "deploy-local", scopes: ["config"], revoked: false },
  ],
  deployments: [{ deploymentId: "deploy-local", type: "butchr", name: "Local Morbr", createdAt: "2026-10-24T13:00:00.000Z" }],
  instances: [{ id: "instance-fixture", deploymentId: "deploy-local", startedAt: "2026-10-24T13:58:00.000Z" }],
  users: [{ username: "admin", role: "admin" }, { username: "reader", role: "reader" }],
  activity: [{ id: "activity-fixture", deploymentId: "deploy-local", instanceId: "instance-fixture", type: "resource.changed", recordedAt: "2026-10-24T13:58:00.000Z" }],
  counts: { connectedClients: 2, agents: 1 },
};
const clone = (value) => structuredClone(value);

/** Disposable fake of createManagementClient(service, session), for UI tests only. */
export function createFixtureManagementClient(seed = {}) {
  const state = clone({ ...fixture, ...seed });
  const listeners = new Set();
  const assertManage = () => { if (!state.canManage) throw new Error("FORBIDDEN"); };
  const assertScopes = (scopes) => {
    if (!Array.isArray(scopes) || !scopes.length || scopes.some((scope) => !["config", "reporting"].includes(scope))) throw new Error("Scopes must be a nonempty subset of config, reporting");
  };
  const emit = (event) => listeners.forEach((listener) => listener(clone(event)));
  return {
    async getSnapshot() { return clone(state); },
    async setConfig(value) { assertManage(); state.config = { version: state.config.version + 1, value: clone(value) }; emit({ id: "config", deploymentId: "deploy-local", instanceId: "instance-fixture", type: "config.updated", recordedAt: new Date().toISOString() }); },
    async updateAuthorization(id, details) { assertManage(); const record = state.authorizations.find((item) => item.id === id); if (!record) throw new Error("Authorization not found"); if (details.scopes !== undefined) assertScopes(details.scopes); Object.assign(record, clone(details)); return clone(record); },
    async updateUser(username, details) { assertManage(); const record = state.users.find((item) => item.username === username); if (!record) throw new Error("User not found"); Object.assign(record, clone(details)); return clone(record); },
    subscribeActivity(listener) { listeners.add(listener); return { close: () => listeners.delete(listener) }; },
    emitFixtureActivity(event) { state.activity.push(clone(event)); emit(event); },
  };
}

function element(document, tag, text) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; }
function field(document, label, value, multiline = false) {
  const wrap = element(document, "label", `${label}: `); const input = element(document, multiline ? "textarea" : "input"); input.value = value; wrap.append(input); return { wrap, input };
}
function readOnlyList(document, records, fields) { const list = element(document, "ul"); records.forEach((record) => list.append(element(document, "li", fields.map((name) => `${name}: ${record[name]}`).join(" · ")))); return list; }

/** Mount the UI. Client must be a sanitized management facade, never service internals. */
export function createManagementApp({ document, client }) {
  if (!document || !client?.getSnapshot) throw new TypeError("document and sanitized management client are required");
  const root = element(document, "main"); const nav = element(document, "nav"); const panel = element(document, "section");
  let active = managementSections[0]; let generation = 0;
  const render = async () => {
    const current = ++generation; panel.replaceChildren(element(document, "h2", active));
    const snapshot = await client.getSnapshot(); if (current !== generation) return;
    const canManage = snapshot.canManage === true;
    if (active === "Authorizations") {
      snapshot.authorizations.forEach((authorization) => {
        const article = element(document, "article"); article.append(element(document, "h3", `${authorization.label} (${authorization.type})`));
        article.append(element(document, "p", `Deployment: ${authorization.deploymentId}; scopes: ${authorization.scopes.join(", ")}`));
        if (canManage && !authorization.revoked) {
          const edit = element(document, "button", authorization.type === "butchr" ? "Edit Butchr authorization" : "Edit JSON configuration");
          edit.addEventListener("click", () => editAuthorization(article, authorization, snapshot, client, render, document)); article.append(edit);
        }
        panel.append(article);
      });
    } else if (active === "Deployments") { panel.append(readOnlyList(document, snapshot.deployments, ["deploymentId", "type", "name", "createdAt"])); panel.append(element(document, "p", `Connected clients: ${snapshot.counts.connectedClients ?? 0}; agents: ${snapshot.counts.agents ?? 0}`)); }
    else if (active === "Instances") { panel.append(readOnlyList(document, snapshot.instances, ["id", "deploymentId", "startedAt"])); panel.append(readOnlyList(document, snapshot.activity, ["type", "recordedAt"])); }
    else snapshot.users.forEach((user) => {
      const row = element(document, "div", `${user.username}: ${user.role}`);
      if (canManage) { const toggle = element(document, "button", "Toggle reader/admin"); toggle.addEventListener("click", async () => { await client.updateUser(user.username, { role: user.role === "admin" ? "reader" : "admin" }); await render(); }); row.append(" ", toggle); }
      panel.append(row);
    });
  };
  managementSections.forEach((section) => { const button = element(document, "button", section); button.setAttribute("aria-current", String(section === active)); button.addEventListener("click", async () => { active = section; [...nav.children].forEach((item) => item.setAttribute("aria-current", String(item.textContent === section))); await render(); }); nav.append(button); });
  root.append(element(document, "h1", "Morbr Management"), nav, panel);
  client.subscribeActivity?.(() => { if (active === "Instances") render(); });
  return { root, render, get activeSection() { return active; } };
}

function editAuthorization(article, authorization, snapshot, client, render, document) {
  article.replaceChildren(element(document, "h3", `Edit ${authorization.label}`));
  const label = field(document, "Label", authorization.label);
  const body = authorization.type === "butchr"
    ? field(document, "Scopes (comma-separated)", authorization.scopes.join(", "))
    : field(document, "JSON config", JSON.stringify(snapshot.config.value?.generic ?? {}, null, 2), true);
  const error = element(document, "p"); const save = element(document, "button", "Save"); const cancel = element(document, "button", "Cancel");
  save.addEventListener("click", async () => {
    try {
      if (authorization.type === "butchr") { const scopes = body.input.value.split(",").map((item) => item.trim()).filter(Boolean); if (!scopes.length || scopes.some((scope) => !["config", "reporting"].includes(scope))) throw new Error("Scopes must be a nonempty subset of config, reporting"); await client.updateAuthorization(authorization.id, { label: label.input.value.trim(), scopes }); }
      else { const generic = JSON.parse(body.input.value); if (!generic || Array.isArray(generic) || typeof generic !== "object") throw new Error("Configuration must be a JSON object"); await client.updateAuthorization(authorization.id, { label: label.input.value.trim() }); await client.setConfig({ ...snapshot.config.value, generic }); }
      await render();
    } catch (cause) { error.textContent = cause.message; }
  });
  cancel.addEventListener("click", render); article.append(label.wrap, body.wrap, error, save, cancel);
}
