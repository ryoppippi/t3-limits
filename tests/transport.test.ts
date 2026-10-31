import { expect, test } from "bun:test";
import { readUsageLimitStreams } from "../src/rpc.ts";

test("uses Bun's real WebSocket transport with a bearer header", async () => {
  let authorised = false;
  const methods: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      authorised = request.headers.get("authorization") === "Bearer synthetic-test-token";
      if (server.upgrade(request)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      message(socket, data) {
        const frame = JSON.parse(String(data));
        if (frame._tag !== "Request") return;
        methods.push(frame.tag);
        socket.send(JSON.stringify([
          { _tag: "Chunk", requestId: frame.id, values: [
            { version: 1, type: "snapshot", config: { providers: [] } },
          ] },
          { _tag: "Chunk", requestId: frame.id, values: [
            { version: 1, type: "usageLimitSourcesUpdated", payload: { sources: [] } },
          ] },
        ]));
      },
    },
  });
  try {
    expect(await readUsageLimitStreams({
      origin: `http://127.0.0.1:${server.port}`,
      token: "synthetic-test-token",
      timeoutMs: 1_000,
    })).toEqual({ providers: [], sources: [] });
    expect(authorised).toBe(true);
    expect(methods).toEqual(["subscribeServerConfig"]);
  } finally {
    server.stop(true);
  }
});
