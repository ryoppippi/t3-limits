import { afterEach, describe, expect, it } from "bun:test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { Predicate } from "effect";

import { readUsageLimitStreams, webSocketUrl } from "./rpc.ts";

type Frame = Readonly<Record<string, unknown>>;

interface FixtureSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

interface Fixture {
  readonly origin: string;
  readonly frames: Frame[];
  readonly closes: number[];
  readonly upgrades: { readonly url: string; readonly auth: string | null }[];
  readonly closed: Promise<number>;
}

const servers: { stop(force: boolean): void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function serve(
  onFrame: (socket: FixtureSocket, frame: Frame) => void,
  options: { readonly beforeUpgrade?: Promise<void> } = {},
): Fixture {
  const frames: Frame[] = [];
  const closes: number[] = [];
  const upgrades: Fixture["upgrades"] = [];
  let resolveClosed: (code: number) => void = () => undefined;
  const closed = new Promise<number>((resolve) => {
    resolveClosed = resolve;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      upgrades.push({
        url: request.url,
        auth: request.headers.get("authorization"),
      });
      await options.beforeUpgrade;
      if (server.upgrade(request)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      message(socket, data) {
        const decoded: unknown = JSON.parse(String(data));
        for (const frame of Array.isArray(decoded) ? decoded : [decoded]) {
          if (!Predicate.isObject(frame)) continue;
          frames.push(frame as Frame);
          onFrame(socket, frame as Frame);
        }
      },
      close(_socket, code) {
        closes.push(code);
        resolveClosed(code);
      },
    },
  });
  servers.push(server);
  return {
    origin: `http://127.0.0.1:${server.port}`,
    frames,
    closes,
    upgrades,
    closed,
  };
}

const snapshot = (providers: unknown[]) => ({
  version: 1,
  type: "snapshot",
  config: { providers },
});
const sourcesUpdated = (sources: unknown[]) => ({
  version: 1,
  type: "usageLimitSourcesUpdated",
  payload: { sources },
});
const chunk = (requestId: unknown, values: unknown[]) => ({
  _tag: "Chunk",
  requestId,
  values,
});

function onRequest(
  respond: (socket: FixtureSocket, requestId: unknown) => void,
): (socket: FixtureSocket, frame: Frame) => void {
  return (socket, frame) => {
    if (frame._tag === "Request") respond(socket, frame.id);
  };
}

function read(fixture: Fixture, timeoutMs = 1_000) {
  return Effect.runPromise(
    readUsageLimitStreams({
      origin: fixture.origin,
      token: "synthetic-test-token",
      timeoutMs,
    }),
  );
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the read to fail");
    },
    (reason: unknown) => reason,
  );
}

function expectRedacted(error: unknown, sentinel: string): void {
  expect(error).toMatchObject({ _tag: "RpcFailure" });
  expect(String(error)).not.toContain(sentinel);
  expect(JSON.stringify(error)).not.toContain(sentinel);
  expect(
    JSON.stringify(Predicate.isObject(error) ? error.cause : undefined) ?? "",
  ).not.toContain(sentinel);
}

const tags = (fixture: Fixture) => fixture.frames.map((frame) => frame._tag);

describe("T3 usage-limit RPC client", () => {
  it("subscribes once, acknowledges each chunk, and waits for both initial events in any order", async () => {
    const fixture = serve((socket, frame) => {
      if (frame._tag === "Request") {
        socket.send(JSON.stringify({ _tag: "Pong" }));
        socket.send(
          JSON.stringify(
            chunk(frame.id, [
              sourcesUpdated([{ id: "source-one", label: "Hub" }]),
            ]),
          ),
        );
      } else if (frame._tag === "Ack" && tags(fixture).length === 2) {
        socket.send(
          JSON.stringify(
            chunk(frame.requestId, [
              snapshot([{ instanceId: "claude", driver: "claude" }]),
            ]),
          ),
        );
      }
    });

    await expect(read(fixture)).resolves.toEqual({
      providers: [{ instanceId: "claude", driver: "claude" }],
      sources: [{ id: "source-one", label: "Hub" }],
    });
    expect(await fixture.closed).toBe(1000);

    const [request] = fixture.frames;
    expect(fixture.upgrades).toHaveLength(1);
    expect(request).toEqual({
      _tag: "Request",
      id: request?.id,
      tag: "subscribeServerConfig",
      payload: { usageLimitSources: true, workspaceSnapshotsOnDemand: true },
      headers: [],
    });
    expect(tags(fixture)).toEqual(["Request", "Ack", "Ack", "Interrupt"]);
    expect(fixture.frames[1]).toEqual({ _tag: "Ack", requestId: request?.id });
    expect(fixture.frames[3]).toMatchObject({ requestId: request?.id });
  });

  it("returns complete data before later frames in the same batch", async () => {
    const sentinel = "rpc-defect-secret-token-sentinel";
    const fixture = serve(
      onRequest((socket, requestId) =>
        socket.send(
          JSON.stringify([
            chunk(requestId, [snapshot([])]),
            chunk(requestId, [sourcesUpdated([])]),
            { _tag: "Exit", requestId, exit: { _tag: "Success", value: null } },
            { _tag: "Defect", defect: sentinel },
          ]),
        ),
      ),
    );

    await expect(read(fixture)).resolves.toEqual({
      providers: [],
      sources: [],
    });
  });

  it("decodes binary frames and ignores other subscriptions and unknown events", async () => {
    const fixture = serve(
      onRequest((socket, requestId) => {
        socket.send(
          JSON.stringify([
            chunk("other", [snapshot(["wrong"])]),
            { _tag: "Exit", requestId: "other" },
            { _tag: "Unknown" },
            chunk(requestId, [42, { type: "unrelated" }]),
          ]),
        );
        socket.send(
          new TextEncoder().encode(
            JSON.stringify(chunk(requestId, [snapshot(["binary"])])),
          ),
        );
        socket.send(
          JSON.stringify(chunk(requestId, [sourcesUpdated(["text"])])),
        );
      }),
    );

    await expect(read(fixture)).resolves.toEqual({
      providers: ["binary"],
      sources: ["text"],
    });
  });

  it("rejects invalid known events with a specific message", async () => {
    const invalidSnapshot = serve(
      onRequest((socket, requestId) =>
        socket.send(
          JSON.stringify(chunk(requestId, [{ type: "snapshot", config: {} }])),
        ),
      ),
    );
    await expect(read(invalidSnapshot)).rejects.toThrow(
      "T3 server sent an invalid usage-limits snapshot.",
    );

    const invalidSources = serve(
      onRequest((socket, requestId) =>
        socket.send(
          JSON.stringify(
            chunk(requestId, [
              { type: "usageLimitSourcesUpdated", payload: {} },
            ]),
          ),
        ),
      ),
    );
    await expect(read(invalidSources)).rejects.toThrow(
      "T3 server sent invalid usage-limit source data.",
    );
  });

  it("redacts server failures, defects, malformed frames, and close reasons", async () => {
    const sentinel = "private provider token=do-not-print";
    const cases = [
      {
        message: "T3 usage-limit subscription failed.",
        respond: (socket: FixtureSocket, requestId: unknown) =>
          socket.send(
            JSON.stringify({
              _tag: "Exit",
              requestId,
              exit: {
                _tag: "Failure",
                cause: [
                  {
                    _tag: "Fail",
                    error: { _tag: "AuthError", message: sentinel },
                  },
                ],
              },
            }),
          ),
      },
      {
        message: "T3 usage-limit subscription failed.",
        respond: (socket: FixtureSocket) =>
          socket.send(JSON.stringify({ _tag: "Defect", defect: sentinel })),
      },
      {
        message: "Could not read the T3 usage-limit stream.",
        respond: (socket: FixtureSocket) =>
          socket.send(`not-valid-json ${sentinel}`),
      },
      {
        message:
          "The T3 server closed the connection before the initial data arrived.",
        respond: (socket: FixtureSocket) => socket.close(1011, sentinel),
      },
    ];

    for (const { message, respond } of cases) {
      const error = await failure(read(serve(onRequest(respond))));
      expect(String(error)).toContain(message);
      expectRedacted(error, sentinel);
    }
  });

  it("fails when the subscription ends before both initial events", async () => {
    const fixture = serve(
      onRequest((socket, requestId) =>
        socket.send(
          JSON.stringify([
            chunk(requestId, [snapshot([])]),
            { _tag: "Exit", requestId, exit: { _tag: "Success", value: null } },
          ]),
        ),
      ),
    );

    await expect(read(fixture)).rejects.toThrow(
      "T3 usage-limit subscription ended before the initial data arrived.",
    );
  });

  it("does not reconnect after the server drops the connection", async () => {
    const fixture = serve(onRequest((socket) => socket.close(1011)));

    await expect(read(fixture, 2_000)).rejects.toThrow(
      "The T3 server closed the connection",
    );
    await Bun.sleep(700);
    expect(fixture.upgrades).toHaveLength(1);
  });

  it("does not retry a rejected WebSocket upgrade", async () => {
    let attempts = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        attempts += 1;
        return new Response("upgrade-secret-token-sentinel", { status: 401 });
      },
    });
    servers.push(server);

    const error = await failure(
      Effect.runPromise(
        readUsageLimitStreams({
          origin: `http://127.0.0.1:${server.port}`,
          token: "synthetic-test-token",
          timeoutMs: 2_000,
        }),
      ),
    );
    expect(String(error)).toContain("Could not connect to the T3 server.");
    expectRedacted(error, "upgrade-secret-token-sentinel");
    await Bun.sleep(700);
    expect(attempts).toBe(1);
  });

  it("times out a silent subscription and closes the socket", async () => {
    const fixture = serve(() => undefined);

    await expect(read(fixture, 100)).rejects.toThrow(
      "Timed out waiting for T3 usage limits.",
    );
    expect(await fixture.closed).toBe(1000);
    expect(tags(fixture)).toEqual(["Request", "Interrupt"]);
  });

  it("cancels before the socket opens without subscribing", async () => {
    let release: () => void = () => undefined;
    const beforeUpgrade = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = serve(() => undefined, { beforeUpgrade });
    const fiber = Effect.runFork(
      readUsageLimitStreams({
        origin: fixture.origin,
        token: "synthetic-test-token",
        timeoutMs: 1_000,
      }),
    );

    while (fixture.upgrades.length === 0) await Bun.sleep(5);
    await Effect.runPromise(Fiber.interrupt(fiber));
    release();
    await Bun.sleep(50);

    expect(fixture.frames).toEqual([]);
  });

  it("rejects remote and credential-bearing origins before connecting", () => {
    expect(() => Effect.runSync(webSocketUrl("https://example.com"))).toThrow(
      "loopback address",
    );
    expect(() =>
      Effect.runSync(webSocketUrl("http://user:pass@127.0.0.1:8318")),
    ).toThrow("without credentials");
    expect(() =>
      Effect.runSync(webSocketUrl("http://127.0.0.1:8318/path")),
    ).toThrow("without credentials");
    expect(Effect.runSync(webSocketUrl("https://localhost:8318"))).toBe(
      "wss://localhost:8318/ws?orchestrationProtocol=2",
    );
  });
});
