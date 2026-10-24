/**
 * Controlled browser/Electron transport for Morbr's public sanitized HTTP API.
 * Callers supply disposable credentials; nothing is persisted in this module.
 */
export function createHttpManagementClient({ baseUrl, username, password, fetchImpl = globalThis.fetch }) {
  if (!baseUrl || !username || password === undefined || typeof fetchImpl !== "function") throw new TypeError("baseUrl, username, password, and fetch are required");
  const endpoint = new URL(baseUrl);
  const authorization = `Basic ${btoa(`${username}:${password}`)}`;
  const request = async (path, options = {}) => {
    const response = await fetchImpl(new URL(path, endpoint), { ...options, headers: { authorization, accept: "application/json", ...options.headers } });
    if (!response.ok) { const error = new Error((await response.json().catch(() => ({}))).code ?? `HTTP_${response.status}`); error.status = response.status; throw error; }
    return response.status === 204 ? undefined : response.json();
  };
  return Object.freeze({
    getSnapshot: () => request("/management"),
    setConfig: (value) => request("/config", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(value) }),
    createUser: (details) => request("/management/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(details) }),
    updateUser: (name, details) => request(`/management/users/${encodeURIComponent(name)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(details) }),
    issueAuthorization: (details) => request("/management/authorizations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(details) }),
    updateAuthorization: (id, details) => request(`/management/authorizations/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(details) }),
    revokeAuthorization: (id) => request(`/management/authorizations/${encodeURIComponent(id)}`, { method: "DELETE" }),
    subscribeActivity(listener) {
      const controller = new AbortController();
      (async () => {
        const response = await fetchImpl(new URL("/events/activity", endpoint), { headers: { authorization, accept: "text/event-stream" }, signal: controller.signal });
        if (!response.ok || !response.body) throw new Error(`HTTP_${response.status}`);
        const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = "";
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read(); if (done) break;
          pending += decoder.decode(value, { stream: true });
          const frames = pending.split("\n\n"); pending = frames.pop();
          for (const frame of frames) { const line = frame.split("\n").find((entry) => entry.startsWith("data: ")); if (line) listener(JSON.parse(line.slice(6))); }
        }
      })().catch((error) => { if (!controller.signal.aborted) queueMicrotask(() => { throw error; }); });
      return { close: () => controller.abort() };
    },
  });
}
