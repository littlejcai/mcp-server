/** REST API surface: JSON over HTTP for UI and scripting clients. Every handler
 * delegates to the same Hub execution core as the MCP tools — same envelope,
 * same job records, same error semantics (contract parity with /mcp). */

import express, { type Router } from "express";

import {
  SkillHubError,
  SkillInputError,
  UnknownJobError,
  UnknownSkillError,
} from "../core/errors.js";
import type { Hub } from "../core/hub.js";
import type { SkillRegistry } from "../core/registry.js";

export interface RestContext {
  registry: SkillRegistry;
  hub: Hub;
}

function httpStatus(err: unknown): number {
  if (err instanceof UnknownSkillError || err instanceof UnknownJobError) {
    return 404;
  }
  if (err instanceof SkillInputError) {
    return 400;
  }
  if (err instanceof SkillHubError) {
    return 400;
  }
  return 500;
}

function errorBody(err: unknown): { error: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof SkillHubError) {
    return { error: message };
  }
  return { error: `skill-hub internal error: ${message}` };
}

export function restRouter(ctx: RestContext): Router {
  const router = express.Router();

  // GET /api/skills — skill catalog (same shape as MCP list_skills)
  router.get("/skills", (_req, res) => {
    res.json({ skills: ctx.registry.list() });
  });

  // GET /api/skills/:skillId — one skill's schema (same shape as describe_skill)
  router.get("/skills/:skillId", (req, res) => {
    try {
      res.json(ctx.registry.describe(req.params.skillId));
    } catch (err) {
      res.status(httpStatus(err)).json(errorBody(err));
    }
  });

  // POST /api/skills/:skillId/run — execute or submit (same semantics as
  // run_skill: sync returns the envelope, async returns the job handle).
  router.post("/skills/:skillId/run", async (req, res) => {
    const body = (req.body ?? {}) as {
      inputs?: Record<string, unknown>;
      dry_run?: boolean;
      run_mode?: "sync" | "async";
    };
    const dryRun = body.dry_run !== false;
    try {
      if (body.run_mode === "async") {
        const job = ctx.hub.submit(
          req.params.skillId,
          body.inputs ?? {},
          dryRun,
          "rest",
        );
        res.status(202).json({
          job_id: job.job_id,
          status: job.status,
          skill_id: job.skill_id,
          dry_run: job.dry_run,
          submitted_at: job.submitted_at,
        });
        return;
      }
      const envelope = await ctx.hub.execute(
        req.params.skillId,
        body.inputs ?? {},
        dryRun,
        "rest",
      );
      res.json(envelope);
    } catch (err) {
      res.status(httpStatus(err)).json(errorBody(err));
    }
  });

  // GET /api/jobs — recent submissions, newest first
  router.get("/jobs", (req, res) => {
    const raw = Number(req.query.limit ?? 20);
    const limit = Number.isInteger(raw) && raw >= 1 && raw <= 100 ? raw : 20;
    res.json({ jobs: ctx.hub.jobs(limit) });
  });

  // GET /api/jobs/:jobId — one job record (same shape as get_job)
  router.get("/jobs/:jobId", (req, res) => {
    try {
      res.json(ctx.hub.job(req.params.jobId));
    } catch (err) {
      res.status(httpStatus(err)).json(errorBody(err));
    }
  });

  return router;
}
