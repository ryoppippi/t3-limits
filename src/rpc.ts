import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

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

const EventHeaderSchema = Schema.Struct({ type: Schema.String });

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

export const webSocketUrl = Effect.fnUntraced(function* (
  origin: string,
  requireLoopback = true,
): Effect.fn.Return<string, RpcFailure> {
  const url = yield* Effect.try({
    try: () => new URL(origin),
    catch: () => new RpcFailure({ message: RPC_MESSAGES.invalidUrl }),
  });

  if (
    !["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    return yield* new RpcFailure({ message: RPC_MESSAGES.invalidOrigin });
  }
  if (requireLoopback && !isLoopbackHostname(url.hostname)) {
    return yield* new RpcFailure({ message: RPC_MESSAGES.loopback });
  }

  url.protocol =
    url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.searchParams.set("orchestrationProtocol", ORCHESTRATION_PROTOCOL_VERSION);
  return url.toString();
});

export const canonicalLoopbackOrigin = Effect.fnUntraced(function* (
  origin: string,
): Effect.fn.Return<string, RpcFailure> {
  const value = yield* webSocketUrl(origin, true);
  const socketUrl = new URL(value);
  socketUrl.protocol = socketUrl.protocol === "wss:" ? "https:" : "http:";
  socketUrl.pathname = "/";
  socketUrl.search = "";
  return socketUrl.origin;
});

function decodeFrame(data: unknown): Effect.Effect<unknown, RpcFailure> {
  const text =
    typeof data === "string"
      ? Effect.succeed(data)
      : data instanceof ArrayBuffer
        ? Effect.succeed(new TextDecoder().decode(data))
        : ArrayBuffer.isView(data)
          ? Effect.succeed(
              new TextDecoder().decode(
                new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
              ),
            )
          : data instanceof Blob
            ? Effect.tryPromise({
                try: () => data.text(),
                catch: () => new RpcFailure({ message: RPC_MESSAGES.read }),
              })
            : Effect.fail(new RpcFailure({ message: RPC_MESSAGES.read }));
  return Effect.flatMap(text, (value) =>
    Effect.mapError(
      Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(value),
      () => new RpcFailure({ message: RPC_MESSAGES.read }),
    ),
  );
}

export interface UsageLimitStreams {
  readonly providers: readonly unknown[];
  readonly sources: readonly unknown[];
}

type SocketEvent =
  | { readonly _tag: "Open"; readonly socket: WebSocket }
  | {
      readonly _tag: "Message";
      readonly socket: WebSocket;
      readonly data: unknown;
    }
  | { readonly _tag: "Error"; readonly socket: WebSocket }
  | { readonly _tag: "Close"; readonly socket: WebSocket }
  | {
      readonly _tag: "HeartbeatFailure";
      readonly socket: WebSocket;
      readonly failure: RpcFailure;
    };

function socketEvents(input: {
  readonly url: string;
  readonly token: string;
  readonly webSocketConstructor: UsageLimitWebSocketConstructor;
  readonly pingIntervalMs: number;
}): Stream.Stream<SocketEvent, RpcFailure> {
  return Stream.callback<SocketEvent, RpcFailure>(
    Effect.fnUntraced(function* (queue) {
      const client = yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            const socket = new input.webSocketConstructor(input.url, {
              headers: { Authorization: `Bearer ${input.token}` },
            });
            const onOpen = () =>
              Queue.offerUnsafe(queue, { _tag: "Open", socket });
            const onMessage = (event: MessageEvent) =>
              Queue.offerUnsafe(queue, {
                _tag: "Message",
                socket,
                data: event.data,
              });
            const onError = () =>
              Queue.offerUnsafe(queue, { _tag: "Error", socket });
            const onClose = () =>
              Queue.offerUnsafe(queue, { _tag: "Close", socket });
            try {
              socket.addEventListener("open", onOpen);
              socket.addEventListener("message", onMessage);
              socket.addEventListener("error", onError);
              socket.addEventListener("close", onClose);
            } catch (cause) {
              socket.removeEventListener("open", onOpen);
              socket.removeEventListener("message", onMessage);
              socket.removeEventListener("error", onError);
              socket.removeEventListener("close", onClose);
              try {
                socket.close();
              } catch {
                // Preserve the registration failure for Effect.try.
              }
              throw cause;
            }
            return { socket, onOpen, onMessage, onError, onClose };
          },
          catch: () => new RpcFailure({ message: RPC_MESSAGES.open }),
        }),
        (resource) =>
          Effect.sync(() => {
            resource.socket.removeEventListener("open", resource.onOpen);
            resource.socket.removeEventListener("message", resource.onMessage);
            resource.socket.removeEventListener("error", resource.onError);
            resource.socket.removeEventListener("close", resource.onClose);
            try {
              resource.socket.close();
            } catch {
              // The socket may already be closed when the stream scope ends.
            }
          }),
      );
      const { socket } = client;

      yield* Effect.forever(
        Effect.sleep(input.pingIntervalMs).pipe(
          Effect.andThen(
            Effect.try({
              try: () => {
                if (socket.readyState === WebSocket.OPEN)
                  socket.send(JSON.stringify({ _tag: "Ping" }));
              },
              catch: () => new RpcFailure({ message: RPC_MESSAGES.connection }),
            }),
          ),
        ),
      ).pipe(
        Effect.catch((failure) =>
          Effect.sync(() =>
            Queue.offerUnsafe(queue, {
              _tag: "HeartbeatFailure",
              socket,
              failure,
            }),
          ),
        ),
        Effect.forkScoped,
      );
    }),
  );
}

export const readUsageLimitStreams = Effect.fnUntraced(function* (input: {
  readonly origin: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly pingIntervalMs?: number;
  readonly webSocketConstructor?: UsageLimitWebSocketConstructor;
}): Effect.fn.Return<UsageLimitStreams, RpcFailure> {
  const url = yield* webSocketUrl(input.origin, true);
  const requestId = `t3-limits-${randomUUID()}`;
  const WebSocketClient =
    input.webSocketConstructor ??
    (WebSocket as unknown as BunWebSocketConstructor);
  type InitialState = {
    readonly providers: Option.Option<readonly unknown[]>;
    readonly sources: Option.Option<readonly unknown[]>;
  };
  const complete = (state: InitialState): Option.Option<UsageLimitStreams> =>
    Option.isSome(state.providers) && Option.isSome(state.sources)
      ? Option.some({
          providers: state.providers.value,
          sources: state.sources.value,
        })
      : Option.none();

  const result = socketEvents({
    url,
    token: input.token,
    webSocketConstructor: WebSocketClient,
    pingIntervalMs: input.pingIntervalMs ?? 5_000,
  }).pipe(
    Stream.mapAccumEffect(
      (): InitialState => ({
        providers: Option.none(),
        sources: Option.none(),
      }),
      (state, event) =>
        Match.typeTags<SocketEvent>()({
          Open: (event) =>
            Effect.try({
              try: () => {
                event.socket.send(
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
              },
              catch: () => new RpcFailure({ message: RPC_MESSAGES.subscribe }),
            }).pipe(Effect.as([state, []] as const)),
          Message: (event) =>
            Effect.gen(function* () {
              const decoded = yield* decodeFrame(event.data);
              const messages = Array.isArray(decoded) ? decoded : [decoded];
              let next = state;
              for (const rawMessage of messages) {
                const message = yield* Effect.mapError(
                  Schema.decodeUnknownEffect(ServerFrameSchema)(rawMessage),
                  () => new RpcFailure({ message: RPC_MESSAGES.read }),
                );

                switch (message._tag) {
                  case "Chunk": {
                    if (message.requestId !== requestId) break;
                    yield* Effect.try({
                      try: () =>
                        event.socket.send(
                          JSON.stringify({ _tag: "Ack", requestId }),
                        ),
                      catch: () =>
                        new RpcFailure({ message: RPC_MESSAGES.connection }),
                    });
                    if (!Array.isArray(message.values)) break;
                    for (const value of message.values) {
                      const header = Option.getOrUndefined(
                        Schema.decodeUnknownOption(EventHeaderSchema)(value),
                      );
                      if (header?.type === "snapshot") {
                        const snapshot = yield* Effect.mapError(
                          Schema.decodeUnknownEffect(SnapshotEventSchema)(
                            value,
                          ),
                          () =>
                            new RpcFailure({ message: RPC_MESSAGES.snapshot }),
                        );
                        next = {
                          ...next,
                          providers: Option.some(snapshot.config.providers),
                        };
                      } else if (header?.type === "usageLimitSourcesUpdated") {
                        const sourceEvent = yield* Effect.mapError(
                          Schema.decodeUnknownEffect(SourcesEventSchema)(value),
                          () =>
                            new RpcFailure({ message: RPC_MESSAGES.sources }),
                        );
                        next = {
                          ...next,
                          sources: Option.some(sourceEvent.payload.sources),
                        };
                      }
                      const initialData = complete(next);
                      if (Option.isSome(initialData))
                        return [next, [initialData.value]] as const;
                    }
                    break;
                  }
                  case "Exit":
                    if (message.requestId === requestId)
                      return yield* new RpcFailure({
                        message: RPC_MESSAGES.ended,
                      });
                    break;
                  case "Defect":
                    return yield* new RpcFailure({
                      message: RPC_MESSAGES.failed,
                    });
                  case "Pong":
                  case "Ping":
                    break;
                  default:
                    break;
                }
                const initialData = complete(next);
                if (Option.isSome(initialData))
                  return [next, [initialData.value]] as const;
              }
              return [next, []] as const;
            }),
          Error: () =>
            Effect.fail(new RpcFailure({ message: RPC_MESSAGES.connect })),
          Close: () =>
            Effect.fail(new RpcFailure({ message: RPC_MESSAGES.closed })),
          HeartbeatFailure: (event) => Effect.fail(event.failure),
        })(event),
    ),
    Stream.runHead,
    Effect.flatMap((response) =>
      Option.match(response, {
        onNone: () =>
          Effect.fail(new RpcFailure({ message: RPC_MESSAGES.ended })),
        onSome: Effect.succeed,
      }),
    ),
  );

  return yield* Effect.timeoutOrElse(result, {
    duration: input.timeoutMs ?? USAGE_LIMIT_TIMEOUT_MS,
    orElse: () =>
      Effect.fail(new RpcFailure({ message: RPC_MESSAGES.timeout })),
  });
});
