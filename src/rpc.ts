import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { RpcFailure } from "./errors.ts";

export const USAGE_LIMIT_TIMEOUT_MS = 10_000;
const ORCHESTRATION_PROTOCOL_VERSION = "2";

const RPC_MESSAGES = {
  invalidUrl: "The T3 server URL is invalid.",
  invalidOrigin:
    "The T3 server URL must be an origin without credentials, path, query, or fragment.",
  loopback: "The --url override must point to a loopback address.",
  timeout: "Timed out waiting for T3 usage limits.",
  open: "Could not open a WebSocket to the T3 server.",
  connect: "Could not connect to the T3 server.",
  subscribe: "Could not subscribe to T3 usage limits.",
  connection: "The T3 server connection failed.",
  closed:
    "The T3 server closed the connection before the initial data arrived.",
  ended: "T3 usage-limit subscription ended before the initial data arrived.",
  failed: "T3 usage-limit subscription failed.",
  read: "Could not read the T3 usage-limit stream.",
  sources: "T3 server sent invalid usage-limit source data.",
  snapshot: "T3 server sent an invalid usage-limits snapshot.",
} as const satisfies Record<string, string>;

interface WebSocketClientOptions {
  readonly headers: Readonly<Record<string, string>>;
}

type BunWebSocketConstructor = new (
  url: string,
  options: WebSocketClientOptions,
) => WebSocket;

export type UsageLimitWebSocketConstructor = BunWebSocketConstructor;

const ServerFrameSchema = Schema.Struct({
  _tag: Schema.String,
  requestId: Schema.optional(Schema.Unknown),
  values: Schema.optional(Schema.Unknown),
  exit: Schema.optional(Schema.Unknown),
});

const SnapshotEventSchema = Schema.Struct({
  type: Schema.Literal("snapshot"),
  config: Schema.Struct({ providers: Schema.Array(Schema.Unknown) }),
});

const SourcesEventSchema = Schema.Struct({
  type: Schema.Literal("usageLimitSourcesUpdated"),
  payload: Schema.Struct({ sources: Schema.Array(Schema.Unknown) }),
});

function isLoopbackHostname(hostname: string): boolean {
  const unwrapped =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  const normalized = unwrapped.toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost"))
    return true;
  if (isIP(unwrapped) === 6) return normalized === "::1";
  if (isIP(unwrapped) !== 4) return false;
  return Number(unwrapped.split(".")[0]) === 127;
}

export function isLoopbackUrl(origin: string): boolean {
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function makeWebSocketUrl(
  origin: string,
  requireLoopback: boolean,
): string | RpcFailure {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return new RpcFailure({ safeMessage: RPC_MESSAGES.invalidUrl });
  }

  if (
    !["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    return new RpcFailure({ safeMessage: RPC_MESSAGES.invalidOrigin });
  }
  if (requireLoopback && !isLoopbackHostname(url.hostname)) {
    return new RpcFailure({ safeMessage: RPC_MESSAGES.loopback });
  }

  url.protocol =
    url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.searchParams.set("orchestrationProtocol", ORCHESTRATION_PROTOCOL_VERSION);
  return url.toString();
}

export function webSocketUrl(
  origin: string,
  requireLoopback = true,
): Effect.Effect<string, RpcFailure> {
  const result = makeWebSocketUrl(origin, requireLoopback);
  return result instanceof RpcFailure
    ? Effect.fail(result)
    : Effect.succeed(result);
}

export function canonicalLoopbackOrigin(
  origin: string,
): Effect.Effect<string, RpcFailure> {
  return Effect.map(webSocketUrl(origin, true), (value) => {
    const socketUrl = new URL(value);
    socketUrl.protocol = socketUrl.protocol === "wss:" ? "https:" : "http:";
    socketUrl.pathname = "/";
    socketUrl.search = "";
    return socketUrl.origin;
  });
}

function decodeFrame(data: unknown): Effect.Effect<unknown, RpcFailure> {
  return Effect.tryPromise({
    try: async () => {
      let text: string;
      if (typeof data === "string") text = data;
      else if (data instanceof ArrayBuffer)
        text = new TextDecoder().decode(data);
      else if (ArrayBuffer.isView(data)) {
        text = new TextDecoder().decode(
          new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        );
      } else if (data instanceof Blob) text = await data.text();
      else throw new Error("frame");
      return JSON.parse(text) as unknown;
    },
    catch: () => new RpcFailure({ safeMessage: RPC_MESSAGES.read }),
  });
}

function isSome<A>(option: Option.Option<A>): option is Option.Some<A> {
  return Option.isSome(option);
}

function decodeEvent<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S["Type"] | undefined {
  const result = Schema.decodeUnknownOption(schema)(value);
  return isSome(result) ? result.value : undefined;
}

export interface UsageLimitStreams {
  readonly providers: readonly unknown[];
  readonly sources: readonly unknown[];
}

export function readUsageLimitStreams(input: {
  readonly origin: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly pingIntervalMs?: number;
  readonly webSocketConstructor?: UsageLimitWebSocketConstructor;
}): Effect.Effect<UsageLimitStreams, RpcFailure> {
  return Effect.gen(function* () {
    const url = yield* webSocketUrl(input.origin, true);
    const requestId = `t3-limits-${randomUUID()}`;
    const WebSocketClient =
      input.webSocketConstructor ??
      (WebSocket as unknown as BunWebSocketConstructor);

    return yield* Effect.callback<UsageLimitStreams, RpcFailure>(
      (resume, signal) => {
        let settled = false;
        let providers: readonly unknown[] | undefined;
        let sources: readonly unknown[] | undefined;
        let messageQueue = Promise.resolve();
        let pingTimer: ReturnType<typeof setInterval> | undefined;
        let socket: WebSocket | undefined;
        const timeout = setTimeout(
          () => fail(RPC_MESSAGES.timeout),
          input.timeoutMs ?? USAGE_LIMIT_TIMEOUT_MS,
        );

        const cleanup = () => {
          clearTimeout(timeout);
          if (pingTimer !== undefined) clearInterval(pingTimer);
        };
        const closeSocket = () => {
          if (socket === undefined) return;
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
          resume(Effect.fail(new RpcFailure({ safeMessage: message })));
        };
        const finishIfReady = () => {
          if (settled || providers === undefined || sources === undefined)
            return;
          settled = true;
          cleanup();
          closeSocket();
          resume(Effect.succeed({ providers, sources }));
        };

        try {
          socket = new WebSocketClient(url, {
            headers: { Authorization: `Bearer ${input.token}` },
          });
        } catch {
          fail(RPC_MESSAGES.open);
          return Effect.sync(cleanup);
        }

        socket.addEventListener("open", () => {
          try {
            socket?.send(
              JSON.stringify({
                _tag: "Request",
                id: requestId,
                tag: "subscribeServerConfig",
                payload: {
                  usageLimitSources: true,
                  workspaceSnapshotsOnDemand: true,
                },
                headers: [],
              }),
            );
            pingTimer = setInterval(() => {
              if (settled || socket?.readyState !== WebSocket.OPEN) return;
              try {
                socket.send(JSON.stringify({ _tag: "Ping" }));
              } catch {
                fail(RPC_MESSAGES.connection);
              }
            }, input.pingIntervalMs ?? 5_000);
          } catch {
            fail(RPC_MESSAGES.subscribe);
          }
        });

        socket.addEventListener("message", (event) => {
          messageQueue = messageQueue
            .then(async () => {
              const decoded = await Effect.runPromise(decodeFrame(event.data));
              const messages = Array.isArray(decoded) ? decoded : [decoded];
              for (const rawMessage of messages) {
                const message = decodeEvent(ServerFrameSchema, rawMessage);
                if (message === undefined) {
                  fail(RPC_MESSAGES.read);
                  return;
                }
                switch (message._tag) {
                  case "Chunk": {
                    if (message.requestId !== requestId) break;
                    socket?.send(JSON.stringify({ _tag: "Ack", requestId }));
                    if (!Array.isArray(message.values)) break;
                    for (const value of message.values) {
                      if (
                        typeof value !== "object" ||
                        value === null ||
                        Array.isArray(value)
                      )
                        continue;
                      const eventType = Reflect.get(value, "type");
                      if (eventType === "snapshot") {
                        const snapshot = decodeEvent(
                          SnapshotEventSchema,
                          value,
                        );
                        if (snapshot === undefined) {
                          fail(RPC_MESSAGES.snapshot);
                          return;
                        }
                        providers = snapshot.config.providers;
                      } else if (eventType === "usageLimitSourcesUpdated") {
                        const sourceEvent = decodeEvent(
                          SourcesEventSchema,
                          value,
                        );
                        if (sourceEvent === undefined) {
                          fail(RPC_MESSAGES.sources);
                          return;
                        }
                        sources = sourceEvent.payload.sources;
                      }
                    }
                    finishIfReady();
                    break;
                  }
                  case "Exit":
                    if (message.requestId === requestId)
                      fail(RPC_MESSAGES.ended);
                    break;
                  case "Defect":
                    fail(RPC_MESSAGES.failed);
                    break;
                  case "Pong":
                  case "Ping":
                    break;
                  default:
                    break;
                }
              }
            })
            .catch(() => fail(RPC_MESSAGES.read));
        });

        socket.addEventListener("error", () => fail(RPC_MESSAGES.connect));
        socket.addEventListener("close", () => {
          if (!settled) fail(RPC_MESSAGES.closed);
        });
        signal.addEventListener(
          "abort",
          () => {
            if (settled) return;
            settled = true;
            cleanup();
            closeSocket();
          },
          { once: true },
        );

        return Effect.sync(() => {
          settled = true;
          cleanup();
          closeSocket();
        });
      },
    );
  });
}
