/** Execution core shared by the MCP dispatcher tools (port of server._execute),
 * extended with async job submission (run_mode=async). */

import { AuditLog, type AuditEntry } from "./audit.js";
import { Authorizer, denyNonePolicy, type AuthorizationPolicy } from "./authorization.js";
import { errorEnvelope, type Envelope } from "./envelope.js";
import { AgentRunner } from "./agent_runner.js";
import { UnknownJobError, SkillHubError } from "./errors.js";
import { type JobRecord, JobStore } from "./jobs.js";
import { ScriptRunner } from "./runner.js";
import { Semaphore } from "./semaphore.js";
import { type SkillRegistry } from "./registry.js";

export class Hub {
  constructor(
    readonly registry: SkillRegistry,
    private readonly scriptRunner: ScriptRunner,
    private readonly audit: AuditLog,
    private readonly semaphore: Semaphore,
    private readonly jobStore: JobStore,
    private readonly agentRunner?: AgentRunner,
    private readonly authorizer: Authorizer = new Authorizer(denyNonePolicy()),
  ) {}

  /** Sync execution: authorize, validate, take a semaphore slot, run, audit. */
  async execute(
    skillId: string,
    inputs: Record<string, unknown> = {},
    dryRun = true,
    client = "",
  ): Promise<Envelope> {
    try {
      this.authorize(client, skillId);
      this.registry.validateInputs(skillId, inputs);
      const runner = this.runnerFor(skillId);
      const envelope = await this.semaphore.run(() =>
        runner.run(skillId, inputs, { dryRun, client }),
      );
      this.audit.record({
        skill_id: skillId,
        status: envelope.status,
        duration_ms: envelope.duration_ms ?? null,
        inputs_summary: summarizeInputs(inputs),
        client,
      });
      return envelope;
    } catch (err) {
      if (err instanceof SkillHubError) {
        this.audit.record({
          skill_id: skillId,
          status: "rejected",
          reason: err.message,
          client,
        });
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.audit.record({
        skill_id: skillId,
        status: "failed",
        reason: message,
        client,
      });
      throw new SkillHubError(`skill-hub internal error: ${message}`);
    }
  }

  /** Async submission: validate fail-fast (identical audit trail to sync),
   * then run in the background through the same semaphore and audit policy.
   * The caller polls the returned job handle via get_job. */
  submit(
    skillId: string,
    inputs: Record<string, unknown> = {},
    dryRun = true,
    client = "",
  ): JobRecord {
    try {
      this.authorize(client, skillId);
      this.registry.validateInputs(skillId, inputs);
    } catch (err) {
      if (err instanceof SkillHubError) {
        this.audit.record({
          skill_id: skillId,
          status: "rejected",
          reason: err.message,
          client,
        });
      }
      throw err;
    }
    const job = this.jobStore.create(skillId, dryRun, client);
    void this.runJob(job.job_id, skillId, inputs, dryRun, client);
    return job;
  }

  private async runJob(
    jobId: string,
    skillId: string,
    inputs: Record<string, unknown>,
    dryRun: boolean,
    client: string,
  ): Promise<void> {
    try {
      const runner = this.runnerFor(skillId);
      this.jobStore.markRunning(jobId);
      const envelope = await this.semaphore.run(() =>
        runner.run(skillId, inputs, { dryRun, client }),
      );
      this.jobStore.complete(jobId, envelope);
      this.audit.record({
        skill_id: skillId,
        status: envelope.status,
        duration_ms: envelope.duration_ms ?? null,
        inputs_summary: summarizeInputs(inputs),
        client,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof SkillHubError) {
        this.jobStore.fail(jobId, message);
        this.audit.record({
          skill_id: skillId,
          status: "rejected",
          reason: message,
          client,
        });
      } else {
        this.jobStore.fail(jobId, `skill-hub internal error: ${message}`);
        this.audit.record({
          skill_id: skillId,
          status: "failed",
          reason: message,
          client,
        });
      }
    }
  }

  /** Job handle lookup; UnknownJobError surfaces as a tool error. */
  job(jobId: string): JobRecord {
    const job = this.jobStore.get(jobId);
    if (!job) {
      throw new UnknownJobError(
        `Unknown job ${JSON.stringify(jobId)}; list_jobs shows recent submissions`,
      );
    }
    return job;
  }

  /** Newest-first page over recent submissions. */
  jobs(limit: number): JobRecord[] {
    return this.jobStore.list(limit);
  }

  /** Audit entries, newest first (REST /api/audit backing). */
  auditEntries(q: {
    limit?: number;
    skill_id?: string;
    status?: string;
    client?: string;
  }): Promise<AuditEntry[]> {
    return this.audit.query(q);
  }

  private authorize(client: string, skillId: string): void {
    const riskLevel = this.registry.get(skillId).risk_level as string | undefined;
    this.authorizer.authorize(client, skillId, riskLevel);
  }

  private runnerFor(skillId: string): ScriptRunner | AgentRunner {
    if (this.registry.get(skillId).type === "agent") {
      return this.agentRunner ?? new AgentRunner(this.registry, this.scriptRunner);
    }
    return this.scriptRunner;
  }
}

function summarizeInputs(
  inputs: Record<string, unknown>,
  limit = 200,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(inputs).map(([key, value]) => {
      const text = String(value);
      return [key, text.length <= limit ? text : text.slice(0, limit) + "…"];
    }),
  );
}

export { errorEnvelope };
