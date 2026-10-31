import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { readUsageLimitStreams } from "./rpc.ts";

test("uses Bun's real WebSocket transport with a bearer header and closes normally", async () => {
  const upgrades: { readonly url: string; readonly auth: string | null }[] = [];
  const received: unknown[] = [];
  let resolveClosed: (code: number) => void = () => undefined;
  const closed = new Promise<number>((resolve) => {
    resolveClosed = resolve;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      upgrades.push({
        url: new URL(request.url).pathname + new URL(request.url).search,
        auth: request.headers.get("authorization"),
      });
      if (server.upgrade(request)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      message(socket, data) {
        const frame = JSON.parse(String(data));
        received.push(frame._tag === "Request" ? frame.tag : frame._tag);
        if (frame._tag !== "Request") return;
        socket.send(
          JSON.stringify([
            {
              _tag: "Chunk",
              requestId: frame.id,
              values: [
                { version: 1, type: "snapshot", config: { providers: [] } },
              ],
            },
            {
              _tag: "Chunk",
              requestId: frame.id,
              values: [
                {
                  version: 1,
                  type: "usageLimitSourcesUpdated",
                  payload: { sources: [] },
                },
              ],
            },
          ]),
        );
      },
      close(_socket, code) {
        resolveClosed(code);
      },
    },
  });
  try {
    expect(
      await Effect.runPromise(
        readUsageLimitStreams({
          origin: `http://127.0.0.1:${server.port}`,
          token: "synthetic-test-token",
          timeoutMs: 1_000,
        }),
      ),
    ).toEqual({ providers: [], sources: [] });
    expect(await closed).toBe(1000);
    expect(upgrades).toEqual([
      {
        url: "/ws?orchestrationProtocol=2",
        auth: "Bearer synthetic-test-token",
      },
    ]);
    expect(received).toEqual([
      "subscribeServerConfig",
      "Ack",
      "Ack",
      "Interrupt",
    ]);
  } finally {
    server.stop(true);
  }
});
