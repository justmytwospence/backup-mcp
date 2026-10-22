import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demux } from "./docker.js";
import { failedKey, loadJobs, parseConf } from "./jobs.js";

test("parseConf keeps values verbatim and skips comments", () => {
  const env = parseConf(
    "# comment\nBACKUP_CRON_EXPRESSION=58 6 * * *\nAWS_S3_PATH=hermes/\n" +
      "BACKUP_EXCLUDE_REGEXP=/([.]local|cache)/\nQUOTED=\"a b\"\nnot a line\nlower=x\n",
  );
  assert.equal(env.BACKUP_CRON_EXPRESSION, "58 6 * * *");
  assert.equal(env.AWS_S3_PATH, "hermes/");
  assert.equal(env.BACKUP_EXCLUDE_REGEXP, "/([.]local|cache)/");
  assert.equal(env.QUOTED, "a b");
  assert.equal(env.lower, undefined);
});

test("loadJobs names jobs by their B2 prefix and adds stack-back", () => {
  const dir = mkdtempSync(join(tmpdir(), "confd-"));
  writeFileSync(join(dir, "nextcloud.conf"), "AWS_S3_PATH=nextcloud/\nBACKUP_CRON_EXPRESSION=0 2 * * *\n");
  writeFileSync(join(dir, "weird.conf"), "AWS_S3_PATH=../etc/\n");
  writeFileSync(join(dir, "notes.txt"), "AWS_S3_PATH=notes/\n");
  const jobs = loadJobs(dir, true);
  assert.deepEqual(jobs.map((j) => j.job), ["nextcloud", "stack-back"]);
  assert.equal(loadJobs(dir, false).length, 1);
});

test("failedKey matches the Alerting workflow's family slug", () => {
  assert.equal(failedKey("hermes"), "backup:failed:backup-failed-hermes");
  assert.equal(failedKey("env-secrets"), "backup:failed:backup-failed-env-secrets");
});

test("demux strips docker stream headers", () => {
  const frame = (s: string, n = 1) => {
    const p = Buffer.from(s);
    const h = Buffer.alloc(8);
    h[0] = n;
    h.writeUInt32BE(p.length, 4);
    return Buffer.concat([h, p]);
  };
  assert.equal(demux(Buffer.concat([frame("a\n"), frame("b\n", 2)])), "a\nb\n");
  assert.equal(demux(Buffer.from("plain\n")), "plain\n");
});
