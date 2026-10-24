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

  async save(state) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

/**
 * Generic central Morbr service. It stores config and activity; it does not
 * launch jobs or execute client-provided events.
 */
export class MorbrService {
  static async open({ statePath }) {
    const store = new JsonStateStore(statePath);
    return new MorbrService(store, await store.load());
  }

  constructor(store, state) {
    this.store = store;
    this.state = state;
  }

  async persist() {
    await this.store.save(this.state);
  }

  async createUser({ username, password, role }) {
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(username ?? "")) fail("INVALID_USERNAME");
    if (role !== "admin" && role !== "reader") fail("INVALID_ROLE");
    if (this.state.users[username]) fail("USER_EXISTS");
    const credentials = passwordDigest(password);
    this.state.users[username] = { username, role, salt: credentials.salt, passwordDigest: credentials.digest };
    await this.persist();
    return { username, role };
  }

  authenticate({ username, password }) {
    const user = this.state.users[username];
    if (!user || !matchesPassword(password, user)) fail("UNAUTHORIZED");
    return { username: user.username, role: user.role };
  }

  requireAdmin(actor) {
    if (!actor || actor.role !== "admin") fail("FORBIDDEN");
  }

  async issueKey(actor, { scopes, label = "" }) {
    this.requireAdmin(actor);
    if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some((scope) => !["config", "reporting"].includes(scope))) {
      fail("INVALID_SCOPES");
    }
    const token = `mrb_${randomBytes(24).toString("base64url")}`;
    const id = randomUUID();
    this.state.keys[id] = { id, label, scopes: [...new Set(scopes)].sort(), digest: tokenDigest(token), revoked: false };
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

  keyFor(token, scope) {
    const digest = tokenDigest(token ?? "");
    const key = Object.values(this.state.keys).find((candidate) => candidate.digest === digest);
    if (!key || key.revoked) fail("UNAUTHORIZED");
    if (!key.scopes.includes(scope)) fail("FORBIDDEN");
    return key;
  }

  async setConfig(actor, value) {
    this.requireAdmin(actor);
    const encoded = JSON.stringify(value);
    if (encoded === undefined) fail("INVALID_CONFIG");
    // De-duplicate equivalent snapshots so subscribers see semantic changes only.
    if (JSON.stringify(this.state.config.value) !== encoded) {
      this.state.config = { version: this.state.config.version + 1, value };
      await this.persist();
    }
    return structuredClone(this.state.config);
  }

  getConfig(token) {
    this.keyFor(token, "config");
    return structuredClone(this.state.config);
  }

  async registerDeployment({ deploymentId, name = "" }) {
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(deploymentId ?? "")) fail("INVALID_DEPLOYMENT_ID");
    const existing = this.state.deployments[deploymentId];
    if (!existing) {
      this.state.deployments[deploymentId] = { deploymentId, name, createdAt: new Date().toISOString() };
      await this.persist();
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
    this.keyFor(token, "reporting");
    const instance = this.state.instances[instanceId];
    if (!this.state.deployments[deploymentId] || !instance || instance.deploymentId !== deploymentId) fail("UNKNOWN_IDENTITY");
    if (typeof type !== "string" || type.length === 0) fail("INVALID_ACTIVITY");
    const event = { id: randomUUID(), deploymentId, instanceId, type, payload, recordedAt: new Date().toISOString() };
    this.state.activity.push(event);
    await this.persist();
    return structuredClone(event);
  }

  listActivity(actor, deploymentId) {
    if (!actor || !["admin", "reader"].includes(actor.role)) fail("UNAUTHORIZED");
    return this.state.activity.filter((event) => event.deploymentId === deploymentId).map((event) => structuredClone(event));
  }
}

export async function createMorbr(options) {
  return MorbrService.open(options);
}
