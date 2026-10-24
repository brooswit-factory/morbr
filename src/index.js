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
  static async open({ statePath }) {
    const store = new JsonStateStore(statePath);
    return new MorbrService(store, await store.load());
  }

  constructor(store, state) {
    this.store = store;
    this.state = state;
    this.sessions = new Map();
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
      await this.persist();
    }
    return structuredClone(this.state.config);
  }

  getConfig(token, identity) {
    this.keyFor(token, "config", identity);
    return structuredClone(this.state.config);
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
    return structuredClone(event);
  }

  listActivity(actor, deploymentId) {
    this.principalFor(actor);
    return this.state.activity.filter((event) => event.deploymentId === deploymentId).map((event) => structuredClone(event));
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
