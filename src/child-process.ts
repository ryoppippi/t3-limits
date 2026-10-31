import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";

export interface ChildProcessWithOutput {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(signal?: "SIGKILL" | "SIGTERM"): void;
}

export interface ManagedChildProcess<Child extends ChildProcessWithOutput> {
  readonly child: Child;
  readonly exited: Promise<number>;
}

export function acquireChildProcess<
  Child extends ChildProcessWithOutput,
  Error,
  Requirements,
>(
  acquire: Effect.Effect<Child, Error, Requirements>,
  signal: "SIGKILL" | "SIGTERM",
): Effect.Effect<
  ManagedChildProcess<Child>,
  Error,
  Requirements | Scope.Scope
> {
  return Effect.acquireRelease(
    Effect.map(acquire, (child) => {
      let hasExited = false;
      void child.exited.then(
        () => {
          hasExited = true;
        },
        () => {},
      );
      return { child, exited: child.exited, hasExited: () => hasExited };
    }),
    (managed) =>
      Effect.sync(() => {
        if (!managed.hasExited()) {
          try {
            managed.child.kill(signal);
          } catch {
            // The process can exit between the status check and the signal.
          }
        }
        try {
          // Native cancellation can remain pending after the child has stopped.
          void managed.child.stdout.cancel().catch(() => {});
        } catch {
          // Cancellation can fail synchronously when the stream is already closed.
        }
      }),
  );
}
