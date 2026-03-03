import { Readable } from "node:stream";

import Fastify, { type FastifyInstance } from "fastify";

import { DEFAULT_MODELS, type ProxyConfig } from "./lib/config.js";
import { KeyPool } from "./lib/key-pool.js";
import { loadModels, toOpenAiModel } from "./lib/models.js";
import {
  buildUpstreamHeaders,
  copyUpstreamHeaders,
  isRateLimitResponse,
  openAiError,
  parseRetryAfterMs,
} from "./lib/proxy.js";
import {
  chatCompletionToSse,
  chatRequestToResponsesRequest,
  responsesToChatCompletion,
  shouldUseResponsesUpstream,
} from "./lib/responses-compat.js";
import {
  chatRequestToMessagesRequest,
  messagesToChatCompletion,
  shouldUseMessagesUpstream,
} from "./lib/messages-compat.js";

interface ChatCompletionRequest {
  readonly model?: string;
  readonly messages?: unknown;
  readonly stream?: boolean;
  readonly [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasBearerToken(header: string | undefined, expectedToken: string): boolean {
  if (!header) {
    return false;
  }

  const [scheme, token] = header.split(/\s+/, 2);
  return scheme.toLowerCase() === "bearer" && token === expectedToken;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function createApp(config: ProxyConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
    bodyLimit: 300 * 1024 * 1024
  });

  const keyPool = new KeyPool({
    keysFilePath: config.keysFilePath,
    reloadIntervalMs: config.keyReloadMs,
    defaultCooldownMs: config.keyCooldownMs
  });
  await keyPool.warmup();

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    reply.header("Access-Control-Allow-Origin", origin ?? "*");
    reply.header("Vary", "Origin");
    reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, X-Requested-With");
    reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

    if (config.proxyAuthToken) {
      const authorization = request.headers.authorization;
      const ok = hasBearerToken(authorization, config.proxyAuthToken);
      if (!ok) {
        return reply.code(401).send(openAiError("Unauthorized", "invalid_request_error", "unauthorized"));
      }
    }
  });

  app.options("/*", async (_request, reply) => {
    reply.code(204).send();
  });

  app.get("/", async () => ({ ok: true, name: "vivgrid-openai-proxy", version: "0.1.0" }));
  app.get("/health", async () => ({ ok: true, service: "vivgrid-openai-proxy" }));

  app.get("/v1/models", async (_request, reply) => {
    const modelIds = await loadModels(config.modelsFilePath, DEFAULT_MODELS);
    reply.send({
      object: "list",
      data: modelIds.map(toOpenAiModel)
    });
  });

  app.get<{ Params: { model: string } }>("/v1/models/:model", async (request, reply) => {
    const modelIds = await loadModels(config.modelsFilePath, DEFAULT_MODELS);
    const model = modelIds.find((entry) => entry === request.params.model);
    if (!model) {
      reply.code(404).send(openAiError(`Model not found: ${request.params.model}`, "invalid_request_error", "model_not_found"));
      return;
    }

    reply.send(toOpenAiModel(model));
  });

  app.post<{ Body: ChatCompletionRequest }>("/v1/chat/completions", async (request, reply) => {
    if (!isRecord(request.body)) {
      reply.code(400).send(openAiError("Request body must be a JSON object", "invalid_request_error", "invalid_body"));
      return;
    }

    const requestedModel = typeof request.body.model === "string" ? request.body.model : "";
    const useMessagesUpstream = shouldUseMessagesUpstream(requestedModel, config.messagesModelPrefixes);
    const useResponsesUpstream = shouldUseResponsesUpstream(requestedModel, config.responsesModelPrefixes);
    const upstreamPath = useMessagesUpstream
      ? config.messagesPath
      : useResponsesUpstream
        ? config.responsesPath
        : config.chatCompletionsPath;
    const upstreamUrl = new URL(upstreamPath, `${config.upstreamBaseUrl}/`).toString();
    const upstreamPayload = useMessagesUpstream
      ? chatRequestToMessagesRequest(request.body)
      : useResponsesUpstream
        ? chatRequestToResponsesRequest(request.body)
        : request.body;
    const bodyText = JSON.stringify(upstreamPayload);
    const clientWantsStream = request.body.stream === true;

    let keys: string[];
    try {
      keys = await keyPool.getRequestOrder();
    } catch (error) {
      const message = toErrorMessage(error);
      request.log.error({ error: message }, "failed to load keys");
      reply.code(500).send(openAiError("Proxy is missing API keys configuration", "server_error", "keys_unavailable"));
      return;
    }

    if (keys.length === 0) {
      const retryInMs = await keyPool.msUntilAnyKeyReady();
      if (retryInMs > 0) {
        reply.header("retry-after", Math.ceil(retryInMs / 1000));
      }

      reply
        .code(429)
        .send(
          openAiError(
            "All upstream API keys are currently rate-limited. Retry after the cooldown window.",
            "rate_limit_error",
            "all_keys_rate_limited"
          )
        );
      return;
    }

    let sawRateLimit = false;
    let sawRequestError = false;
    let sawUpstreamServerError = false;

    for (const apiKey of keys) {
      const upstreamHeaders = buildUpstreamHeaders(request.headers, apiKey);

      let upstreamResponse: Response;
      try {
        upstreamResponse = await fetch(upstreamUrl, {
          method: "POST",
          headers: upstreamHeaders,
          body: bodyText,
          signal: AbortSignal.timeout(config.requestTimeoutMs)
        });
      } catch (error) {
        sawRequestError = true;
        request.log.warn({ error: toErrorMessage(error) }, "upstream request failed for one key");
        continue;
      }

      if (isRateLimitResponse(upstreamResponse)) {
        sawRateLimit = true;
        const retryAfter = parseRetryAfterMs(upstreamResponse.headers.get("retry-after"));
        keyPool.markRateLimited(apiKey, retryAfter);

        request.log.warn(
          {
            status: upstreamResponse.status,
            keySuffix: apiKey.slice(-6)
          },
          "rate limited by upstream key; trying next key"
        );
        continue;
      }

      if (upstreamResponse.status >= 500 && upstreamResponse.status <= 599) {
        sawUpstreamServerError = true;
        keyPool.markRateLimited(apiKey, Math.min(config.keyCooldownMs, 5000));

        request.log.warn(
          {
            status: upstreamResponse.status,
            keySuffix: apiKey.slice(-6)
          },
          "upstream server error for key; trying next key"
        );

        try {
          await upstreamResponse.arrayBuffer();
        } catch {
          // Ignore body read failures while failing over.
        }

        continue;
      }

      if ((useResponsesUpstream || useMessagesUpstream) && upstreamResponse.ok) {
        let upstreamJson: unknown;
        try {
          upstreamJson = await upstreamResponse.json();
        } catch (error) {
          sawRequestError = true;
          request.log.warn({ error: toErrorMessage(error) }, "failed to parse transformed upstream JSON");
          continue;
        }

        const chatCompletion = useMessagesUpstream
          ? messagesToChatCompletion(upstreamJson, requestedModel)
          : responsesToChatCompletion(upstreamJson, requestedModel);
        if (clientWantsStream) {
          reply.code(200);
          reply.header("content-type", "text/event-stream; charset=utf-8");
          reply.header("cache-control", "no-cache");
          reply.header("x-accel-buffering", "no");
          reply.send(chatCompletionToSse(chatCompletion));
          return;
        }

        reply.code(upstreamResponse.status);
        reply.header("content-type", "application/json");
        reply.send(chatCompletion);
        return;
      }

      reply.code(upstreamResponse.status);
      copyUpstreamHeaders(reply, upstreamResponse.headers);

      const contentType = upstreamResponse.headers.get("content-type") ?? "";
      const isEventStream = contentType.toLowerCase().includes("text/event-stream");

      if (!upstreamResponse.body) {
        const responseText = await upstreamResponse.text();
        reply.send(responseText);
        return;
      }

      if (isEventStream) {
        const stream = Readable.fromWeb(upstreamResponse.body as any);
        reply.send(stream);
        return;
      }

      const bytes = Buffer.from(await upstreamResponse.arrayBuffer());
      reply.send(bytes);
      return;
    }

    if (sawRateLimit) {
      const retryInMs = await keyPool.msUntilAnyKeyReady();
      if (retryInMs > 0) {
        reply.header("retry-after", Math.ceil(retryInMs / 1000));
      }

      reply
        .code(429)
        .send(
          openAiError(
            "No upstream key succeeded. Keys may be rate-limited or temporarily unavailable.",
            "rate_limit_error",
            "no_available_key"
          )
        );
      return;
    }

    if (sawUpstreamServerError) {
      reply
        .code(502)
        .send(
          openAiError(
            "Upstream returned transient server errors across all available keys.",
            "server_error",
            "upstream_server_error"
          )
        );
      return;
    }

    const message = sawRequestError
      ? "All upstream attempts failed due to network/transport errors."
      : "Upstream rejected the request with no successful fallback.";

    reply.code(502).send(openAiError(message, "server_error", "upstream_unavailable"));
  });

  return app;
}
