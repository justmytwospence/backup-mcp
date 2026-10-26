import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { RunManager, MAX_POLL_MISSES, POLL_MS, HISTORY_LIMIT, RECENT_LIMIT } from "./runs.js";
import { ExecStartError } from "./docker.js";
import type { Job } from "./jobs.js";
import { runView } from "./context.js";

const ID = "a".repeat(64);
const job: Job = { kind: "offen", job: "demo", conf: "demo.conf", schedule: "", env: {
  AWS_S3_PATH: "demo/", AWS_SECRET_ACCESS_KEY: "fixture-secret", BACKUP_POST_COMMAND: "trusted hook; echo ok",
} };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(overrides: ConstructorParameters<typeof RunManager>[0] = {}) {
  const sleeps: (() => void)[] = [];
  const commands: unknown[][] = [];
  const counters = { polls: 0, logs: 0, resolves: 0 };
  const manager = new RunManager({
    execDetached: async (...args) => { commands.push(args); return ID; },
    execState: async () => { counters.polls++; return { running: false, exitCode: 0 }; },
    logsSince: async () => { counters.logs++; return ["uploaded 12 files"]; },
    resolveIncidents: async () => { counters.resolves++; },
    sleep: (ms) => { assert.equal(ms, POLL_MS); return new Promise((resolve) => sleeps.push(resolve)); },
    now: () => Date.parse("2026-10-25T12:00:00Z"), ...overrides,
  });
  return { manager, commands, counters, tick: async () => {
    assert.ok(sleeps.length, "expected a scheduled inspection");
    sleeps.shift()!();
    await setImmediate();
  }, sleeps };
}

test("reservation precedes first await; concurrent starts issue only one fixed exec", async () => {
  const exec = deferred<string>();
  let calls = 0;
  const f = fixture({ execDetached: async () => { calls++; return exec.promise; } });
  const first = f.manager.start(job);
  assert.equal(f.manager.current()?.state, "starting");
  const rest = await Promise.all(Array.from({ length: 10 }, () => f.manager.start(job)));
  assert.ok(rest.every((r) => !r.ok && r.run.id === 1));
  assert.equal(calls, 1);
  exec.resolve(ID);
  const started = await first;
  assert.equal(started.ok, true);
  assert.equal(started.run.state, "running");
  assert.equal((await f.manager.start(job)).ok, false);
  await f.tick();
  assert.equal(started.run.state, "succeeded");
  assert.equal(f.counters.resolves, 1);
  assert.equal(f.manager.current(), undefined);
});

test("fixed offen command passes only the configured environment; no caller interpolation", async () => {
  const f = fixture();
  const r = await f.manager.start(job);
  assert.deepEqual(f.commands[0], ["backup", ["/bin/sh", "-c", "backup > /proc/1/fd/1 2>&1"], [
    "AWS_S3_PATH=demo/", "AWS_SECRET_ACCESS_KEY=fixture-secret", "BACKUP_POST_COMMAND=trusted hook; echo ok",
  ]]);
  const publicRun = JSON.stringify(runView(r.run));
  for (const hidden of [ID, "fixture-secret", "trusted hook", "container", "startConfirmed"]) {
    assert.ok(!publicRun.includes(hidden), hidden);
  }
  await f.tick();
});

test("stack-back retains fixed cron command and exit status", async () => {
  const f = fixture();
  const r = await f.manager.start({ kind: "stack-back", job: "stack-back", schedule: "" });
  assert.deepEqual(f.commands[0], ["stack-back", ["/bin/sh", "-c",
    "source /.env && rcb backup > /proc/1/fd/1 2>&1; rc=$?; python /notify.py backup $rc > /proc/1/fd/1 2>&1; exit $rc",
  ], []]);
  await f.tick();
  assert.equal(r.run.exitCode, 0);
});

test("create failure is recorded, sanitized and releases admission, without automatic retry", async () => {
  let calls = 0;
  const f = fixture({ execDetached: async () => { calls++; throw new Error("docker POST create: HTTP 503 fixture-secret"); } });
  const r = await f.manager.start(job);
  assert.equal(r.ok, false);
  assert.equal(r.run.state, "failed");
  assert.match(r.message, /Start not attempted.*HTTP 503/);
  assert.ok(!r.message.includes("fixture-secret"));
  assert.equal(calls, 1);
  assert.equal(f.manager.current(), undefined);
  assert.equal(f.sleeps.length, 0);
});

test("lost start response retains reservation/id; Running:false/ExitCode:0 is ambiguous", async () => {
  let creates = 0;
  const f = fixture({ execDetached: async () => { creates++; throw new ExecStartError(ID, new Error("HTTP 504 fixture-secret")); } });
  const r = await f.manager.start(job);
  assert.equal(r.ok, false);
  assert.equal(r.run.state, "lost");
  assert.equal(r.run.exec, ID);
  assert.match(r.message, /outcome unknown.*HTTP 504/);
  assert.ok(!r.message.includes("fixture-secret"));
  assert.equal((await f.manager.start(job)).ok, false);
  await f.tick();
  assert.equal(r.run.state, "lost");
  assert.equal(r.run.finishedAt, undefined);
  assert.equal(r.run.exitCode, undefined);
  assert.equal(f.counters.resolves, 0);
  assert.equal(f.sleeps.length, 0);
  assert.equal((await f.manager.start(job)).ok, false);
  assert.equal(creates, 1, "ambiguous start must never be replayed");
});

test("ambiguous start can recover only via positive running evidence then confirmed completion", async () => {
  let polls = 0;
  const f = fixture({
    execDetached: async () => { throw new ExecStartError(ID, new Error("connection lost")); },
    execState: async (id) => { assert.equal(id, ID); return ++polls === 1
      ? { running: true, exitCode: null } : { running: false, exitCode: 0 }; },
  });
  const r = await f.manager.start(job);
  await f.tick();
  assert.equal(r.run.state, "running");
  await f.tick();
  assert.equal(r.run.state, "succeeded");
  assert.equal(f.counters.resolves, 1);
  assert.equal(f.manager.current(), undefined);
});

test("bounded inspection failures mark lost, not stopped/finished, and never unlock/replay", async () => {
  let polls = 0;
  const f = fixture({ execState: async () => { polls++; throw new Error("docker GET: HTTP 503 fixture-secret"); } });
  const r = await f.manager.start(job);
  for (let i = 0; i < MAX_POLL_MISSES; i++) await f.tick();
  assert.equal(polls, MAX_POLL_MISSES);
  assert.equal(r.run.state, "lost");
  assert.equal(r.run.finishedAt, undefined);
  assert.match(r.run.note!, /HTTP 503.*Not proof it stopped/);
  assert.ok(!r.run.note!.includes("fixture-secret"));
  assert.equal(f.sleeps.length, 0);
  assert.equal((await f.manager.start(job)).ok, false);
  assert.equal(f.commands.length, 1);
  assert.equal(f.counters.resolves, 0);
});

test("temporary observation failures recover; failed exits do not resolve incidents", async () => {
  let polls = 0;
  const f = fixture({ execState: async () => {
    if (++polls === 1) throw new Error("temporary unavailable");
    return { running: false, exitCode: 7 };
  } });
  const r = await f.manager.start(job);
  await f.tick();
  assert.equal(r.run.state, "running");
  await f.tick();
  assert.equal(r.run.state, "failed");
  assert.equal(r.run.exitCode, 7);
  assert.equal(r.run.note, undefined);
  assert.ok(r.run.finishedAt && r.run.observedAt);
  assert.equal(f.counters.resolves, 0);
});

test("null terminal exit code is unknown, not failure or permission to run", async () => {
  const f = fixture({ execState: async () => ({ running: false, exitCode: null }) });
  const r = await f.manager.start(job);
  await f.tick();
  assert.equal(r.run.state, "lost");
  assert.equal(f.manager.current(), r.run);
  assert.equal(r.run.finishedAt, undefined);
});

test("slow inspections do not overlap", async () => {
  const gate = deferred<{ running: boolean; exitCode: number | null }>();
  const f = fixture({ execState: () => gate.promise });
  await f.manager.start(job);
  await f.tick();
  assert.equal(f.sleeps.length, 0, "no further poll until the first settles");
  gate.resolve({ running: false, exitCode: 0 });
  await setImmediate();
  assert.equal(f.manager.runs()[0].state, "succeeded");
});

test("successful running observation resets consecutive failure accounting", async () => {
  let polls = 0;
  const f = fixture({ execState: async () => {
    polls++;
    if (polls === MAX_POLL_MISSES) return { running: true, exitCode: null };
    if (polls === MAX_POLL_MISSES * 2) return { running: false, exitCode: 0 };
    throw new Error("temporarily unreachable");
  } });
  const r = await f.manager.start(job);
  for (let i = 0; i < MAX_POLL_MISSES * 2; i++) await f.tick();
  assert.equal(r.run.state, "succeeded");
  assert.equal(f.counters.resolves, 1);
});

test("notification errors preserve confirmed success and useful sanitized diagnostics", async () => {
  const f = fixture({ resolveIncidents: async () => { throw new Error("HTTP 502 fixture-secret"); } });
  const r = await f.manager.start(job);
  await f.tick();
  assert.equal(r.run.state, "succeeded");
  assert.match(r.run.note!, /incident resolution failed: HTTP 502/);
  assert.ok(!r.run.note!.includes("fixture-secret"));
});

test("real Docker adapter and notification path use mocked fetch only, with no POST replay", async (t) => {
  const oldUrl = process.env.NOTIFY_URL, oldToken = process.env.NOTIFY_TOKEN;
  process.env.NOTIFY_URL = "https://notify.invalid/fixture";
  process.env.NOTIFY_TOKEN = "fixture-notify-token";
  t.after(() => {
    if (oldUrl === undefined) delete process.env.NOTIFY_URL; else process.env.NOTIFY_URL = oldUrl;
    if (oldToken === undefined) delete process.env.NOTIFY_TOKEN; else process.env.NOTIFY_TOKEN = oldToken;
  });
  const requests: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    if (url.endsWith("/exec") && init.method === "POST") return Response.json({ Id: ID });
    if (url.endsWith("/start")) return new Response(null, { status: 200 });
    if (url.endsWith("/json")) return Response.json({ Running: false, ExitCode: 0 });
    assert.equal(url, "https://notify.invalid/fixture");
    assert.equal((init.headers as Record<string, string>).authorization, "Bearer fixture-notify-token");
    assert.deepEqual(JSON.parse(init.body as string), { source: "backup", resolve: [
      { key: "backup:stale:demo" }, { key: "backup:failed:backup-failed-demo" },
    ] });
    return new Response("unavailable", { status: 503 });
  });
  let poll!: () => void;
  const manager = new RunManager({ sleep: () => new Promise((resolve) => { poll = resolve; }) });
  const r = await manager.start(job);
  assert.equal(requests.length, 2);
  poll();
  await setImmediate();
  assert.equal(r.run.state, "succeeded");
  assert.match(r.run.note!, /notification HTTP 503; delivery not retried/);
  assert.equal(requests.length, 4, "create + start + one inspect + one notification only");
  assert.equal(manager.current(), undefined);
});

test("bounded history/recent cache and restart have honest missing semantics", async () => {
  const f = fixture({ execDetached: async () => { throw new Error("create refused"); } });
  for (let i = 0; i < HISTORY_LIMIT + 5; i++) await f.manager.start(job);
  assert.equal(f.manager.find(1), undefined);
  assert.ok(f.manager.find(6));
  assert.equal(f.manager.runs().length, RECENT_LIMIT);
  assert.equal(f.manager.runs()[0].id, HISTORY_LIMIT + 5);
  assert.equal(fixture().manager.find(HISTORY_LIMIT + 5), undefined);
});

test("logs are bounded and redacted without erasing operation/HTTP diagnostics", async () => {
  const f = fixture({ logsSince: async (_container, _since, lines) => {
    assert.equal(lines, 30);
    return ["uploaded 12 files", "fixture-secret", "AWS_SECRET_ACCESS_KEY=unknown-credential", "https://u:p@b2.example/path?token=query-value", "x".repeat(50_000)];
  } });
  const r = await f.manager.start(job);
  const log = await f.manager.tail(r.run);
  assert.ok(log.length <= 30);
  assert.match(log.join("\n"), /uploaded 12 files/);
  assert.ok(log.every((line) => line.length <= 1012));
  for (const secret of ["fixture-secret", "unknown-credential", "u:p", "query-value"]) assert.ok(!log.join("\n").includes(secret));
  await f.tick();
});
