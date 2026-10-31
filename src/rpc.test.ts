import { describe, expect, it } from "bun:test";
import * as Effect from "effect/Effect";

import {
  readUsageLimitStreams,
  webSocketUrl,
  type UsageLimitWebSocketConstructor,
} from "./rpc.ts";

type MockEvent = { readonly data?: unknown };
type MockListener = (event: MockEvent) => void;
type MockHandler = (socket: MockWebSocket, frame: unknown) => void;

function parseMessage(message: string): unknown {
  return JSON.parse(message) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class MockWebSocket {
  static readonly OPEN = 1;

  readonly sent: Record<string, unknown>[] = [];
  readyState = 0;
  private readonly listeners = new Map<string, Set<MockListener>>();

  constructor(
    readonly url: string,
    readonly options: { readonly headers: Readonly<Record<string, string>> },
    private readonly onClientFrame: MockHandler,
  ) {
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN;
      this.emit("open", {});
    });
  }

  addEventListener(type: string, listener: MockListener): void {
    const listeners = this.listeners.get(type) ?? new Set<MockListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string): void {
    const decoded = parseMessage(data);
    const frames = Array.isArray(decoded) ? decoded : [decoded];
    for (const frame of frames) {
      if (!isRecord(frame)) continue;
      this.sent.push(frame);
      this.onClientFrame(this, frame);
    }
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  serverMessage(message: unknown): void {
    if (this.readyState !== MockWebSocket.OPEN) return;
    this.emit("message", { data: JSON.stringify(message) });
  }

  serverRawMessage(message: string): void {
    if (this.readyState !== MockWebSocket.OPEN) return;
    this.emit("message", { data: message });
  }

  private emit(type: string, event: MockEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function mockConstructor(
  onClientFrame: MockHandler,
  sockets: MockWebSocket[],
): UsageLimitWebSocketConstructor {
  class TrackedMockWebSocket extends MockWebSocket {
    constructor(url: string, options: { readonly headers: Readonly<Record<string, string>> }) {
      super(url, options, onClientFrame);
      sockets.push(this);
    }
  }
  return TrackedMockWebSocket as unknown as UsageLimitWebSocketConstructor;
}

describe("T3 usage-limit WebSocket protocol", () => {
  it("subscribes once, acknowledges each chunk, handles Ping/Pong, and waits for both initial events", async () => {
    const sockets: MockWebSocket[] = [];
    let requestId: string | number | undefined;
    let ackCount = 0;
    let resolveAcks: (() => void) | undefined;
    const twoAcks = new Promise<void>((resolve) => {
      resolveAcks = resolve;
    });
    const webSocketConstructor = mockConstructor((socket, frame) => {
      if (!isRecord(frame)) return;
      if (frame._tag === "Request") {
        if (typeof frame.id !== "string" && typeof frame.id !== "number") return;
        requestId = frame.id;
        socket.serverMessage({
          _tag: "Chunk",
          requestId,
          values: [
            {
              version: 1,
              type: "usageLimitSourcesUpdated",
              payload: { sources: [{ id: "source-one", label: "Hub", accounts: [] }] },
            },
          ],
        });
      } else if (frame._tag === "Ping") {
        socket.serverMessage([
          { _tag: "Pong" },
          {
            _tag: "Chunk",
            requestId,
            values: [
              {
                version: 1,
                type: "snapshot",
                config: { providers: [{ instanceId: "claude", driver: "claude" }] },
              },
            ],
          },
        ]);
      } else if (frame._tag === "Ack") {
        ackCount += 1;
        if (ackCount === 2) resolveAcks?.();
      }
    }, sockets);

    const response = await Effect.runPromise(readUsageLimitStreams({
      origin: "http://127.0.0.1:8318",
      token: "test-token",
      timeoutMs: 1_000,
      pingIntervalMs: 10,
      webSocketConstructor,
    }));
    await twoAcks;

    expect(response.providers).toEqual([{ instanceId: "claude", driver: "claude" }]);
    expect(response.sources).toEqual([{ id: "source-one", label: "Hub", accounts: [] }]);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.url).toBe("ws://127.0.0.1:8318/ws?orchestrationProtocol=2");
    expect(sockets[0]?.options.headers).toEqual({ Authorization: "Bearer test-token" });
    const requests = sockets[0]?.sent.filter((frame) => frame._tag === "Request") ?? [];
    expect(requests).toEqual([
      {
        _tag: "Request",
        id: requestId,
        tag: "subscribeServerConfig",
        payload: { usageLimitSources: true, workspaceSnapshotsOnDemand: true },
        headers: [],
      },
    ]);
    expect(sockets[0]?.sent.filter((frame) => frame._tag === "Ack")).toHaveLength(2);
    expect(sockets[0]?.sent.some((frame) => frame._tag === "Ping")).toBe(true);
    expect(sockets[0]?.sent.some((frame) => frame._tag === "Pong")).toBe(false);
  });

  it("decodes a batched server frame and sanitises an RPC failure", async () => {
    const sockets: MockWebSocket[] = [];
    const webSocketConstructor = mockConstructor((socket, frame) => {
      if (!isRecord(frame)) return;
      if (frame._tag !== "Request" || (typeof frame.id !== "string" && typeof frame.id !== "number")) return;
      socket.serverMessage([
        {
          _tag: "Chunk",
          requestId: frame.id,
          values: [{ version: 1, type: "snapshot", config: { providers: [] } }],
        },
        {
          _tag: "Chunk",
          requestId: frame.id,
          values: [{ version: 1, type: "usageLimitSourcesUpdated", payload: { sources: [] } }],
        },
      ]);
    }, sockets);

    const response = await Effect.runPromise(readUsageLimitStreams({
      origin: "http://127.0.0.1:8318",
      token: "test-token",
      timeoutMs: 100,
      webSocketConstructor,
    }));
    expect(response).toEqual({ providers: [], sources: [] });
    expect(sockets[0]?.sent.filter((frame) => frame._tag === "Ack")).toHaveLength(2);

    const failedConstructor = mockConstructor((socket, frame) => {
      if (!isRecord(frame)) return;
      if (frame._tag === "Request" && (typeof frame.id === "string" || typeof frame.id === "number")) {
        socket.serverMessage({
          _tag: "Exit",
          requestId: frame.id,
          exit: {
            _tag: "Failure",
            cause: [{ _tag: "Fail", error: { message: "private provider token=do-not-print" } }],
          },
        });
      }
    }, []);
    const failure = Effect.runPromise(readUsageLimitStreams({
      origin: "http://127.0.0.1:8318",
      token: "test-token",
      timeoutMs: 100,
      webSocketConstructor: failedConstructor,
    }));
    await expect(failure).rejects.toThrow("subscription ended before the initial data arrived");
    const error = await failure.catch((reason: unknown) => reason);
    expect(error).toMatchObject({ _tag: "RpcFailure" });
    expect(String(error)).not.toContain("do-not-print");

    const malformedConstructor = mockConstructor((socket, frame) => {
      if (!isRecord(frame)) return;
      if (frame._tag === "Request") socket.serverRawMessage("not-valid-json token=do-not-print");
    }, []);
    const malformed = Effect.runPromise(readUsageLimitStreams({
      origin: "http://127.0.0.1:8318",
      token: "test-token",
      timeoutMs: 100,
      webSocketConstructor: malformedConstructor,
    }));
    await expect(malformed).rejects.toThrow("Could not read the T3 usage-limit stream.");
    const malformedError = await malformed.catch((reason: unknown) => reason);
    expect(String(malformedError)).not.toContain("do-not-print");
  });

  it("rejects remote and credential-bearing origins and bounds waiting for initial sources", async () => {
    expect(() => Effect.runSync(webSocketUrl("https://example.com"))).toThrow("loopback address");
    expect(() => Effect.runSync(webSocketUrl("http://user:pass@127.0.0.1:8318"))).toThrow("without credentials");
    expect(() => Effect.runSync(webSocketUrl("http://127.0.0.1:8318/path"))).toThrow("without credentials");

    const sockets: MockWebSocket[] = [];
    const webSocketConstructor = mockConstructor(() => undefined, sockets);
    await expect(Effect.runPromise(readUsageLimitStreams({
      origin: "http://127.0.0.1:8318",
      token: "test-token",
      timeoutMs: 20,
      pingIntervalMs: 1_000,
      webSocketConstructor,
    }))).rejects.toThrow("Timed out waiting for T3 usage limits.");
  });
});
