import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";

export type AccountLimits = { maxConcurrent: number; monthlyRequestQuota: number };
export type AccountUsage = {
  month: string;
  requests: number;
  succeeded: number;
  failed: number;
};
export type AccountSummary = {
  id: string;
  externalId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  limits: AccountLimits;
};
export type BrowserToken = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  rotatedAt?: string;
  revokedAt?: string;
  lastUsedAt?: string;
};
export type RequestStatus = "succeeded" | "navigation_failed" | "timeout" | "challenge" | "access_wall" | "empty_content" | "canceled";
export type RequestLog = {
  requestId: string;
  tokenId: string;
  hostname: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: RequestStatus;
};
export type TokenAuthentication = {
  accountId: string;
  externalId: string;
  tokenId: string;
  limits: AccountLimits;
};

type StoredToken = BrowserToken & { hash: string };
type StoredAccount = AccountSummary & {
  tokens: StoredToken[];
  usage: Record<string, Omit<AccountUsage, "month">>;
  logs: RequestLog[];
};
type StoreState = { version: 1; accounts: Record<string, StoredAccount> };

export class AccountStoreError extends Error {
  constructor(readonly code: "invalid_request" | "not_found", message: string) {
    super(message);
    this.name = "AccountStoreError";
  }
}

export type EnsureAccountInput = {
  name?: string;
  limits?: Partial<AccountLimits>;
};

const defaultLimits: AccountLimits = { maxConcurrent: 2, monthlyRequestQuota: 10_000 };

export class AccountStore {
  private readonly path: string;
  private readonly clock: () => Date;
  private readonly maxLogsPerAccount: number;
  private state: StoreState | undefined;
  private mutation: Promise<unknown> = Promise.resolve();

  constructor(private readonly directory: string, options: {
    clock?: () => Date;
    maxLogsPerAccount?: number;
  } = {}) {
    this.path = join(directory, "accounts.json");
    this.clock = options.clock ?? (() => new Date());
    this.maxLogsPerAccount = options.maxLogsPerAccount ?? 500;
    if (!Number.isInteger(this.maxLogsPerAccount) || this.maxLogsPerAccount < 1) {
      throw new Error("maxLogsPerAccount must be a positive integer.");
    }
  }

  async ensureAccount(externalId: string, input: EnsureAccountInput): Promise<AccountSummary> {
    validateExternalId(externalId);
    validateEnsureInput(input);
    return this.mutate((state) => {
      const now = this.clock().toISOString();
      const existing = state.accounts[externalId];
      if (existing !== undefined) {
        if (input.name !== undefined) existing.name = input.name;
        if (input.limits !== undefined) existing.limits = { ...existing.limits, ...input.limits };
        existing.updatedAt = now;
        return publicAccount(existing);
      }
      const account: StoredAccount = {
        id: randomUUID(),
        externalId,
        name: input.name ?? externalId,
        createdAt: now,
        updatedAt: now,
        limits: { ...defaultLimits, ...input.limits },
        tokens: [],
        usage: {},
        logs: [],
      };
      state.accounts[externalId] = account;
      return publicAccount(account);
    });
  }

  async getAccount(externalId: string): Promise<AccountSummary | undefined> {
    validateExternalId(externalId);
    const state = await this.readState();
    const account = state.accounts[externalId];
    return account === undefined ? undefined : publicAccount(account);
  }

  async createToken(externalId: string, name: string): Promise<{ token: BrowserToken; secret: string }> {
    validateTokenName(name);
    return this.mutate((state) => {
      const account = requireAccount(state, externalId);
      const secret = makeSecret();
      const now = this.clock().toISOString();
      const token: StoredToken = {
        id: randomUUID(), name, prefix: secret.slice(0, 12), hash: hashSecret(secret), createdAt: now,
      };
      account.tokens.push(token);
      account.updatedAt = now;
      return { token: publicToken(token), secret };
    });
  }

  async listTokens(externalId: string): Promise<BrowserToken[]> {
    const account = requireAccount(await this.readState(), externalId);
    return account.tokens.map(publicToken);
  }

  async rotateToken(externalId: string, tokenId: string): Promise<{ token: BrowserToken; secret: string }> {
    return this.mutate((state) => {
      const account = requireAccount(state, externalId);
      const token = account.tokens.find((candidate) => candidate.id === tokenId);
      if (token === undefined || token.revokedAt !== undefined) throw notFound("Browser key not found.");
      const secret = makeSecret();
      const now = this.clock().toISOString();
      token.hash = hashSecret(secret);
      token.prefix = secret.slice(0, 12);
      token.rotatedAt = now;
      account.updatedAt = now;
      return { token: publicToken(token), secret };
    });
  }

  async revokeToken(externalId: string, tokenId: string): Promise<void> {
    await this.mutate((state) => {
      const account = requireAccount(state, externalId);
      const token = account.tokens.find((candidate) => candidate.id === tokenId);
      if (token === undefined || token.revokedAt !== undefined) throw notFound("Browser key not found.");
      const now = this.clock().toISOString();
      token.revokedAt = now;
      account.updatedAt = now;
    });
  }

  async authenticateToken(secret: string): Promise<TokenAuthentication | undefined> {
    if (!secret.startsWith("dlk_")) return undefined;
    const digest = hashSecret(secret);
    const state = await this.readState();
    for (const account of Object.values(state.accounts)) {
      for (const token of account.tokens) {
        if (token.revokedAt === undefined && safeEqualHex(digest, token.hash)) {
          return { accountId: account.id, externalId: account.externalId, tokenId: token.id, limits: { ...account.limits } };
        }
      }
    }
    return undefined;
  }

  async getUsage(externalId: string): Promise<AccountUsage> {
    const account = requireAccount(await this.readState(), externalId);
    const month = monthKey(this.clock());
    const usage = account.usage[month] ?? { requests: 0, succeeded: 0, failed: 0 };
    return { month, ...usage };
  }

  async getLogs(externalId: string, limit = Math.min(100, this.maxLogsPerAccount)): Promise<RequestLog[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > this.maxLogsPerAccount) {
      throw new AccountStoreError("invalid_request", `limit must be from 1 to ${this.maxLogsPerAccount}.`);
    }
    const account = requireAccount(await this.readState(), externalId);
    return account.logs.slice(0, limit).map((entry) => ({ ...entry }));
  }

  async recordRequest(externalId: string, log: RequestLog): Promise<void> {
    await this.mutate((state) => {
      const account = requireAccount(state, externalId);
      const month = log.startedAt.slice(0, 7);
      const usage = account.usage[month] ?? { requests: 0, succeeded: 0, failed: 0 };
      usage.requests += 1;
      if (log.status === "succeeded") usage.succeeded += 1;
      else usage.failed += 1;
      account.usage[month] = usage;
      account.logs.unshift({ ...log });
      account.logs.length = Math.min(account.logs.length, this.maxLogsPerAccount);
      const token = account.tokens.find((candidate) => candidate.id === log.tokenId);
      if (token !== undefined) token.lastUsedAt = log.completedAt;
      account.updatedAt = log.completedAt;
    });
  }

  private async readState(): Promise<StoreState> {
    await this.mutation;
    if (this.state !== undefined) return this.state;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as StoreState;
      if (parsed.version !== 1 || parsed.accounts === null || typeof parsed.accounts !== "object") {
        throw new Error("Unsupported account store format.");
      }
      this.state = parsed;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      this.state = { version: 1, accounts: {} };
    }
    return this.state;
  }

  private mutate<T>(change: (state: StoreState) => T): Promise<T> {
    const run = this.mutation.then(async () => {
      if (this.state === undefined) {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await chmod(this.directory, 0o700);
        try {
          const parsed = JSON.parse(await readFile(this.path, "utf8")) as StoreState;
          if (parsed.version !== 1 || parsed.accounts === null || typeof parsed.accounts !== "object") throw new Error("Unsupported account store format.");
          this.state = parsed;
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
          this.state = { version: 1, accounts: {} };
        }
      }
      const nextState = structuredClone(this.state);
      const result = change(nextState);
      await this.persist(nextState);
      this.state = nextState;
      return result;
    });
    this.mutation = run.then(() => undefined, () => undefined);
    return run;
  }

  private async persist(state: StoreState): Promise<void> {
    const temporary = join(this.directory, `.accounts-${process.pid}-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
  }
}

function publicAccount(account: StoredAccount): AccountSummary {
  const { id, externalId, name, createdAt, updatedAt, limits } = account;
  return { id, externalId, name, createdAt, updatedAt, limits: { ...limits } };
}

function publicToken(token: StoredToken): BrowserToken {
  const { id, name, prefix, createdAt, rotatedAt, revokedAt, lastUsedAt } = token;
  return { id, name, prefix, createdAt, ...(rotatedAt ? { rotatedAt } : {}), ...(revokedAt ? { revokedAt } : {}), ...(lastUsedAt ? { lastUsedAt } : {}) };
}

function requireAccount(state: StoreState, externalId: string): StoredAccount {
  validateExternalId(externalId);
  const account = state.accounts[externalId];
  if (account === undefined) throw notFound("Account not found.");
  return account;
}

function notFound(message: string): AccountStoreError {
  return new AccountStoreError("not_found", message);
}

function validateExternalId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) {
    throw new AccountStoreError("invalid_request", "externalId must contain 1-64 letters, digits, underscores, or hyphens.");
  }
}

function validateTokenName(value: string): void {
  if (typeof value !== "string" || value.trim() !== value || value.length < 1 || value.length > 80) {
    throw new AccountStoreError("invalid_request", "name must contain 1-80 characters without surrounding whitespace.");
  }
}

function validateEnsureInput(input: EnsureAccountInput): void {
  if (input.name !== undefined) validateTokenName(input.name);
  if (input.limits?.maxConcurrent !== undefined && (!Number.isInteger(input.limits.maxConcurrent) || input.limits.maxConcurrent < 1 || input.limits.maxConcurrent > 100)) {
    throw new AccountStoreError("invalid_request", "maxConcurrent must be an integer from 1 to 100.");
  }
  if (input.limits?.monthlyRequestQuota !== undefined && (!Number.isInteger(input.limits.monthlyRequestQuota) || input.limits.monthlyRequestQuota < 1 || input.limits.monthlyRequestQuota > 100_000_000)) {
    throw new AccountStoreError("invalid_request", "monthlyRequestQuota must be an integer from 1 to 100000000.");
  }
}

function makeSecret(): string {
  return `dlk_${randomBytes(32).toString("base64url")}`;
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function safeEqualHex(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}
