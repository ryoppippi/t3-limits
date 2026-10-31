import { isIP } from "node:net";
import { randomUUID } from "node:crypto";

export const USAGE_LIMIT_TIMEOUT_MS = 10_000;
const ORCHESTRATION_PROTOCOL_VERSION = "2";

interface WebSocketClientOptions {
  readonly headers: Readonly<Record<string, string>>;
}

type BunWebSocketConstructor = new (url: string, options: WebSocketClientOptions) => WebSocket;

export type UsageLimitWebSocketConstructor = BunWebSocketConstructor;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoopbackHostname(hostname: string): boolean {
  const unwrapped = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  const normalized = unwrapped.toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  if (isIP(unwrapped) === 6) return normalized === "::1";
  if (isIP(unwrapped) !== 4) return false;
  return Number(unwrapped.split(".")[0]) === 127;
}

export function isLoopbackUrl(origin: string): boolean {
  try {
    const url = new URL(origin);
    return isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

export function webSocketUrl(origin: string, requireLoopback = true): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("The T3 server URL is invalid.");
  }

  if (
    !["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error("The T3 server URL must be an origin without credentials, path, query, or fragment.");
  }
  if (requireLoopback && !isLoopbackHostname(url.hostname)) {
    throw new Error("The --url override must point to a loopback address.");
  }

  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.searchParams.set("orchestrationProtocol", ORCHESTRATION_PROTOCOL_VERSION);
  return url.toString();
}

function decodeFrame(data: unknown): Promise<unknown> {
  if (typeof data === "string") return Promise.resolve(JSON.parse(data) as unknown);
  if (data instanceof ArrayBuffer) return Promise.resolve(JSON.parse(new TextDecoder().decode(data)) as unknown);
  if (ArrayBuffer.isView(data)) {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return Promise.resolve(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
  }
  if (data instanceof Blob) return data.text().then((text) => JSON.parse(text) as unknown);
  return Promise.reject(new Error("Unsupported WebSocket frame."));
}

function eventSources(value: unknown): readonly unknown[] | undefined {
  if (!isRecord(value) || value.type !== "usageLimitSourcesUpdated") return undefined;
  if (!isRecord(value.payload) || !Array.isArray(value.payload.sources)) {
    throw new Error("T3 server sent invalid usage-limit source data.");
  }
  return value.payload.sources;
}

function eventProviders(value: unknown): readonly unknown[] | undefined {
  if (!isRecord(value) || value.type !== "snapshot") return undefined;
  if (!isRecord(value.config) || !Array.isArray(value.config.providers)) {
    throw new Error("T3 server sent an invalid usage-limits snapshot.");
  }
  return value.config.providers;
}

export async function readUsageLimitStreams(input: {
  readonly origin: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly pingIntervalMs?: number;
  readonly webSocketConstructor?: UsageLimitWebSocketConstructor;
}): Promise<{ readonly providers: readonly unknown[]; readonly sources: readonly unknown[] }> {
  const url = webSocketUrl(input.origin, true);
  const requestId = `t3-limits-${randomUUID()}`;
  const WebSocketClient = input.webSocketConstructor ?? WebSocket as unknown as BunWebSocketConstructor;

  return new Promise((resolve, reject) => {
    let settled = false;
    let providers: readonly unknown[] | undefined;
    let sources: readonly unknown[] | undefined;
    let messageQueue = Promise.resolve();
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    const timeout = setTimeout(() => fail("Timed out waiting for T3 usage limits."), input.timeoutMs ?? USAGE_LIMIT_TIMEOUT_MS);
    let socket: WebSocket;

    const cleanup = () => {
      clearTimeout(timeout);
      if (pingTimer !== undefined) clearInterval(pingTimer);
    };
    const closeSocket = () => {
      try {
        socket.close();
      } catch {
        // The socket may already have closed while the initial stream arrived.
      }
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      closeSocket();
      reject(new Error(message));
    };
    const finishIfReady = () => {
      if (settled || providers === undefined || sources === undefined) return;
      settled = true;
      cleanup();
      closeSocket();
      resolve({ providers, sources });
    };

    try {
      socket = new WebSocketClient(url, {
        headers: { Authorization: `Bearer ${input.token}` },
      });
    } catch {
      clearTimeout(timeout);
      reject(new Error("Could not open a WebSocket to the T3 server."));
      return;
    }

    socket.addEventListener("open", () => {
      try {
        socket.send(JSON.stringify({
          _tag: "Request",
          id: requestId,
          tag: "subscribeServerConfig",
          payload: { usageLimitSources: true, workspaceSnapshotsOnDemand: true },
          headers: [],
        }));
        pingTimer = setInterval(() => {
          if (settled || socket.readyState !== WebSocket.OPEN) return;
          try {
            socket.send(JSON.stringify({ _tag: "Ping" }));
          } catch {
            fail("The T3 server connection failed.");
          }
        }, input.pingIntervalMs ?? 5_000);
      } catch {
        fail("Could not subscribe to T3 usage limits.");
      }
    });

    socket.addEventListener("message", (event) => {
      messageQueue = messageQueue
        .then(() => decodeFrame(event.data))
        .then((decoded) => {
          const messages = Array.isArray(decoded) ? decoded : [decoded];
          for (const message of messages) {
            if (!isRecord(message)) continue;
            switch (message._tag) {
              case "Chunk": {
                if (message.requestId !== requestId) break;
                socket.send(JSON.stringify({ _tag: "Ack", requestId }));
                if (!Array.isArray(message.values)) break;
                for (const value of message.values) {
                  const nextProviders = eventProviders(value);
                  if (nextProviders !== undefined) providers = nextProviders;
                  const nextSources = eventSources(value);
                  if (nextSources !== undefined) sources = nextSources;
                }
                finishIfReady();
                break;
              }
              case "Exit":
                if (message.requestId === requestId) {
                  fail("T3 usage-limit subscription ended before the initial data arrived.");
                }
                break;
              case "Defect":
                fail("T3 usage-limit subscription failed.");
                break;
              case "Pong":
              case "Ping":
                break;
              default:
                break;
            }
          }
        })
        .catch((error: unknown) => {
          fail(error instanceof Error && error.message.startsWith("T3 server sent ")
            ? error.message
            : "Could not read the T3 usage-limit stream.");
        });
    });

    socket.addEventListener("error", () => fail("Could not connect to the T3 server."));
    socket.addEventListener("close", () => {
      if (!settled) fail("The T3 server closed the connection before the initial data arrived.");
    });
  });
}
