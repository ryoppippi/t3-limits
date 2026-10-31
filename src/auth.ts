import { webSocketUrl } from "./rpc.ts";

export const TOKEN_SERVICE = "com.ryoppippi.t3-limits";
export const TOKEN_SCOPE = "orchestration:read";
export const TOKEN_TTL = "1h";
export const TOKEN_LABEL = "t3-limits";
export const SESSION_ISSUE_TIMEOUT_MS = 15_000;
const MAX_TOKEN_OUTPUT_BYTES = 4096;

export interface SecretStore {
  get(options: { readonly service: string; readonly name: string }): Promise<string | null>;
  set(options: { readonly service: string; readonly name: string; readonly value: string }): Promise<void>;
  delete(options: { readonly service: string; readonly name: string }): Promise<boolean>;
}

export function canonicalSecretOrigin(origin: string): string {
  const socketUrl = new URL(webSocketUrl(origin, true));
  socketUrl.protocol = socketUrl.protocol === "wss:" ? "https:" : "http:";
  socketUrl.pathname = "/";
  socketUrl.search = "";
  return socketUrl.origin;
}

export async function readBearerToken(input: {
  readonly origin: string;
  readonly tokenFile?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly secrets: SecretStore;
  readonly readFile: (path: string) => Promise<string>;
  readonly onMissing?: (origin: string) => Promise<string>;
}): Promise<string> {
  let token: string | null | undefined;
  if (input.tokenFile !== undefined) {
    try {
      token = await input.readFile(input.tokenFile);
    } catch {
      throw new Error("The token file could not be read.");
    }
  } else if (input.env.T3_LIMITS_TOKEN !== undefined) {
    token = input.env.T3_LIMITS_TOKEN;
    if (token.trim().length === 0) throw new Error("T3_LIMITS_TOKEN is set but empty.");
  } else {
    const name = canonicalSecretOrigin(input.origin);
    try {
      token = await input.secrets.get({ service: TOKEN_SERVICE, name });
    } catch {
      throw new Error("Could not access the OS secret store. Use T3_LIMITS_TOKEN or --token-file, or enable the Bun 1.3+ OS secret backend (Linux: libsecret).");
    }
    if (token === null && input.onMissing !== undefined) token = await input.onMissing(input.origin);
  }

  const trimmed = token?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    throw new Error("Authentication required: run `t3-limits auth login`, set T3_LIMITS_TOKEN, or pass --token-file <path>.");
  }
  return trimmed;
}

export interface SessionIssueChild {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(signal?: "SIGKILL"): void;
}

export type SessionSpawn = (
  command: readonly string[],
  options: { readonly stdin: "ignore"; readonly stdout: "pipe"; readonly stderr: "ignore" },
) => SessionIssueChild;

export async function issueScopedToken(input: {
  readonly executable: string;
  readonly baseDir: string;
  readonly spawn: SessionSpawn;
  readonly timeoutMs?: number;
}): Promise<string> {
  let child: SessionIssueChild;
  try {
    child = input.spawn([
      input.executable,
      "auth", "session", "issue",
      "--base-dir", input.baseDir,
      "--scope", TOKEN_SCOPE,
      "--ttl", TOKEN_TTL,
      "--label", TOKEN_LABEL,
      "--token-only",
    ], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  } catch {
    throw new Error("Could not start the T3 CLI for scoped token issuance.");
  }

  let killed = false;
  const kill = () => {
    if (killed) return;
    killed = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // The child may already have exited.
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reader = child.stdout.getReader();
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    const output = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        size += value.byteLength;
        if (size > MAX_TOKEN_OUTPUT_BYTES) {
          kill();
          throw new Error("output-limit");
        }
        chunks.push(value);
      }
    })();
    const status = await Promise.race([
      Promise.all([output, child.exited]).then(([, exitCode]) => exitCode),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          kill();
          reject(new Error("timeout"));
        }, input.timeoutMs ?? SESSION_ISSUE_TIMEOUT_MS);
      }),
    ]);
    if (status !== 0) throw new Error("failed");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const token = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const trimmed = token.trim();
    if (trimmed.length === 0 || /\s|[\u0000-\u001f\u007f]/u.test(trimmed)) throw new Error("invalid-token");
    return trimmed;
  } catch {
    kill();
    void reader.cancel().catch(() => {});
    throw new Error("T3 scoped token issuance failed or timed out; no token was stored.");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function issueAndStoreScopedToken(input: {
  readonly origin: string;
  readonly executable: string;
  readonly baseDir: string;
  readonly secrets: SecretStore;
  readonly spawn: SessionSpawn;
}): Promise<string> {
  const token = await issueScopedToken(input);
  try {
    await input.secrets.set({
      service: TOKEN_SERVICE,
      name: canonicalSecretOrigin(input.origin),
      value: token,
    });
  } catch {
    throw new Error("Could not store the scoped token in the OS secret store. Ensure Bun 1.3+ and an available OS keychain (Linux: libsecret).");
  }
  return token;
}
