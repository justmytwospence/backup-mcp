// The jobs this server may run: one per docker-volume-backup conf.d file, named by its
// AWS_S3_PATH (the B2 prefix, which is also how backup alerts name a job), plus
// stack-back when it is configured. Nothing else can be run: a job name is looked up
// here, never passed on.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface OffenJob {
  kind: "offen";
  job: string;
  conf: string;
  schedule: string;
  /** The conf file's variables, passed to `backup` as its environment. */
  env: Record<string, string>;
}
export interface StackBackJob {
  kind: "stack-back";
  job: "stack-back";
  schedule: string;
}
export type Job = OffenJob | StackBackJob;

const CONF_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.conf$/;
const JOB_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const KEY = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Parse a conf.d file the way offen does (an env file): KEY=VALUE lines, `#` comments,
 * values taken verbatim. Quotes are stripped when they wrap the whole value.
 */
export function parseConf(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    if (!KEY.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function loadJobs(confDir: string, stackBack: boolean): Job[] {
  const jobs: Job[] = [];
  for (const conf of readdirSync(confDir).sort()) {
    if (!CONF_NAME.test(conf)) continue;
    const env = parseConf(readFileSync(join(confDir, conf), "utf8"));
    const job = (env.AWS_S3_PATH ?? "").replace(/\/+$/, "");
    if (!JOB_NAME.test(job) || jobs.some((j) => j.job === job)) continue;
    jobs.push({ kind: "offen", job, conf, schedule: env.BACKUP_CRON_EXPRESSION ?? "", env });
  }
  if (stackBack && !jobs.some((j) => j.job === "stack-back")) {
    jobs.push({ kind: "stack-back", job: "stack-back", schedule: process.env.STACK_BACK_SCHEDULE ?? "" });
  }
  return jobs;
}

/** The slug the Alerting workflow gives offen's "Backup failed: <prefix>/" title. */
export function failedKey(job: string): string {
  const slug = `Backup failed: ${job}/`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `backup:failed:${slug}`;
}
