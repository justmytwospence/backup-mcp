import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { loadJobs } from "./jobs.js";
import * as runs from "./runs.js";

export const SERVER_NAME = "backup-mcp";
export const VERSION: string = createRequire(import.meta.url)("../package.json").version;

const CONF_DIR = process.env.CONF_DIR ?? "/conf.d";
const STACK_BACK = (process.env.STACK_BACK ?? "true").toLowerCase() !== "false";

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: JSON.stringify({ ok: false, message }) }], isError: true });
const view = (r: runs.Run) => ({
  run: r.id,
  job: r.job,
  state: r.state,
  startedAt: r.startedAt,
  finishedAt: r.finishedAt,
  exitCode: r.exitCode,
  note: r.note,
});

/**
 * Builds a fully registered server. The HTTP transport calls this once per request, so it
 * stays free of side effects; run state lives in runs.ts.
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION });

  server.registerTool(
    "list_jobs",
    {
      title: "List backup jobs",
      description:
        "The backup jobs that can be run: one per docker-volume-backup conf.d file, named by its B2 prefix (as backup alerts name them), plus stack-back (restic: Immich, Paperless). Also says which run, if any, is in progress.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const jobs = loadJobs(CONF_DIR, STACK_BACK).map((j) => ({ job: j.job, kind: j.kind, schedule: j.schedule }));
      const busy = runs.current();
      return json({ jobs, running: busy ? view(busy) : null });
    },
  );

  server.registerTool(
    "run_backup",
    {
      title: "Run a backup job now",
      description:
        "Start one backup job now, outside its schedule, exactly as its cron would run it (same configuration, same upload, same failure alert). Returns at once with a run id; one job runs at a time. A successful run closes the job's open backup alerts.",
      inputSchema: z.object({
        job: z.string().min(1).max(63).describe("A job name from list_jobs, e.g. 'hermes' or 'stack-back'"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ job }) => {
      const found = loadJobs(CONF_DIR, STACK_BACK).find((j) => j.job === job);
      if (!found) return fail(`No backup job named ${JSON.stringify(job)}; list_jobs shows the names.`);
      try {
        const r = await runs.start(found);
        return r.ok ? json({ ok: true, message: r.message, ...view(r.run!) }) : fail(r.message);
      } catch (e) {
        return fail(`Could not start ${job}: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "run_status",
    {
      title: "Backup run status",
      description:
        "A run's state (running, succeeded, failed, lost), exit code and the last lines of its container's log since it started. Without a run id: the recent runs.",
      inputSchema: z.object({
        run: z.number().int().positive().optional().describe("Run id from run_backup"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ run }) => {
      if (run === undefined) return json({ runs: runs.runs().map(view) });
      const r = runs.find(run);
      if (!r) return fail(`No run ${run} (runs are kept in memory; a restart forgets them).`);
      return json({ ...view(r), log: await runs.tail(r) });
    },
  );

  return server;
}
