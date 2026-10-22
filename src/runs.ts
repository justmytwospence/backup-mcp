// Running a job: one at a time, detached, with fixed commands. The backup's own output
// goes to its container's log (as a scheduled run's does), so `docker logs backup` tells
// the same story either way. A run that exits 0 resolves the job's open backup incidents;
// a failed one is reported by the backup tool itself (offen's notifications, stack-back's
// notify.py), exactly as on a schedule.

import { execDetached, execState, logsSince } from "./docker.js";
import { failedKey, type Job } from "./jobs.js";

export interface Run {
  id: number;
  job: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  state: "running" | "succeeded" | "failed" | "lost";
  note?: string;
  exec: string;
  container: string;
  startedSec: number;
}

const history: Run[] = [];
let nextId = 1;
const POLL_MS = Number(process.env.POLL_MS ?? 5000);

export const OFFEN_CONTAINER = process.env.BACKUP_CONTAINER ?? "backup";
export const STACK_BACK_CONTAINER = process.env.STACK_BACK_CONTAINER ?? "stack-back";

export function current(): Run | undefined {
  return history.find((r) => r.state === "running");
}
export function runs(): Run[] {
  return history.slice(-20).reverse();
}
export function find(id: number): Run | undefined {
  return history.find((r) => r.id === id);
}

function command(job: Job): { container: string; cmd: string[]; env: string[] } {
  if (job.kind === "offen") {
    return {
      container: OFFEN_CONTAINER,
      cmd: ["/bin/sh", "-c", "backup > /proc/1/fd/1 2>&1"],
      env: Object.entries(job.env).map(([k, v]) => `${k}=${v}`),
    };
  }
  // stack-back's own CRON_COMMAND, keeping rcb's exit code as the run's.
  return {
    container: STACK_BACK_CONTAINER,
    cmd: [
      "/bin/sh",
      "-c",
      "source /.env && rcb backup > /proc/1/fd/1 2>&1; rc=$?; python /notify.py backup $rc > /proc/1/fd/1 2>&1; exit $rc",
    ],
    env: [],
  };
}

export async function start(job: Job): Promise<{ ok: boolean; message: string; run?: Run }> {
  const busy = current();
  if (busy) {
    return {
      ok: false,
      message: `Busy: ${busy.job} has been running since ${busy.startedAt}. Try again when it finishes.`,
      run: busy,
    };
  }
  const { container, cmd, env } = command(job);
  const startedSec = Date.now() / 1000;
  const exec = await execDetached(container, cmd, env);
  const run: Run = {
    id: nextId++,
    job: job.job,
    startedAt: new Date().toISOString(),
    state: "running",
    exec,
    container,
    startedSec,
  };
  history.push(run);
  if (history.length > 50) history.splice(0, history.length - 50);
  void watch(run);
  return { ok: true, message: `Backup of ${job.job} started (run ${run.id}).`, run };
}

async function watch(run: Run): Promise<void> {
  let misses = 0;
  while (run.state === "running") {
    await new Promise((r) => setTimeout(r, POLL_MS));
    try {
      const s = await execState(run.exec);
      misses = 0;
      if (s.running) continue;
      run.exitCode = s.exitCode;
      run.finishedAt = new Date().toISOString();
      run.state = s.exitCode === 0 ? "succeeded" : "failed";
    } catch (e) {
      // The exec is gone (container restarted) or Docker is unreachable for a while.
      if (++misses >= 12) {
        run.state = "lost";
        run.finishedAt = new Date().toISOString();
        run.note = `lost track of the run: ${(e as Error).message}`;
      }
    }
  }
  if (run.state === "succeeded") await resolveIncidents(run.job);
}

/** Close the job's open backup incidents in n8n's Alerting workflow (silent if none). */
async function resolveIncidents(job: string): Promise<void> {
  const url = process.env.NOTIFY_URL, token = process.env.NOTIFY_TOKEN;
  if (!url || !token || job === "stack-back") return; // stack-back's notify.py resolves its own
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ source: "backup", resolve: [{ key: `backup:stale:${job}` }, { key: failedKey(job) }] }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    console.error(`resolve for ${job} failed: ${(e as Error).message}`);
  }
}

export async function tail(run: Run, lines = 30): Promise<string[]> {
  try {
    return await logsSince(run.container, run.startedSec - 1, lines);
  } catch (e) {
    return [`(log unavailable: ${(e as Error).message})`];
  }
}
