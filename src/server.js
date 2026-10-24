import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const JSON_LIMIT = 1_000_000;

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function basicCredentials(request) {
  const match = /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? "");
  if (!match) return null;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  return username && password !== undefined ? { username, password } : null;
}

function bearerToken(request) {
  return /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? "")?.[1] ?? null;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > JSON_LIMIT) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("invalid json"), { status: 400 });
  }
}

function identity(searchParams) {
  return { deploymentId: searchParams.get("deploymentId"), type: searchParams.get("type") };
}

function event(response, name, payload) {
  response.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Runnable local/remote transport for Morbr. Credentials are injected only at
 * startup; nothing in this module persists a bearer token or webhook secret.
 */
export function createMorbrHttpServer({ service, webhookBindings = {} }) {
  const streams = new Set();
  function closeStream(stream, error) {
    if (!streams.delete(stream)) return;
    stream.subscription?.close();
    if (!stream.response.writableEnded) {
      if (error) event(stream.response, "error", { code: error.code ?? "UNAUTHORIZED", message: error.message ?? error.code ?? "UNAUTHORIZED", retryable: false });
      stream.response.end();
    }
  }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://morbr.local");
      if (request.method === "GET" && url.pathname === "/management") {
        const credentials = basicCredentials(request);
        if (!credentials) return send(response, 401, { code: "UNAUTHORIZED" });
        return send(response, 200, service.managementSnapshot(service.authenticate(credentials)));
      }

      if (request.method === "PATCH" && url.pathname === "/config") {
        const credentials = basicCredentials(request);
        if (!credentials) return send(response, 401, { code: "UNAUTHORIZED" });
        const config = await service.setConfig(service.authenticate(credentials), await readJson(request));
        return send(response, 200, config);
      }

      if (request.method === "POST" && url.pathname === "/management/users") {
        const actor = service.authenticate(basicCredentials(request) ?? {});
        return send(response, 201, await service.createUser(actor, await readJson(request)));
      }
      const user = /^\/management\/users\/([^/]+)$/.exec(url.pathname);
      if (request.method === "PATCH" && user) {
        const actor = service.authenticate(basicCredentials(request) ?? {});
        return send(response, 200, await service.updateUser(actor, decodeURIComponent(user[1]), await readJson(request)));
      }
      if (request.method === "POST" && url.pathname === "/management/authorizations") {
        const actor = service.authenticate(basicCredentials(request) ?? {});
        const issued = await service.issueKey(actor, await readJson(request));
        return send(response, 201, issued);
      }
      const authorization = /^\/management\/authorizations\/([^/]+)$/.exec(url.pathname);
      if (request.method === "PATCH" && authorization) {
        const actor = service.authenticate(basicCredentials(request) ?? {});
        return send(response, 200, await service.updateAuthorization(actor, decodeURIComponent(authorization[1]), await readJson(request)));
      }
      if (request.method === "DELETE" && authorization) {
        const actor = service.authenticate(basicCredentials(request) ?? {});
        await service.revokeKey(actor, decodeURIComponent(authorization[1]));
        return send(response, 204, {});
      }

      if (request.method === "GET" && url.pathname === "/events/config") {
        const token = bearerToken(request);
        if (!token) return send(response, 401, { code: "UNAUTHORIZED" });
        const requestedIdentity = identity(url.searchParams);
        const subscriptionId = url.searchParams.get("subscriptionId");
        const streamEpoch = Number(url.searchParams.get("streamEpoch") ?? "1");
        if (!subscriptionId || !Number.isSafeInteger(streamEpoch) || streamEpoch < 1) {
          return send(response, 400, { code: "INVALID_SUBSCRIPTION" });
        }
        // Authorize before committing the SSE response headers so denials stay
        // ordinary HTTP errors rather than a half-open event stream.
        service.getConfig(token, requestedIdentity);
        const stream = { response, subscription: null, subscriptionId, streamEpoch, sequence: 0 };
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        stream.subscription = service.subscribeConfig(token, requestedIdentity, (config) => {
          const kind = stream.sequence === 0 ? "snapshot" : "change";
          const operation = kind === "change" ? "upsert" : undefined;
          event(response, "config", { contractVersion: "1.0", kind, subscriptionId: stream.subscriptionId, streamEpoch: stream.streamEpoch, sequence: ++stream.sequence, cursor: `config-${config.version}`, subject: { kind: "config", key: `${requestedIdentity.type}:${requestedIdentity.deploymentId}` }, data: { version: config.version, value: config.value, ...(operation ? { operation } : {}) }, ...(operation ? { operation } : {}), meta: { emittedAt: new Date().toISOString(), source: "morbr" } });
        }, (error) => closeStream(stream, error));
        streams.add(stream);
        request.once("close", () => closeStream(stream));
        return;
      }

      if (request.method === "GET" && url.pathname === "/events/resource") {
        const token = bearerToken(request);
        if (!token) return send(response, 401, { code: "UNAUTHORIZED" });
        const requestedIdentity = identity(url.searchParams);
        const instanceId = url.searchParams.get("instanceId");
        const provider = url.searchParams.get("provider");
        const resource = url.searchParams.get("resource");
        const subjectKey = url.searchParams.get("subject");
        const subscriptionId = url.searchParams.get("subscriptionId");
        const streamEpoch = Number(url.searchParams.get("streamEpoch") ?? "1");
        if (!instanceId || !provider || resource === null || !subjectKey || !subscriptionId || !Number.isSafeInteger(streamEpoch) || streamEpoch < 1) {
          return send(response, 400, { code: "INVALID_RESOURCE_SUBSCRIPTION" });
        }
        // Validate the scoped reporting key before committing the stream.
        service.keyFor(token, "reporting", service.deploymentFor(requestedIdentity));
        const stream = { response, subscription: null, subscriptionId, streamEpoch, sequence: 0 };
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        stream.subscription = service.subscribeMorbinResource({
          reportingToken: token,
          identity: requestedIdentity,
          instanceId,
          provider,
          resource,
          listener: (upstream) => {
            const envelope = {
              ...upstream,
              subscriptionId: stream.subscriptionId,
              streamEpoch: stream.streamEpoch,
              sequence: ++stream.sequence,
              subject: { kind: "resource", key: subjectKey },
              meta: { ...upstream.meta, source: "morbr", upstreamFreshness: service.upstreamFreshnessBounds() },
            };
            event(response, "resource", envelope);
            if (upstream.kind === "error" && upstream.error?.retryable === false) closeStream(stream);
          },
          onClose: (error) => closeStream(stream, error),
        });
        streams.add(stream);
        request.once("close", () => closeStream(stream));
        return;
      }

      if (request.method === "GET" && url.pathname === "/events/activity") {
        const credentials = basicCredentials(request);
        if (!credentials) return send(response, 401, { code: "UNAUTHORIZED" });
        const actor = service.authenticate(credentials);
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        const stream = { response, subscription: service.subscribeManagementActivity(actor, (activity) => event(response, "activity", activity)) };
        streams.add(stream);
        request.once("close", () => closeStream(stream));
        return;
      }

      const webhook = /^\/webhooks\/([^/]+)$/.exec(url.pathname);
      if (request.method === "POST" && webhook) {
        const binding = webhookBindings[decodeURIComponent(webhook[1])];
        if (!binding) return send(response, 404, { code: "WEBHOOK_NOT_FOUND" });
        const raw = await readJson(request);
        const expected = `sha256=${createHmac("sha256", binding.secret).update(JSON.stringify(raw)).digest("hex")}`;
        const received = request.headers["x-morbr-signature"];
        if (typeof received !== "string" || received.length !== expected.length || !timingSafeEqual(Buffer.from(received), Buffer.from(expected))) {
          return send(response, 401, { code: "UNAUTHORIZED" });
        }
        await service.ingestMorbinEvent(binding.reportingToken, binding.identity, raw);
        if (binding.instanceId) {
          await service.recordActivity(binding.reportingToken, {
            ...binding.identity,
            instanceId: binding.instanceId,
            type: "webhook",
            payload: raw,
          });
        }
        return send(response, 202, { accepted: true });
      }

      return send(response, 404, { code: "NOT_FOUND" });
    } catch (error) {
      if (response.headersSent) return response.end();
      const code = error?.code ?? "BAD_REQUEST";
      const status = error?.status ?? (code === "UNAUTHORIZED" ? 401 : code === "FORBIDDEN" ? 403 : 400);
      return send(response, status, { code });
    }
  });

  return {
    server,
    async start({ host = "127.0.0.1", port = 0 } = {}) {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => { server.off("error", reject); resolve(); });
      });
      return server.address();
    },
    async close() {
      for (const stream of [...streams]) closeStream(stream);
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
