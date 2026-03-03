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
    messagesPath: "/v1/messages",
    messagesModelPrefixes: ["claude-"],
    responsesPath: "/v1/responses",
    responsesModelPrefixes: ["gpt-"],
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

test("retries with next key when upstream returns 500", async () => {
  const observedKeys: string[] = [];

  await withProxyApp(
    {
      keys: ["key-a", "key-b"],
      upstreamHandler: async (request) => {
        const auth = request.headers.authorization;
        if (typeof auth === "string") {
          observedKeys.push(auth.replace(/^Bearer\s+/i, ""));
        }

        if (auth === "Bearer key-a") {
          return {
            status: 500,
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({ error: { message: "temporary upstream error" } })
          };
        }

        return {
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({ id: "chatcmpl-500-fallback", object: "chat.completion", choices: [] })
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
      assert.equal(payload.id, "chatcmpl-500-fallback");
      assert.deepEqual(observedKeys, ["key-a", "key-b"]);
    }
  );
});

test("routes gpt chat requests to responses endpoint and maps response", async () => {
  let observedPath = "";
  let observedBody: unknown;

  await withProxyApp(
    {
      keys: ["key-a"],
      upstreamHandler: async (request, body) => {
        observedPath = request.url ?? "";
        observedBody = JSON.parse(body);

        return {
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            id: "resp_abc",
            object: "response",
            created_at: 1772516800,
            model: "gpt-5.3-codex",
            output: [
              {
                id: "msg_abc",
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: "responses-route-ok"
                  }
                ]
              }
            ],
            usage: {
              input_tokens: 9,
              output_tokens: 4,
              total_tokens: 13
            }
          })
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
          model: "gpt-5.3-codex",
          messages: [{ role: "user", content: "hello" }],
          stream: false,
          max_tokens: 256,
          reasoningEffort: "high",
          reasoningSummary: "auto",
          textVerbosity: "low",
          include: ["reasoning.encrypted_content"],
          tools: [
            {
              type: "function",
              function: {
                name: "bash",
                description: "Run shell command",
                parameters: {
                  type: "object",
                  properties: {
                    command: {
                      type: "string"
                    }
                  },
                  required: ["command"],
                  additionalProperties: false
                }
              }
            }
          ],
          tool_choice: {
            type: "function",
            function: {
              name: "bash"
            }
          }
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(observedPath, "/v1/responses");
      assert.ok(isRecord(observedBody));
      assert.equal(observedBody.stream, false);
      assert.equal(observedBody.max_output_tokens, 256);
      assert.ok(Array.isArray(observedBody.input));
      assert.ok(Array.isArray(observedBody.tools));
      assert.ok(isRecord(observedBody.tools[0]));
      assert.equal(observedBody.tools[0].name, "bash");
      assert.equal(observedBody.tools[0].type, "function");
      assert.ok(isRecord(observedBody.tool_choice));
      assert.equal(observedBody.tool_choice.type, "function");
      assert.equal(observedBody.tool_choice.name, "bash");
      assert.ok(isRecord(observedBody.reasoning));
      assert.equal(observedBody.reasoning.effort, "high");
      assert.equal(observedBody.reasoning.summary, "auto");
      assert.ok(isRecord(observedBody.text));
      assert.equal(observedBody.text.verbosity, "low");
      assert.ok(Array.isArray(observedBody.include));
      assert.equal(observedBody.include[0], "reasoning.encrypted_content");

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.equal(payload.object, "chat.completion");
      assert.equal(payload.model, "gpt-5.3-codex");
      assert.ok(Array.isArray(payload.choices));
      assert.ok(isRecord(payload.choices[0]));
      assert.ok(isRecord(payload.choices[0].message));
      assert.equal(payload.choices[0].message.content, "responses-route-ok");
      assert.ok(isRecord(payload.usage));
      assert.equal(payload.usage.total_tokens, 13);
    }
  );
});

test("normalizes chat content part type text to responses input_text/output_text", async () => {
  let observedBody: unknown;

  await withProxyApp(
    {
      keys: ["key-a"],
      upstreamHandler: async (_request, body) => {
        observedBody = JSON.parse(body);

        return {
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            id: "resp_norm",
            object: "response",
            created_at: 1772516803,
            model: "gpt-5.3-codex",
            output: [
              {
                id: "msg_norm",
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: "ok"
                  }
                ]
              }
            ]
          })
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
          model: "gpt-5.3-codex",
          messages: [
            {
              role: "system",
              content: [{ type: "text", text: "system text" }]
            },
            {
              role: "assistant",
              content: [{ type: "text", text: "assistant text" }]
            },
            {
              role: "user",
              content: [{ type: "text", text: "user text" }]
            }
          ],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.ok(isRecord(observedBody));
      assert.ok(Array.isArray(observedBody.input));
      assert.equal(observedBody.input.length, 3);

      assert.ok(isRecord(observedBody.input[0]));
      assert.ok(Array.isArray(observedBody.input[0].content));
      assert.ok(isRecord(observedBody.input[0].content[0]));
      assert.equal(observedBody.input[0].content[0].type, "input_text");

      assert.ok(isRecord(observedBody.input[1]));
      assert.ok(Array.isArray(observedBody.input[1].content));
      assert.ok(isRecord(observedBody.input[1].content[0]));
      assert.equal(observedBody.input[1].content[0].type, "output_text");

      assert.ok(isRecord(observedBody.input[2]));
      assert.ok(Array.isArray(observedBody.input[2].content));
      assert.ok(isRecord(observedBody.input[2].content[0]));
      assert.equal(observedBody.input[2].content[0].type, "input_text");
    }
  );
});

test("maps responses function_call output to chat tool_calls", async () => {
  await withProxyApp(
    {
      keys: ["key-a"],
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          id: "resp_tool_call",
          object: "response",
          created_at: 1772516801,
          model: "gpt-5.3-codex",
          output: [
            {
              id: "fc_1",
              type: "function_call",
              call_id: "call_1",
              name: "bash",
              arguments: "{\"command\":\"pwd\"}"
            }
          ]
        })
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
          messages: [{ role: "user", content: "run pwd" }],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.ok(Array.isArray(payload.choices));
      assert.ok(isRecord(payload.choices[0]));
      assert.equal(payload.choices[0].finish_reason, "tool_calls");
      assert.ok(isRecord(payload.choices[0].message));
      assert.equal(payload.choices[0].message.content, null);
      assert.ok(Array.isArray(payload.choices[0].message.tool_calls));
      assert.ok(isRecord(payload.choices[0].message.tool_calls[0]));
      assert.ok(isRecord(payload.choices[0].message.tool_calls[0].function));
      assert.equal(payload.choices[0].message.tool_calls[0].function.name, "bash");
    }
  );
});

test("returns synthetic chat-completion SSE for gpt stream requests", async () => {
  await withProxyApp(
    {
      keys: ["key-a"],
      upstreamHandler: async () => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          id: "resp_stream",
          object: "response",
          created_at: 1772516802,
          model: "gpt-5.3-codex",
          output: [
            {
              id: "msg_stream",
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "stream-via-responses"
                }
              ]
            }
          ]
        })
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
          stream: true
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["content-type"], "text/event-stream; charset=utf-8");
      assert.ok(response.body.includes("chat.completion.chunk"));
      assert.ok(response.body.includes("stream-via-responses"));
      assert.ok(response.body.includes("data: [DONE]"));
    }
  );
});

test("routes claude chat requests to messages endpoint and maps response", async () => {
  let observedPath = "";
  let observedBody: unknown;

  await withProxyApp(
    {
      keys: ["key-a"],
      upstreamHandler: async (request, body) => {
        observedPath = request.url ?? "";
        observedBody = JSON.parse(body);

        return {
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            id: "msg_claude_1",
            model: "claude-opus-4-5-20251101",
            role: "assistant",
            type: "message",
            content: [
              {
                type: "text",
                text: "claude-mapped-ok"
              }
            ],
            stop_reason: "end_turn",
            usage: {
              input_tokens: 11,
              output_tokens: 7
            }
          })
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
          model: "claude-opus-4-5",
          messages: [
            { role: "system", content: "You are terse" },
            { role: "user", content: "hello", cache_control: { type: "ephemeral" } }
          ],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(observedPath, "/v1/messages");
      assert.ok(isRecord(observedBody));
      assert.equal(observedBody.model, "claude-opus-4-5");
      assert.equal(observedBody.system, "You are terse");
      assert.ok(Array.isArray(observedBody.messages));
      assert.equal(observedBody.messages.length, 1);
      assert.ok(isRecord(observedBody.messages[0]));
      assert.equal(observedBody.messages[0].role, "user");
      assert.equal(observedBody.messages[0].cache_control, undefined);

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.equal(payload.object, "chat.completion");
      assert.equal(payload.model, "claude-opus-4-5-20251101");
      assert.ok(Array.isArray(payload.choices));
      assert.ok(isRecord(payload.choices[0]));
      assert.ok(isRecord(payload.choices[0].message));
      assert.equal(payload.choices[0].message.content, "claude-mapped-ok");
      assert.ok(isRecord(payload.usage));
      assert.equal(payload.usage.prompt_tokens, 11);
      assert.equal(payload.usage.completion_tokens, 7);
      assert.equal(payload.usage.total_tokens, 18);
    }
  );
});

test("maps claude tool_use content to chat tool_calls", async () => {
  let observedBody: unknown;

  await withProxyApp(
    {
      keys: ["key-a"],
      upstreamHandler: async (_request, body) => {
        observedBody = JSON.parse(body);

        return {
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            id: "msg_claude_2",
            model: "claude-opus-4-5-20251101",
            role: "assistant",
            type: "message",
            content: [
              {
                type: "tool_use",
                id: "toolu_123",
                name: "bash",
                input: {
                  command: "pwd"
                }
              }
            ],
            stop_reason: "tool_use",
            usage: {
              input_tokens: 22,
              output_tokens: 9
            }
          })
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
          model: "claude-opus-4-5",
          messages: [{ role: "user", content: "run pwd" }],
          tools: [
            {
              type: "function",
              function: {
                name: "bash",
                description: "run shell command",
                parameters: {
                  type: "object",
                  properties: {
                    command: {
                      type: "string"
                    }
                  },
                  required: ["command"],
                  additionalProperties: false
                }
              }
            }
          ],
          tool_choice: "required",
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.ok(isRecord(observedBody));
      assert.ok(Array.isArray(observedBody.tools));
      assert.ok(isRecord(observedBody.tools[0]));
      assert.equal(observedBody.tools[0].name, "bash");
      assert.ok(isRecord(observedBody.tool_choice));
      assert.equal(observedBody.tool_choice.type, "any");

      const payload: unknown = response.json();
      assert.ok(isRecord(payload));
      assert.ok(Array.isArray(payload.choices));
      assert.ok(isRecord(payload.choices[0]));
      assert.equal(payload.choices[0].finish_reason, "tool_calls");
      assert.ok(isRecord(payload.choices[0].message));
      assert.equal(payload.choices[0].message.content, null);
      assert.ok(Array.isArray(payload.choices[0].message.tool_calls));
      assert.ok(isRecord(payload.choices[0].message.tool_calls[0]));
      assert.equal(payload.choices[0].message.tool_calls[0].id, "toolu_123");
      assert.ok(isRecord(payload.choices[0].message.tool_calls[0].function));
      assert.equal(payload.choices[0].message.tool_calls[0].function.name, "bash");
      assert.equal(payload.choices[0].message.tool_calls[0].function.arguments, "{\"command\":\"pwd\"}");
    }
  );
});

test("maps assistant tool_calls + tool result transcript to messages format", async () => {
  let observedBody: unknown;

  await withProxyApp(
    {
      keys: ["key-a"],
      upstreamHandler: async (_request, body) => {
        observedBody = JSON.parse(body);

        return {
          status: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            id: "msg_claude_transcript",
            model: "claude-opus-4-5-20251101",
            role: "assistant",
            type: "message",
            content: [
              {
                type: "text",
                text: "claude-transcript-ok"
              }
            ],
            stop_reason: "end_turn",
            usage: {
              input_tokens: 40,
              output_tokens: 8
            }
          })
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
          model: "claude-opus-4-5",
          messages: [
            {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "bash",
                    arguments: "{\"command\":\"pwd\"}"
                  }
                }
              ]
            },
            {
              role: "tool",
              tool_call_id: "call_1",
              content: "/tmp"
            },
            {
              role: "user",
              content: "continue"
            }
          ],
          stream: false
        }
      });

      assert.equal(response.statusCode, 200);
      assert.ok(isRecord(observedBody));
      assert.ok(Array.isArray(observedBody.messages));
      assert.equal(observedBody.messages.length, 3);

      assert.ok(isRecord(observedBody.messages[0]));
      assert.equal(observedBody.messages[0].role, "assistant");
      assert.ok(Array.isArray(observedBody.messages[0].content));
      assert.ok(isRecord(observedBody.messages[0].content[0]));
      assert.equal(observedBody.messages[0].content[0].type, "tool_use");
      assert.equal(observedBody.messages[0].content[0].id, "call_1");
      assert.equal(observedBody.messages[0].content[0].name, "bash");

      assert.ok(isRecord(observedBody.messages[1]));
      assert.equal(observedBody.messages[1].role, "user");
      assert.ok(Array.isArray(observedBody.messages[1].content));
      assert.ok(isRecord(observedBody.messages[1].content[0]));
      assert.equal(observedBody.messages[1].content[0].type, "tool_result");
      assert.equal(observedBody.messages[1].content[0].tool_use_id, "call_1");
      assert.equal(observedBody.messages[1].content[0].content, "/tmp");

      assert.ok(isRecord(observedBody.messages[2]));
      assert.equal(observedBody.messages[2].role, "user");
      assert.equal(observedBody.messages[2].content, "continue");
    }
  );
});

test("returns synthetic chat-completion SSE for claude stream requests", async () => {
  await withProxyApp(
    {
      keys: ["key-a"],
      upstreamHandler: async (_request) => ({
        status: 200,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          id: "msg_claude_stream",
          model: "claude-opus-4-5-20251101",
          role: "assistant",
          type: "message",
          content: [
            {
              type: "text",
              text: "claude-stream-chat-ok"
            }
          ],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 12,
            output_tokens: 8
          }
        })
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
          model: "claude-opus-4-5",
          messages: [{ role: "user", content: "hello" }],
          stream: true
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["content-type"], "text/event-stream; charset=utf-8");
      assert.ok(response.body.includes("chat.completion.chunk"));
      assert.ok(response.body.includes("claude-stream-chat-ok"));
      assert.ok(response.body.includes("data: [DONE]"));
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
