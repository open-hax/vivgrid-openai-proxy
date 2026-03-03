import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { FastifyInstance } from "fastify";

import { createApp } from "../app.js";
import type { ProxyConfig } from "../lib/config.js";

interface TestContext {
  readonly app: FastifyInstance;
  readonly upstream: Server;
  readonly tempDir: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function withProxyApp(
  options: {
    readonly keys: readonly string[];
    readonly models?: readonly string[];
    readonly upstreamHandler: (request: IncomingMessage, body: string) => Promise<{ status: number; headers?: Record<string, string>; body: string }>;
  },
  fn: (ctx: TestContext) => Promise<void>
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vivgrid-proxy-test-"));
  const keysPath = path.join(tempDir, "keys.json");
  const modelsPath = path.join(tempDir, "models.json");

  await writeFile(keysPath, JSON.stringify({ keys: options.keys }, null, 2), "utf8");
  if (options.models) {
    await writeFile(modelsPath, JSON.stringify({ models: options.models }, null, 2), "utf8");
  }

  const upstream = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    const result = await options.upstreamHandler(request, body);
    response.statusCode = result.status;

    if (result.headers) {
      for (const [name, value] of Object.entries(result.headers)) {
        response.setHeader(name, value);
      }
    }

    response.end(result.body);
  });

  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve upstream server address");
  }

  const config: ProxyConfig = {
    host: "127.0.0.1",
    port: 0,
    upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
    chatCompletionsPath: "/v1/chat/completions",
    keysFilePath: keysPath,
    modelsFilePath: modelsPath,
    keyReloadMs: 50,
    keyCooldownMs: 10000,
    requestTimeoutMs: 2000,
    proxyAuthToken: undefined
  };

  const app = await createApp(config);
  try {
    await fn({ app, upstream, tempDir });
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("rotates API key when first key is rate-limited", async () => {
  const observedKeys: string[] = [];

  await withProxyApp(
    {
      keys: ["key-a", "key-b"],
      upstreamHandler: async (request, body) => {
        const auth = request.headers.authorization;
        if (typeof auth === "string") {
          observedKeys.push(auth.replace(/^Bearer\s+/i, ""));
        }

        assert.ok(body.includes("gemini-3.1-pro-preview"));

        if (auth === "Bearer key-a") {
          const headers: Record<string, string> = {
            "content-type": "application/json",
            "retry-after": "1"
          };

          return {
            status: 429,
            headers,
            body: JSON.stringify({ error: { message: "rate limit" } })
          };
        }

        const headers: Record<string, string> = {
          "content-type": "application/json"
        };

        return {
          status: 200,
          headers,
          body: JSON.stringify({ id: "chatcmpl-123", object: "chat.completion", choices: [] })
        };
      }
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "gemini-3.1-pro-preview",
          messages: [{ role: "user", content: "hello" }],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.equal(payload.id, "chatcmpl-123");
      assert.deepEqual(observedKeys, ["key-a", "key-b"]);
    }
  );
});

test("returns 429 when every key is rate-limited", async () => {
  await withProxyApp(
    {
      keys: ["key-a", "key-b"],
      upstreamHandler: async () => ({
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "2"
        },
        body: JSON.stringify({ error: { message: "rate limit" } })
      })
    },
    async ({ app }) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          model: "gpt-5.3-codex",
          messages: [{ role: "user", content: "hello" }],
          stream: false
        }
      });

      assert.equal(response.statusCode, 429);
      assert.ok(response.headers["retry-after"]);

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.ok(isRecord(payload.error));
      assert.equal(payload.error.code, "no_available_key");
    }
  );
});

test("serves model catalog from models JSON file", async () => {
  await withProxyApp(
    {
      keys: ["key-a"],
      models: ["gpt-5.3-codex", "gemini-3.1-pro-preview"],
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ ok: true })
      })
    },
    async ({ app }) => {
      const listResponse = await app.inject({ method: "GET", url: "/v1/models" });
      assert.equal(listResponse.statusCode, 200);

      const listPayload: unknown = listResponse.json();
      assert.ok(isRecord(listPayload));
      assert.equal(listPayload.object, "list");
      assert.ok(Array.isArray(listPayload.data));
      assert.equal(listPayload.data.length, 2);

      const modelResponse = await app.inject({ method: "GET", url: "/v1/models/gpt-5.3-codex" });
      assert.equal(modelResponse.statusCode, 200);
      const modelPayload: unknown = modelResponse.json();
      assert.ok(isRecord(modelPayload));
      assert.equal(modelPayload.id, "gpt-5.3-codex");
    }
  );
});
