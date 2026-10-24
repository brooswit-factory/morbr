/**
 * The browser/Electron management boundary.  It deliberately accepts a small,
 * sanitized DTO client: it never accepts raw service state, principals, or
 * password/key digests.
 */
export const managementSections = ["Authorizations", "Deployments", "Instances", "Users"];

const fixture = {
  authorizations: [
    { id: "auth-generic", type: "generic", name: "Telemetry relay", metadata: { region: "local" }, config: { intervalSeconds: 30 } },
    { id: "auth-butchr", type: "butchr", name: "Butchr control plane", metadata: { workspace: "factory" }, config: { resource: "jira-project:FACTORY" } },
  ],
  deployments: [{ id: "deploy-local", name: "Local Morbr", connectedClients: 2, agents: 1, activity: "Config synchronized" }],
  instances: [{ id: "instance-fixture", deploymentId: "deploy-local", status: "connected", event: "resource.changed", receivedAt: "2026-10-24T13:58:00.000Z" }],
  users: [{ id: "user-admin", username: "admin", role: "admin" }, { id: "user-reader", username: "reader", role: "reader" }],
};

function clone(value) { return structuredClone(value); }

/** A disposable in-memory client used by the standalone web and Electron UI. */
export function createFixtureManagementClient(seed = fixture) {
  const state = clone(seed);
  const listeners = new Set();
  const emit = (event) => listeners.forEach((listener) => listener(clone(event)));
  return {
    async listAuthorizations() { return clone(state.authorizations); },
    async updateAuthorization(id, patch) {
      const record = state.authorizations.find((item) => item.id === id);
      if (!record) throw new Error("Authorization not found");
      Object.assign(record, clone(patch)); emit({ type: "authorization.updated", id }); return clone(record);
    },
    async listDeployments() { return clone(state.deployments); },
    async listInstances() { return clone(state.instances); },
    async listUsers() { return clone(state.users); },
    async updateUser(id, patch) {
      const record = state.users.find((item) => item.id === id);
      if (!record) throw new Error("User not found");
      Object.assign(record, clone(patch)); emit({ type: "user.updated", id }); return clone(record);
    },
    subscribeInstances(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    emitFixtureEvent(event) { emit(event); },
  };
}

function element(document, tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function readOnlyList(document, records, fields) {
  const list = element(document, "ul");
  records.forEach((record) => list.append(element(document, "li", fields.map((field) => `${field}: ${record[field]}`).join(" · "))));
  return list;
}

/** Mount the central-management experience into a browser or Electron renderer. */
export function createManagementApp({ document, client, role = "admin" }) {
  if (!document || !client) throw new TypeError("document and sanitized management client are required");
  const root = element(document, "main");
  const nav = element(document, "nav");
  const panel = element(document, "section");
  let active = managementSections[0];

  const canEdit = role === "admin";
  const render = async () => {
    panel.replaceChildren(element(document, "h2", active));
    if (active === "Authorizations") {
      const records = await client.listAuthorizations();
      records.forEach((record) => {
        const article = element(document, "article");
        article.append(element(document, "h3", `${record.name} (${record.type})`));
        article.append(element(document, "pre", JSON.stringify({ metadata: record.metadata, config: record.config }, null, 2)));
        if (canEdit) {
          const edit = element(document, "button", record.type === "butchr" ? "Edit Butchr authorization" : "Edit JSON configuration");
          edit.addEventListener("click", async () => {
            await client.updateAuthorization(record.id, { metadata: { ...record.metadata, edited: true } });
            await render();
          });
          article.append(edit);
        }
        panel.append(article);
      });
    } else if (active === "Deployments") {
      panel.append(readOnlyList(document, await client.listDeployments(), ["name", "connectedClients", "agents", "activity"]));
    } else if (active === "Instances") {
      panel.append(readOnlyList(document, await client.listInstances(), ["id", "deploymentId", "status", "event"]));
    } else {
      const users = await client.listUsers();
      users.forEach((user) => {
        const row = element(document, "div", `${user.username}: ${user.role}`);
        if (canEdit) {
          const toggle = element(document, "button", "Toggle reader/admin");
          toggle.addEventListener("click", async () => { await client.updateUser(user.id, { role: user.role === "admin" ? "reader" : "admin" }); await render(); });
          row.append(" ", toggle);
        }
        panel.append(row);
      });
    }
  };

  managementSections.forEach((section) => {
    const button = element(document, "button", section);
    button.setAttribute("aria-current", String(section === active));
    button.addEventListener("click", async () => { active = section; [...nav.children].forEach((item) => item.setAttribute("aria-current", String(item.textContent === section))); await render(); });
    nav.append(button);
  });
  root.append(element(document, "h1", "Morbr Management"), nav, panel);
  client.subscribeInstances?.((event) => { if (active === "Instances" && event.type.startsWith("instance.")) render(); });
  return { root, render, get activeSection() { return active; } };
}
