import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const STATE_VERSION = 1;

export class MorbrError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new MorbrError(code, message);
}

function passwordDigest(password, salt = randomBytes(16).toString("base64url")) {
  if (typeof password !== "string" || password.length < 8) {
    fail("INVALID_PASSWORD", "password must contain at least eight characters");
  }
  return { salt, digest: scryptSync(password, salt, 32).toString("base64url") };
}

function matchesPassword(password, user) {
  const actual = Buffer.from(passwordDigest(password, user.salt).digest);
  const expected = Buffer.from(user.passwordDigest);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function tokenDigest(token) {
  return scryptSync(token, "morbr-key-v1", 32).toString("base64url");
}

function isolatedJson(value, errorCode = "INVALID_DATA") {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) fail(errorCode);
    return { encoded, value: JSON.parse(encoded) };
  } catch (error) {
    if (error instanceof MorbrError) throw error;
    fail(errorCode);
  }
}

function safeMorbinEvent(event) {
  const copy = { ...event };
  if (event?.error) {
    copy.error = {
      code: String(event.error.code ?? "ERROR"),
      message: String(event.error.message ?? "Morbin stream error"),
      retryable: event.error.retryable === true,
    };
  }
  return isolatedJson(copy).value;
}

function emptyState() {
  return {
    version: STATE_VERSION,
    users: {},
    keys: {},
    deployments: {},
    instances: {},
    config: { version: 0, value: null },
    activity: [],
  };
}

/**
 * Small JSON store with replace-on-write persistence.  It intentionally stores
 * only password/key digests; bearer key values are returned once and never
 * retained in dashboard state.
 */
export class JsonStateStore {
  constructor(path) {
    this.path = path;
    this.pending = Promise.resolve();
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      if (parsed.version !== STATE_VERSION) fail("INVALID_STATE", "unsupported state version");
      return parsed;
    } catch (error) {
      if (error?.code === "ENOENT") return emptyState();
      throw error;
    }
  }

  async writeSnapshot(snapshot) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }

  save(state) {
    const snapshot = structuredClone(state);
    const write = this.pending.then(() => this.writeSnapshot(snapshot));
    // A failed write is returned to its caller, but must not permanently poison
    // the queue for a later state repair.
    this.pending = write.catch(() => {});
    return write;
  }
}

/**
 * Generic central Morbr service. It stores config and activity; it does not
 * launch jobs or execute client-provided events.
 */
export class MorbrService {
  static async open({ statePath, morbin = null }) {
    const store = new JsonStateStore(statePath);
    return new MorbrService(store, await store.load(), morbin);
  }

  constructor(store, state, morbin = null) {
    this.store = store;
    this.state = state;
    this.sessions = new Map();
    this.morbin = morbin;
    this.configSubscriptions = new Set();
    this.configDelivery = Promise.resolve();
    this.activitySubscriptions = new Set();
  }

  async persist() {
    await this.store.save(this.state);
  }

  async createUser(actorOrDetails, maybeDetails) {
    const actor = maybeDetails ? actorOrDetails : undefined;
    const { username, password, role } = maybeDetails ?? actorOrDetails;
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(username ?? "")) fail("INVALID_USERNAME");
    if (role !== "admin" && role !== "reader") fail("INVALID_ROLE");
    if (this.state.users[username]) fail("USER_EXISTS");
    if (Object.keys(this.state.users).length === 0) {
      if (actor || role !== "admin") fail("FORBIDDEN");
    } else {
      this.requireAdmin(actor);
    }
    const credentials = passwordDigest(password);
    this.state.users[username] = { username, role, salt: credentials.salt, passwordDigest: credentials.digest };
    await this.persist();
    return { username, role };
  }

  authenticate({ username, password }) {
    const user = this.state.users[username];
    if (!user || !matchesPassword(password, user)) fail("UNAUTHORIZED");
    const sessionId = randomUUID();
    this.sessions.set(sessionId, user.username);
    return Object.freeze({ sessionId });
  }

  principalFor(actor) {
    const username = actor?.sessionId && this.sessions.get(actor.sessionId);
    const user = username && this.state.users[username];
    if (!user) fail("UNAUTHORIZED");
    return user;
  }

  requireAdmin(actor) {
    const user = this.principalFor(actor);
    if (user.role !== "admin") fail("FORBIDDEN");
    return user;
  }

  async issueKey(actor, { scopes, deploymentId, type, label = "" }) {
    this.requireAdmin(actor);
    if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some((scope) => !["config", "reporting"].includes(scope))) {
      fail("INVALID_SCOPES");
    }
    const deployment = this.deploymentFor({ deploymentId, type });
    const token = `mrb_${randomBytes(24).toString("base64url")}`;
    const id = randomUUID();
    this.state.keys[id] = { id, label, deploymentId: deployment.deploymentId, type: deployment.type, scopes: [...new Set(scopes)].sort(), digest: tokenDigest(token), revoked: false };
    await this.persist();
    return { id, token, scopes: this.state.keys[id].scopes };
  }

  async revokeKey(actor, id) {
    this.requireAdmin(actor);
    const key = this.state.keys[id];
    if (!key) fail("KEY_NOT_FOUND");
    key.revoked = true;
    await this.persist();
  }

  async updateAuthorization(actor, id, { label, scopes } = {}) {
    this.requireAdmin(actor);
    const key = this.state.keys[id];
    if (!key) fail("KEY_NOT_FOUND");
    if (label !== undefined) key.label = String(label);
    if (scopes !== undefined) {
      if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some((scope) => !["config", "reporting"].includes(scope))) fail("INVALID_SCOPES");
      key.scopes = [...new Set(scopes)].sort();
    }
    await this.persist();
    return this.managementAuthorization(key);
  }

  async updateUser(actor, username, { role, password } = {}) {
    this.requireAdmin(actor);
    const user = this.state.users[username];
    if (!user) fail("USER_NOT_FOUND");
    if (role !== undefined) {
      if (role !== "admin" && role !== "reader") fail("INVALID_ROLE");
      user.role = role;
    }
    if (password !== undefined) {
      const credentials = passwordDigest(password);
      user.salt = credentials.salt;
      user.passwordDigest = credentials.digest;
    }
    await this.persist();
    return { username: user.username, role: user.role };
  }

  keyFor(token, scope, identity) {
    const digest = tokenDigest(token ?? "");
    const key = Object.values(this.state.keys).find((candidate) => candidate.digest === digest);
    if (!key || key.revoked) fail("UNAUTHORIZED");
    if (!key.scopes.includes(scope)) fail("FORBIDDEN");
    if (!identity || key.deploymentId !== identity.deploymentId || key.type !== identity.type) fail("FORBIDDEN");
    return key;
  }

  async setConfig(actor, value) {
    this.requireAdmin(actor);
    const snapshot = isolatedJson(value, "INVALID_CONFIG");
    // De-duplicate equivalent snapshots so subscribers see semantic changes only.
    if (JSON.stringify(this.state.config.value) !== snapshot.encoded) {
      this.state.config = { version: this.state.config.version + 1, value: snapshot.value };
      const committed = structuredClone(this.state.config);
      await this.persist();
      await this.publishConfig(committed);
      return committed;
    }
    return structuredClone(this.state.config);
  }

  getConfig(token, identity) {
    this.keyFor(token, "config", identity);
    return structuredClone(this.state.config);
  }

  subscribeConfig(token, identity, listener) {
    if (typeof listener !== "function") fail("INVALID_LISTENER");
    this.keyFor(token, "config", identity);
    const subscription = { token, identity: structuredClone(identity), listener };
    this.configSubscriptions.add(subscription);
    const initial = structuredClone(this.state.config);
    subscription.lastVersion = initial.version;
    listener(initial);
    return { close: () => this.configSubscriptions.delete(subscription) };
  }

  publishConfig(snapshot) {
    const delivery = this.configDelivery.then(() => {
      for (const subscription of this.configSubscriptions) {
        try {
          if (snapshot.version <= subscription.lastVersion) continue;
          this.keyFor(subscription.token, "config", subscription.identity);
          subscription.lastVersion = snapshot.version;
          subscription.listener(structuredClone(snapshot));
        } catch (error) {
          // Revocation/authorization terminates delivery without emitting state.
          this.configSubscriptions.delete(subscription);
        }
      }
    });
    this.configDelivery = delivery.catch(() => {});
    return delivery;
  }

  async registerDeployment({ deploymentId, type, name = "" }) {
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(deploymentId ?? "")) fail("INVALID_DEPLOYMENT_ID");
    if (type !== "generic" && type !== "butchr") fail("INVALID_DEPLOYMENT_TYPE");
    const existing = this.state.deployments[deploymentId];
    if (!existing) {
      this.state.deployments[deploymentId] = { deploymentId, type, name, createdAt: new Date().toISOString() };
      await this.persist();
    } else if (existing.type !== type) {
      fail("DEPLOYMENT_TYPE_MISMATCH");
    }
    return structuredClone(this.state.deployments[deploymentId]);
  }

  async startInstance({ deploymentId }) {
    if (!this.state.deployments[deploymentId]) fail("DEPLOYMENT_NOT_FOUND");
    const instance = { id: randomUUID(), deploymentId, startedAt: new Date().toISOString() };
    this.state.instances[instance.id] = instance;
    await this.persist();
    return structuredClone(instance);
  }

  async recordActivity(token, { deploymentId, instanceId, type, payload = null }) {
    const instance = this.state.instances[instanceId];
    const deployment = this.state.deployments[deploymentId];
    if (!deployment || !instance || instance.deploymentId !== deploymentId) fail("UNKNOWN_IDENTITY");
    this.keyFor(token, "reporting", deployment);
    if (typeof type !== "string" || type.length === 0) fail("INVALID_ACTIVITY");
    const event = { id: randomUUID(), deploymentId, instanceId, type, payload: isolatedJson(payload).value, recordedAt: new Date().toISOString() };
    this.state.activity.push(event);
    await this.persist();
    this.publishActivity(event);
    return structuredClone(event);
  }

  /**
   * Connect an approved Morbin resource stream to persisted Morbr activity.
   * Morbin owns polling/replay mechanics; this adapter neither copies them nor
   * passes a Morbr key into providers.
   */
  subscribeMorbinEvents(actor, { reportingToken, identity, instanceId, provider, resource, listener = () => {} }) {
    this.requireAdmin(actor);
    if (!this.morbin?.watchResource) fail("MORBIN_NOT_CONFIGURED");
    const deployment = this.deploymentFor(identity);
    const instance = this.state.instances[instanceId];
    if (!instance || instance.deploymentId !== deployment.deploymentId) fail("UNKNOWN_IDENTITY");
    this.keyFor(reportingToken, "reporting", deployment);
    let close = () => {};
    const subscription = this.morbin.watchResource(provider, resource, async (event) => {
      try {
        const safeEvent = safeMorbinEvent(event);
        await this.recordActivity(reportingToken, {
          deploymentId: deployment.deploymentId,
          instanceId,
          type: `morbin.${safeEvent.kind}`,
          payload: safeEvent,
        });
        listener(structuredClone(safeEvent));
      } catch (error) {
        if (error instanceof MorbrError && ["UNAUTHORIZED", "FORBIDDEN"].includes(error.code)) close();
      }
    });
    close = () => subscription.close();
    return { id: subscription.id, close };
  }

  async ingestMorbinEvent(token, identity, event) {
    this.keyFor(token, "reporting", this.deploymentFor(identity));
    if (!this.morbin?.receive) fail("MORBIN_NOT_CONFIGURED");
    return this.morbin.receive(isolatedJson(event).value);
  }

  listActivity(actor, deploymentId) {
    this.principalFor(actor);
    return this.state.activity.filter((event) => event.deploymentId === deploymentId).map((event) => structuredClone(event));
  }

  managementSnapshot(actor) {
    const user = this.principalFor(actor);
    return {
      role: user.role,
      canManage: user.role === "admin",
      config: structuredClone(this.state.config),
      authorizations: Object.values(this.state.keys).map((key) => this.managementAuthorization(key)),
      deployments: Object.values(this.state.deployments).map(({ deploymentId, type, name, createdAt }) => ({ deploymentId, type, name, createdAt })),
      instances: Object.values(this.state.instances).map(({ id, deploymentId, startedAt }) => ({ id, deploymentId, startedAt })),
      users: Object.values(this.state.users).map(({ username, role }) => ({ username, role })),
      activity: this.state.activity.map((event) => this.managementActivity(event)),
      counts: {
        deployments: Object.keys(this.state.deployments).length,
        instances: Object.keys(this.state.instances).length,
        users: Object.keys(this.state.users).length,
        activeAuthorizations: Object.values(this.state.keys).filter((key) => !key.revoked).length,
        activity: this.state.activity.length,
      },
    };
  }

  subscribeManagementActivity(actor, listener) {
    this.principalFor(actor);
    if (typeof listener !== "function") fail("INVALID_LISTENER");
    const subscription = { actor, listener };
    this.activitySubscriptions.add(subscription);
    return { close: () => this.activitySubscriptions.delete(subscription) };
  }

  publishActivity(event) {
    const dto = this.managementActivity(event);
    for (const subscription of this.activitySubscriptions) {
      try {
        this.principalFor(subscription.actor);
        subscription.listener(structuredClone(dto));
      } catch (error) {
        this.activitySubscriptions.delete(subscription);
      }
    }
  }

  managementAuthorization({ id, label, deploymentId, type, scopes, revoked }) {
    return { id, label, deploymentId, type, scopes: [...scopes], revoked };
  }

  managementActivity({ id, deploymentId, instanceId, type, recordedAt }) {
    return { id, deploymentId, instanceId, type, recordedAt };
  }

  deploymentFor({ deploymentId, type }) {
    const deployment = this.state.deployments[deploymentId];
    if (!deployment) fail("DEPLOYMENT_NOT_FOUND");
    if (deployment.type !== type) fail("DEPLOYMENT_TYPE_MISMATCH");
    return deployment;
  }
}

export async function createMorbr(options) {
  return MorbrService.open(options);
}

/**
 * Sanitized UI contract for FACTORY-1031. The facade intentionally exposes no
 * `state`, password/key digests, or authoritative principal records.
 */
export function createManagementClient(service, actor) {
  return Object.freeze({
    getSnapshot: () => service.managementSnapshot(actor),
    setConfig: (value) => service.setConfig(actor, value),
    createUser: (details) => service.createUser(actor, details),
    updateUser: (username, details) => service.updateUser(actor, username, details),
    issueAuthorization: (details) => service.issueKey(actor, details),
    updateAuthorization: (id, details) => service.updateAuthorization(actor, id, details),
    revokeAuthorization: (id) => service.revokeKey(actor, id),
    subscribeActivity: (listener) => service.subscribeManagementActivity(actor, listener),
  });
}

export { createMorbrHttpServer } from "./server.js";
