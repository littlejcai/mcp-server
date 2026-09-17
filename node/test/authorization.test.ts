/** Authorization (N3): grant model + config parsing + Hub integration. */

import * as path from "node:path";
import { describe, expect, it } from "./expect.js";

import {
  AuthorizationError,
  Authorizer,
  denyNonePolicy,
  loadPolicy,
} from "../src/core/authorization.js";
import { AuditLog } from "../src/core/audit.js";
import { Hub } from "../src/core/hub.js";
import { MemoryJobStore } from "../src/core/jobs.js";
import { ScriptRunner } from "../src/core/runner.js";
import { Semaphore } from "../src/core/semaphore.js";
import { buildFixture, type Fixture } from "./helpers.js";

const fixture: Fixture = buildFixture();

function authorizerFor(policy: ReturnType<typeof loadPolicy>): Authorizer {
  return new Authorizer(policy);
}

describe("authorization policy", () => {
  it("denies nothing when authorization is off", () => {
    const a = authorizerFor(denyNonePolicy());
    expect(() => a.authorize("rest", "md-stats-js", "workspace_write")).not.toThrow();
    expect(() => a.authorize("", "any-skill", "external_write")).not.toThrow();
  });

  it("loadPolicy returns allow-all when the config section is absent", () => {
    const a = authorizerFor(loadPolicy(undefined));
    expect(() => a.authorize("rest", "md-stats-js", "external_write")).not.toThrow();
  });

  it("loadPolicy denies everything for unlisted clients when configured without default", () => {
    const a = authorizerFor(loadPolicy({ clients: { "rest": { skills: ["md-stats-js"] } } }));
    expect(() => a.authorize("rest", "md-stats-js", "workspace_write")).not.toThrow();
    expect(() => a.authorize("unknown-client", "md-stats-js", "workspace_write")).toThrow(
      AuthorizationError,
    );
  });

  it("applies the default grant to unlisted clients", () => {
    const a = authorizerFor(
      loadPolicy({ default: { skills: ["md-stats-js"] }, clients: {} }),
    );
    expect(() => a.authorize("cli", "md-stats-js", "workspace_write")).not.toThrow();
    expect(() => a.authorize("cli", "failer", "read_only")).toThrow(AuthorizationError);
  });

  it("enforces the skill whitelist", () => {
    const a = authorizerFor(
      loadPolicy({ default: { skills: ["md-stats-js"] } }),
    );
    expect(() => a.authorize("rest", "md-stats-js", "read_only")).not.toThrow();
    expect(() => a.authorize("rest", "failer", "read_only")).toThrow(AuthorizationError);
  });

  it("enforces the risk ceiling", () => {
    const a = authorizerFor(
      loadPolicy({ default: { risk_limit: "read_only" } }),
    );
    expect(() => a.authorize("rest", "failer", "read_only")).not.toThrow();
    expect(() => a.authorize("rest", "md-stats-js", "workspace_write")).toThrow(
      AuthorizationError,
    );
  });

  it("treats unknown risk as the highest risk", () => {
    const a = authorizerFor(
      loadPolicy({ default: { risk_limit: "read_only" } }),
    );
    expect(() => a.authorize("rest", "mystery", undefined)).toThrow(AuthorizationError);
  });

  it("client grants override the default grant", () => {
    const a = authorizerFor(
      loadPolicy({
        default: { skills: [] },
        clients: { "cli": { skills: ["md-stats-js"], risk_limit: "workspace_write" } },
      }),
    );
    expect(() => a.authorize("cli", "md-stats-js", "workspace_write")).not.toThrow();
    expect(() => a.authorize("rest", "md-stats-js", "workspace_write")).toThrow(
      AuthorizationError,
    );
  });
});

describe("authorization in the Hub", () => {
  it("rejects an unauthorized sync execute with AuthorizationError", async () => {
    const hub = new Hub(
      fixture.registry,
      new ScriptRunner(fixture.registry, fixture.workspaceRoot),
      new AuditLog(path.join(fixture.workspaceRoot, "logs")),
      new Semaphore(1),
      new MemoryJobStore(),
      undefined,
      authorizerFor(loadPolicy({ default: { skills: ["md-stats-js"] } })),
    );
    await expect(
      hub.execute("failer", {}, true, "rest"),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("allows an authorized sync execute to reach the runner", async () => {
    const hub = new Hub(
      fixture.registry,
      new ScriptRunner(fixture.registry, fixture.workspaceRoot),
      new AuditLog(path.join(fixture.workspaceRoot, "logs")),
      new Semaphore(1),
      new MemoryJobStore(),
      undefined,
      authorizerFor(loadPolicy({ default: { skills: ["md-stats-js"] } })),
    );
    const env = await hub.execute("md-stats-js", {
      source_path: path.join(fixture.workspaceRoot, "inbox", "a.md"),
    }, true, "rest");
    expect(env.status).toBe("success");
  });

  it("rejects an unauthorized async submit", () => {
    const hub = new Hub(
      fixture.registry,
      new ScriptRunner(fixture.registry, fixture.workspaceRoot),
      new AuditLog(path.join(fixture.workspaceRoot, "logs")),
      new Semaphore(1),
      new MemoryJobStore(),
      undefined,
      authorizerFor(loadPolicy({ default: { skills: ["md-stats-js"] } })),
    );
    expect(() => hub.submit("failer", {}, true, "rest")).toThrow(AuthorizationError);
  });

  it("with authorization off the hub behaves exactly as before", async () => {
    const hub = new Hub(
      fixture.registry,
      new ScriptRunner(fixture.registry, fixture.workspaceRoot),
      new AuditLog(path.join(fixture.workspaceRoot, "logs")),
      new Semaphore(1),
      new MemoryJobStore(),
    );
    // authorization off never blocks; the failer skill fails at runtime,
    // proving the call reached the runner (same as before N3)
    await expect(hub.execute("failer", {}, true, "rest")).rejects.toThrow(
      /exited with code 2/,
    );
  });
});
