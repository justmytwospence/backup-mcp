// Process-local admission and cached history. A reservation is made synchronously,
// before Docker is contacted, and retained when an execution outcome is unknown.
import { execDetached, execState, logsSince, ExecStartError } from "./docker.js";
import { failedKey, type Job } from "./jobs.js";
import { sanitizer, errorMessage } from "./sanitize.js";

export interface Run {
  id: number;
  job: string;
  startedAt: string;
  finishedAt?: string;
  observedAt?: string;
  exitCode?: number | null;
  state: "starting" | "running" | "succeeded" | "failed" | "lost";
  note?: string;
  /** Internal only: never publish the exec id, container or environment. */
  exec?: string;
  container: string;
  startedSec: number;
  startConfirmed: boolean;
  sanitize: (text: string, maxChars?: number) => string;
}

export const HISTORY_LIMIT = 50;
export const RECENT_LIMIT = 20;
export const MAX_POLL_MISSES = 12;
export const LOG_LINES = 30;
const configuredPoll = Number(process.env.POLL_MS ?? 5000);
// Local Docker load policy, not a provider quota. Reject pathological timer values.
export const POLL_MS = Number.isSafeInteger(configuredPoll) && configuredPoll >= 1000 && configuredPoll <= 60_000
  ? configuredPoll : 5000;

export const OFFEN_CONTAINER = process.env.BACKUP_CONTAINER ?? "backup";
export const STACK_BACK_CONTAINER = process.env.STACK_BACK_CONTAINER ?? "stack-back";

interface Dependencies {
  execDetached: typeof execDetached;
  execState: typeof execState;
  logsSince: typeof logsSince;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  resolveIncidents: (job: string) => Promise<void>;
}

function command(job: Job): { container: string; cmd: string[]; env: string[] } {
  if (job.kind === "offen") {
    return {
      container: OFFEN_CONTAINER,
      cmd: ["/bin/sh", "-c", "backup > /proc/1/fd/1 2>&1"],
      env: Object.entries(job.env).map(([k, v]) => `${k}=${v}`),
    };
  }
  return {
    container: STACK_BACK_CONTAINER,
    cmd: [
      "/bin/sh", "-c",
      "source /.env && rcb backup > /proc/1/fd/1 2>&1; rc=$?; python /notify.py backup $rc > /proc/1/fd/1 2>&1; exit $rc",
    ],
    env: [],
  };
}

export class RunManager {
  private history: Run[] = [];
  private nextId = 1;
  private readonly deps: Dependencies;
  readonly startedAt: string;

  constructor(deps: Partial<Dependencies> = {}) {
    this.deps = {
      execDetached, execState, logsSince,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: Date.now, resolveIncidents, ...deps,
    };
    this.startedAt = new Date(this.deps.now()).toISOString();
  }

  current(): Run | undefined {
    return this.history.find((r) => r.state === "starting" || r.state === "running" || r.state === "lost");
  }
  runs(): Run[] {
    return this.history.slice(-RECENT_LIMIT).reverse();
  }
  find(id: number): Run | undefined {
    return this.history.find((r) => r.id === id);
  }

  async start(job: Job): Promise<{ ok: boolean; message: string; run: Run }> {
    const busy = this.current();
    if (busy) {
      return {
        ok: false,
        message: `Busy: run ${busy.id} (${busy.job}) is ${busy.state} since ${busy.startedAt}. Inspect before any new run; lost does not mean stopped.`,
        run: busy,
      };
    }
    const { container, cmd, env } = command(job);
    const run: Run = {
      id: this.nextId++, job: job.job,
      startedAt: new Date(this.deps.now()).toISOString(),
      state: "starting", container, startedSec: this.deps.now() / 1000,
      startConfirmed: false,
      sanitize: sanitizer(process.env, job.kind === "offen" ? job.env : {}),
    };
    // Admission MUST happen before the first await (including exec create/start).
    this.history.push(run);
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
    try {
      run.exec = await this.deps.execDetached(container, cmd, env);
      run.sanitize = sanitizer(process.env, job.kind === "offen" ? job.env : {}, { INTERNAL_EXEC_TOKEN: run.exec });
      run.startConfirmed = true;
      run.state = "running";
    } catch (error) {
      if (error instanceof ExecStartError) {
        run.exec = error.exec;
        run.sanitize = sanitizer(process.env, job.kind === "offen" ? job.env : {}, { INTERNAL_EXEC_TOKEN: run.exec });
        run.state = "lost";
        run.note = run.sanitize(`${errorMessage(error)}. It may still be running; do not rerun. Inspect Docker and backup records.`);
        void this.watch(run);
      } else {
        // execDetached guarantees a plain error only BEFORE a start is attempted.
        run.state = "failed";
        run.finishedAt = new Date(this.deps.now()).toISOString();
        run.note = run.sanitize(`Start not attempted: ${errorMessage(error)}`);
      }
      return { ok: false, message: run.note!, run };
    }
    void this.watch(run);
    return { ok: true, message: `Backup of ${job.job} started (run ${run.id}).`, run };
  }

  private async watch(run: Run): Promise<void> {
    let misses = 0;
    while (run.state === "running" || run.state === "lost") {
      await this.deps.sleep(POLL_MS);
      try {
        const state = await this.deps.execState(run.exec!);
        run.observedAt = new Date(this.deps.now()).toISOString();
        if (state.running) {
          run.startConfirmed = true;
          run.state = "running";
          run.note = undefined;
          misses = 0;
          continue;
        }
        // An unacknowledged start + Running:false/ExitCode:0 can be an exec that
        // NEVER started. Only a confirmed start can be called successful/failed.
        if (!run.startConfirmed || state.exitCode === null) {
          run.state = "lost";
          run.note = "Docker has no confirmed completion for this run. It may have run or still be running; inspect before rerunning.";
          return;
        }
        run.exitCode = state.exitCode;
        run.finishedAt = new Date(this.deps.now()).toISOString();
        run.state = state.exitCode === 0 ? "succeeded" : "failed";
        run.note = undefined;
      } catch (error) {
        run.note = run.sanitize(`Docker status unavailable (${++misses}/${MAX_POLL_MISSES}): ${errorMessage(error)}`);
        if (misses >= MAX_POLL_MISSES) {
          run.state = "lost";
          run.note = run.sanitize(`Lost track after ${MAX_POLL_MISSES} failed polls: ${errorMessage(error)}. Not proof it stopped; reservation retained. Inspect Docker and backup records before rerunning.`);
          return; // bounded failed polling; never replay or silently release admission
        }
      }
    }
    if (run.state === "succeeded") {
      try {
        await this.deps.resolveIncidents(run.job);
      } catch (error) {
        run.note = run.sanitize(`Backup succeeded; incident resolution failed: ${errorMessage(error)}`);
      }
    }
  }

  async tail(run: Run): Promise<string[]> {
    try {
      // Sanitize as one block first so multiline private keys cannot straddle lines.
      return run.sanitize((await this.deps.logsSince(run.container, run.startedSec - 1, LOG_LINES)).join("\n"), LOG_LINES * 1000)
        .split("\n").slice(-LOG_LINES).map((line) => run.sanitize(line));
    } catch (error) {
      return [run.sanitize(`(log unavailable: ${errorMessage(error)})`)];
    }
  }
}

/** Close open backup incidents once on confirmed success; never retry a notification POST. */
async function resolveIncidents(job: string): Promise<void> {
  const url = process.env.NOTIFY_URL, token = process.env.NOTIFY_TOKEN;
  if (!url || !token || job === "stack-back") return;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ source: "backup", resolve: [{ key: `backup:stale:${job}` }, { key: failedKey(job) }] }),
    signal: AbortSignal.timeout(15_000),
  });
  await res.body?.cancel();
  if (!res.ok) throw new Error(`notification HTTP ${res.status}; delivery not retried`);
}

export const manager = new RunManager();
