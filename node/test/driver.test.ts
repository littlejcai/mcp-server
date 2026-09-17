/** ExecutionDriver (N3): the default ProcessDriver — spawn lifecycle,
 * timeout kill-tree, capped streams, spawn errors. */

import { describe, expect, it } from "./expect.js";
import { ProcessDriver } from "../src/core/driver.js";

const driver = new ProcessDriver();

describe("ProcessDriver", () => {
  it("runs a command and captures stdout", async () => {
    const out = await driver.run({
      argv: [process.execPath, "-e", "console.log('hello driver')"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      stdin: "",
      timeoutMs: 5_000,
      maxStdoutBytes: 1000,
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("hello driver");
    expect(out.timedOut).toBe(false);
    expect(out.spawnError).toBeUndefined();
  });

  it("reports a nonzero exit code", async () => {
    const out = await driver.run({
      argv: [process.execPath, "-e", "process.exit(3)"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      stdin: "",
      timeoutMs: 5_000,
      maxStdoutBytes: 1000,
    });
    expect(out.exitCode).toBe(3);
  });

  it("times out and kills the process tree", async () => {
    const out = await driver.run({
      argv: [process.execPath, "-e", "setTimeout(() => {}, 60_000)"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      stdin: "",
      timeoutMs: 300,
      maxStdoutBytes: 1000,
    });
    expect(out.timedOut).toBe(true);
    expect(out.exitCode).not.toBe(0);
  });

  it("reports ENOENT for a missing executable", async () => {
    const out = await driver.run({
      argv: ["definitely-not-a-real-binary-xyz", "arg"],
      cwd: process.cwd(),
      env: { PATH: "" },
      stdin: "",
      timeoutMs: 5_000,
      maxStdoutBytes: 1000,
    });
    expect(out.spawnError?.code).toBe("ENOENT");
  });

  it("caps stdout while still draining the stream", async () => {
    const out = await driver.run({
      argv: [
        process.execPath,
        "-e",
        "process.stdout.write('x'.repeat(500))",
      ],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      stdin: "",
      timeoutMs: 5_000,
      maxStdoutBytes: 10,
    });
    expect(out.stdoutTruncated).toBe(true);
    expect(out.stdout.length).toBe(11); // cap + 1 byte so truncation is visible
  });

  it("delivers stdin to the child", async () => {
    const out = await driver.run({
      argv: [
        process.execPath,
        "-e",
        "let s=''; process.stdin.on('data',d=>s+=d); process.stdin.on('end',()=>console.log(s.toUpperCase()))",
      ],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      stdin: "ping",
      timeoutMs: 5_000,
      maxStdoutBytes: 1000,
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("PING");
  });
});
