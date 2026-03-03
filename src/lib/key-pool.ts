import { readFile } from "node:fs/promises";

export interface KeyPoolConfig {
  readonly keysFilePath: string;
  readonly reloadIntervalMs: number;
  readonly defaultCooldownMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeKeys(raw: unknown): string[] {
  const source = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw["keys"])
      ? raw["keys"]
      : null;

  if (!source) {
    throw new Error("Invalid keys JSON: expected an array or {\"keys\": []}");
  }

  const unique = new Set<string>();
  for (const item of source) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (trimmed.length > 0) {
      unique.add(trimmed);
    }
  }

  return [...unique];
}

async function readKeysFile(path: string): Promise<string[]> {
  const contents = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(contents);
  const keys = normalizeKeys(parsed);
  if (keys.length === 0) {
    throw new Error("No API keys found in keys file");
  }
  return keys;
}

export class KeyPool {
  private readonly cooldownByKey = new Map<string, number>();
  private keys: string[] = [];
  private nextOffset = 0;
  private lastReloadAt = 0;
  private reloadInFlight: Promise<void> | null = null;

  public constructor(private readonly config: KeyPoolConfig) {}

  public async warmup(): Promise<void> {
    await this.ensureFreshKeys(true);
  }

  public async getRequestOrder(): Promise<string[]> {
    await this.ensureFreshKeys(false);

    if (this.keys.length === 0) {
      throw new Error("No API keys are available");
    }

    const keyCount = this.keys.length;
    const now = Date.now();
    const startOffset = this.nextOffset % keyCount;
    this.nextOffset = (this.nextOffset + 1) % keyCount;

    const available: string[] = [];
    for (let index = 0; index < keyCount; index += 1) {
      const key = this.keys[(startOffset + index) % keyCount];
      if (!key) {
        continue;
      }

      const cooldownUntil = this.cooldownByKey.get(key) ?? 0;
      if (cooldownUntil <= now) {
        available.push(key);
      }
    }

    return available;
  }

  public markRateLimited(key: string, retryAfterMs?: number): void {
    const cooldown = Math.max(retryAfterMs ?? this.config.defaultCooldownMs, 1000);
    this.cooldownByKey.set(key, Date.now() + cooldown);
  }

  public async msUntilAnyKeyReady(): Promise<number> {
    await this.ensureFreshKeys(false);

    if (this.keys.length === 0) {
      return 0;
    }

    const now = Date.now();
    let minDelay = Number.POSITIVE_INFINITY;
    for (const key of this.keys) {
      const cooldownUntil = this.cooldownByKey.get(key) ?? 0;
      if (cooldownUntil <= now) {
        return 0;
      }
      minDelay = Math.min(minDelay, cooldownUntil - now);
    }

    return Number.isFinite(minDelay) ? Math.max(minDelay, 0) : 0;
  }

  private async ensureFreshKeys(forceReload: boolean): Promise<void> {
    const now = Date.now();
    const needsReload =
      forceReload ||
      this.keys.length === 0 ||
      now - this.lastReloadAt >= this.config.reloadIntervalMs;

    if (!needsReload) {
      return;
    }

    if (this.reloadInFlight) {
      await this.reloadInFlight;
      return;
    }

    this.reloadInFlight = this.reloadKeys().finally(() => {
      this.reloadInFlight = null;
    });

    await this.reloadInFlight;
  }

  private async reloadKeys(): Promise<void> {
    this.lastReloadAt = Date.now();

    try {
      const keys = await readKeysFile(this.config.keysFilePath);
      this.keys = keys;
      this.nextOffset = this.nextOffset % keys.length;
      this.pruneCooldownMap();
    } catch (error) {
      if (this.keys.length === 0) {
        throw error;
      }
    }
  }

  private pruneCooldownMap(): void {
    const activeKeys = new Set(this.keys);
    for (const key of this.cooldownByKey.keys()) {
      if (!activeKeys.has(key)) {
        this.cooldownByKey.delete(key);
      }
    }
  }
}
