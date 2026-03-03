import { resolve } from "node:path";

export interface ProxyConfig {
  readonly host: string;
  readonly port: number;
  readonly upstreamBaseUrl: string;
  readonly chatCompletionsPath: string;
  readonly messagesPath: string;
  readonly messagesModelPrefixes: readonly string[];
  readonly responsesPath: string;
  readonly responsesModelPrefixes: readonly string[];
  readonly keysFilePath: string;
  readonly modelsFilePath: string;
  readonly keyReloadMs: number;
  readonly keyCooldownMs: number;
  readonly requestTimeoutMs: number;
  readonly proxyAuthToken?: string;
}

export const DEFAULT_MODELS: readonly string[] = [
  "gpt-5.2-codex",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "claude-opus-4-5",
  "gpt-5.3-codex",
  "gemini-3-flash-preview",
  "gpt-5.2",
  "DeepSeek-V3.2",
  "gemini-3-pro-preview",
  "gpt-5.1",
  "gpt-5",
  "gpt-5-mini",
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "glm-5",
  "Kimi-K2.5",
  "gemini-3.1-pro-preview"
];

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric environment variable ${name}: ${raw}`);
  }
  return parsed;
}

function filePathFromEnv(name: string, fallback: string, cwd: string): string {
  const raw = process.env[name] ?? fallback;
  return resolve(cwd, raw);
}

function csvFromEnv(name: string, fallback: readonly string[]): string[] {
  const raw = process.env[name];
  if (!raw) {
    return [...fallback];
  }

  const items = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return items.length > 0 ? items : [...fallback];
}

export function loadConfig(cwd: string = process.cwd()): ProxyConfig {
  const upstreamBaseUrl = (process.env.UPSTREAM_BASE_URL ?? "https://api.vivgrid.com").replace(/\/+$/, "");

  return {
    host: process.env.PROXY_HOST ?? "127.0.0.1",
    port: numberFromEnv("PROXY_PORT", 8787),
    upstreamBaseUrl,
    chatCompletionsPath: process.env.UPSTREAM_CHAT_COMPLETIONS_PATH ?? "/v1/chat/completions",
    messagesPath: process.env.UPSTREAM_MESSAGES_PATH ?? "/v1/messages",
    messagesModelPrefixes: csvFromEnv("UPSTREAM_MESSAGES_MODEL_PREFIXES", ["claude-"]),
    responsesPath: process.env.UPSTREAM_RESPONSES_PATH ?? "/v1/responses",
    responsesModelPrefixes: csvFromEnv("UPSTREAM_RESPONSES_MODEL_PREFIXES", ["gpt-"]),
    keysFilePath: filePathFromEnv("VIVGRID_KEYS_FILE", "./keys.json", cwd),
    modelsFilePath: filePathFromEnv("VIVGRID_MODELS_FILE", "./models.json", cwd),
    keyReloadMs: numberFromEnv("VIVGRID_KEY_RELOAD_MS", 5000),
    keyCooldownMs: numberFromEnv("VIVGRID_KEY_COOLDOWN_MS", 30000),
    requestTimeoutMs: numberFromEnv("UPSTREAM_REQUEST_TIMEOUT_MS", 180000),
    proxyAuthToken: process.env.PROXY_AUTH_TOKEN
  };
}
