const checks = [["check"], ["fmt", "--check"]] as const;

const results = await Promise.allSettled(
  checks.map(async (args) => {
    const child = Bun.spawn([process.execPath, "--no-script", ...args], {
      stdout: "inherit",
      stderr: "inherit",
    });
    return child.exited;
  }),
);

let exitCode = 0;

for (const [index, result] of results.entries()) {
  if (result.status === "rejected") {
    console.error(
      `Could not run bun ${checks[index].join(" ")}:`,
      result.reason,
    );
    exitCode = 1;
  } else if (result.value !== 0) {
    console.error(
      `bun ${checks[index].join(" ")} exited with status ${result.value}.`,
    );
    exitCode = 1;
  }
}

process.exitCode = exitCode;

export {};
