import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createServer } from "./server.js";
import { RunManager } from "./runs.js";
import { loadJobs } from "./jobs.js";
import { ExecStartError } from "./docker.js";

const ID = "a".repeat(64);
async function fixture(t: TestContext, mode: "ok" | "lost" | "failed" | "starting" = "ok") {
  // All tests are offline, including resource discovery. Any accidental real fetch fails.
  t.mock.method(globalThis, "fetch", async () => assert.fail("unexpected network call"));
  const dir = mkdtempSync(join(tmpdir(), "backup-contract-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "demo.conf"), "AWS_S3_PATH=demo/\nBACKUP_CRON_EXPRESSION=0 2 * * *\nAWS_SECRET_ACCESS_KEY=fixture-secret\nBACKUP_POST_COMMAND=hidden-hook\n");
  const calls = { exec: 0, state: 0, log: 0, notify: 0 };
  let releaseExec!: (id: string) => void;
  const pendingExec = new Promise<string>((resolve) => { releaseExec = resolve; });
  const manager = new RunManager({
    execDetached: async () => {
      calls.exec++;
      if (mode === "lost") throw new ExecStartError(ID, new Error("HTTP 504 fixture-secret"));
      if (mode === "failed") throw new Error("create HTTP 503 fixture-secret");
      if (mode === "starting") return pendingExec;
      return ID;
    },
    execState: async () => { calls.state++; assert.fail("resource must not inspect Docker"); },
    logsSince: async () => { calls.log++; return ["uploaded 10 files", "fixture-secret", "password=unknown-secret"]; },
    resolveIncidents: async () => { calls.notify++; },
    sleep: () => new Promise(() => {}),
  });
  const handler = createMcpHandler(() => createServer({ confDir: dir, stackBack: false, manager }));
  t.after(() => handler.close());
  let id = 0;
  // Legacy HTTP wire format is used by deployed wrappers; no sockets/servers involved.
  async function rpc(method: string, params: Record<string, unknown> = {}) {
    const response = await handler.fetch(new Request("http://localhost/mcp", {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    }));
    assert.equal(response.status, 200);
    const body = await response.text();
    const data = body.split("\n").find((line) => line.startsWith("data: "))?.slice(6) ?? body;
    return JSON.parse(data);
  }
  async function result(method: string, params: Record<string, unknown> = {}) {
    const response = await rpc(method, params);
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    return response.result;
  }
  async function read(uri: string) {
    const value = await result("resources/read", { uri });
    assert.equal(value.contents.length, 1);
    assert.equal(value.contents[0].uri, uri);
    return JSON.parse(value.contents[0].text);
  }
  return { dir, manager, calls, rpc, result, read, releaseExec };
}

function textData(result: { content: { text: string }[]; structuredContent: unknown }) {
  const data = JSON.parse(result.content[0].text);
  assert.deepEqual(result.structuredContent, data, "structured data must match compatible text");
  return data;
}

test("initialize advertises instructions and native tools/resources/prompts; annotation inventory is explicit", async (t) => {
  const f = await fixture(t);
  const init = await f.result("initialize", {
    protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "offline-test", version: "1" },
  });
  assert.deepEqual(Object.keys(init.capabilities).sort(), ["prompts", "resources", "tools"]);
  assert.equal(init.capabilities.resources.subscribe, undefined);
  assert.match(init.instructions, /lost run is NOT known stopped/);
  assert.match(init.instructions, /quota is unknown/);
  assert.match(init.instructions, /retention\/pruning/);
  const tools = (await f.result("tools/list")).tools;
  assert.deepEqual(tools.map((tool: { name: string }) => tool.name), ["list_jobs", "run_backup", "run_status"]);
  for (const tool of tools) {
    const write = tool.name === "run_backup";
    assert.deepEqual(tool.annotations, { readOnlyHint: !write, destructiveHint: write, idempotentHint: !write, openWorldHint: write });
    assert.ok(tool.title && tool.description);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  assert.match(tools[1].description, /two Docker POSTs.*no automatic replay/);
  assert.match(tools[1].description, /delete archives/);
  assert.match(tools[2].description, /one bounded local Docker/);
  assert.match(tools[2].description, /Poll no faster/);
  assert.deepEqual(f.calls, { exec: 0, state: 0, log: 0, notify: 0 });
});

test("static guide is discoverable without template-list/instructions support and documents prompt costs/examples", async (t) => {
  const f = await fixture(t);
  const resources = (await f.result("resources/list")).resources;
  assert.deepEqual(resources.map((r: { uri: string }) => r.uri), ["backup://guide", "backup://jobs", "backup://runs/recent", "backup://status"]);
  const guide = await f.result("resources/read", { uri: "backup://guide" });
  const text = guide.contents[0].text;
  assert.equal(guide.contents[0].mimeType, "text/markdown");
  for (const fragment of ["backup://runs/{run}", "backup://runs/1", "inspect_before_run", '{"job":"hermes","run":"1"}', "zero", "quota", "lost", "retention"]) assert.ok(text.includes(fragment), fragment);
  const templates = (await f.result("resources/templates/list")).resourceTemplates;
  assert.equal(templates.length, 1);
  assert.equal(templates[0].uriTemplate, "backup://runs/{run}");
  const prompts = (await f.result("prompts/list")).prompts;
  assert.deepEqual(prompts.map((p: { name: string }) => p.name), ["inspect_before_run"]);
  const prompt = await f.result("prompts/get", { name: "inspect_before_run", arguments: { job: "demo", run: "1" } });
  assert.match(prompt.messages[0].content.text, /backup:\/\/runs\/1/);
  assert.match(prompt.messages[0].content.text, /Never automatically rerun/);
  assert.match(prompt.messages[0].content.text, /zero network calls/);
  assert.deepEqual(f.calls, { exec: 0, state: 0, log: 0, notify: 0 });
});

test("resource/template/prompt reads use only sanitized bounded local/cache context, never Docker or backups", async (t) => {
  const f = await fixture(t);
  const start = textData(await f.result("tools/call", { name: "run_backup", arguments: { job: "demo" } }));
  assert.equal(start.ok, true);
  assert.equal(start.run, 1);
  const before = { ...f.calls };
  const jobs = await f.read("backup://jobs");
  assert.deepEqual(jobs.jobs, [{ job: "demo", kind: "offen", schedule: "0 2 * * *" }]);
  const run = await f.read("backup://runs/1");
  assert.equal(run.state, "running");
  assert.equal(run.observedAt, undefined, "cache has not inspected Docker yet");
  const recent = await f.read("backup://runs/recent");
  assert.equal(recent.runs[0].run, 1);
  const status = await f.read("backup://status");
  assert.equal(status.policy.lostRetainsReservation, true);
  assert.equal(status.providerUsage.remaining, null);
  assert.equal(status.providerUsage.observedAt, null);
  assert.match(status.providerUsage.authority, /unknown/);
  assert.equal(status.reservation.run, 1);
  assert.match(status.source, /no Docker/);
  await f.result("prompts/get", { name: "inspect_before_run", arguments: { job: "demo" } });
  const listed = textData(await f.result("tools/call", { name: "list_jobs", arguments: {} }));
  assert.deepEqual(listed, jobs);
  const cached = textData(await f.result("tools/call", { name: "run_status", arguments: {} }));
  assert.equal(cached.runs.length, 1);
  assert.deepEqual(f.calls, before);
  const serialized = JSON.stringify([jobs, run, recent, status, listed, cached]);
  for (const hidden of ["fixture-secret", "hidden-hook", ID, "AWS_SECRET", "container", "startConfirmed"]) assert.ok(!serialized.includes(hidden), hidden);
  const logs = textData(await f.result("tools/call", { name: "run_status", arguments: { run: 1 } }));
  assert.match(logs.log.join("\n"), /uploaded 10 files/);
  assert.ok(!JSON.stringify(logs).includes("fixture-secret"));
  assert.ok(!JSON.stringify(logs).includes("unknown-secret"));
  assert.equal(f.calls.log, 1, "detail tool makes exactly one log read");
  assert.equal(f.calls.state, 0);
});

test("wire input validation rejects command/path/container injection and invalid ids before execution", async (t) => {
  const f = await fixture(t);
  const invalid = [
    ["run_backup", {}], ["run_backup", { job: "../demo" }], ["run_backup", { job: "demo; id" }],
    ["run_backup", { job: "demo\n" }], ["run_backup", { job: "x".repeat(64) }], ["run_backup", { job: 1 }],
    ["run_backup", { job: "demo", command: "touch /oops" }], ["run_backup", { job: "demo", container: "evil" }],
    ["run_status", { run: 0 }], ["run_status", { run: -1 }], ["run_status", { run: 1.5 }],
    ["run_status", { run: "1" }], ["run_status", { run: Number.MAX_SAFE_INTEGER + 1 }], ["run_status", { path: "/etc/passwd" }],
    ["list_jobs", { container: "evil" }],
  ];
  for (const [name, args] of invalid) {
    const response = await f.rpc("tools/call", { name, arguments: args });
    assert.ok(response.error || response.result.isError, JSON.stringify(args));
  }
  const missing = textData(await f.result("tools/call", { name: "run_backup", arguments: { job: "not-allowlisted" } }));
  assert.equal(missing.ok, false);
  assert.deepEqual(f.calls, { exec: 0, state: 0, log: 0, notify: 0 });
});

test("run template rejects unsafe/noncanonical/missing ids and never reads logs", async (t) => {
  const f = await fixture(t);
  await f.manager.start(loadJobs(f.dir, false)[0]);
  for (const uri of ["backup://runs/0", "backup://runs/-1", "backup://runs/1.5", "backup://runs/01", "backup://runs/%31", "backup://runs/1?log=1", "backup://runs/1#log", "backup://runs/9007199254740992", "backup://runs/2", "backup://runs/../../etc/passwd", "file:///etc/passwd"]) {
    const response = await f.rpc("resources/read", { uri });
    assert.ok(response.error, uri);
  }
  for (const args of [{ job: "../demo" }, { job: "demo", run: "0" }, { job: "demo", run: "1.5" }, { job: "demo", run: "9007199254740992" }, { job: "demo", run: "1", execute: "yes" }]) {
    const response = await f.rpc("prompts/get", { name: "inspect_before_run", arguments: args });
    assert.ok(response.error, JSON.stringify(args));
  }
  assert.equal(f.calls.exec, 1);
  assert.equal(f.calls.log, 0);
  assert.equal(f.calls.state, 0);
});

test("concurrent HTTP calls share the synchronous starting reservation across server instances", async (t) => {
  const f = await fixture(t, "starting");
  const first = f.result("tools/call", { name: "run_backup", arguments: { job: "demo" } });
  await setImmediate();
  assert.equal(f.manager.current()?.state, "starting");
  const others = await Promise.all(Array.from({ length: 6 }, () =>
    f.result("tools/call", { name: "run_backup", arguments: { job: "demo" } })));
  for (const other of others) {
    assert.equal(other.isError, true);
    assert.equal(textData(other).state, "starting");
  }
  assert.equal(f.calls.exec, 1);
  f.releaseExec(ID);
  assert.equal(textData(await first).ok, true);
});

test("lost/ambiguous wire response includes run id, isError and sanitized diagnostic; repeated start blocked", async (t) => {
  const f = await fixture(t, "lost");
  const result = await f.result("tools/call", { name: "run_backup", arguments: { job: "demo" } });
  assert.equal(result.isError, true);
  const start = textData(result);
  assert.equal(start.run, 1);
  assert.equal(start.state, "lost");
  assert.match(start.message, /HTTP 504/);
  assert.ok(!JSON.stringify(start).includes("fixture-secret"));
  assert.equal(start.finishedAt, undefined);
  const blocked = textData(await f.result("tools/call", { name: "run_backup", arguments: { job: "demo" } }));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.run, 1);
  assert.match(blocked.message, /lost does not mean stopped/);
  const status = await f.read("backup://status");
  assert.equal(status.reservation.state, "lost");
  assert.equal(f.calls.exec, 1);
});

test("job and run resources report truncation/retention and stay bounded", async (t) => {
  const f = await fixture(t, "failed");
  for (let i = 0; i < 105; i++) writeFileSync(join(f.dir, `j${i}.conf`), `AWS_S3_PATH=j${i}\nBACKUP_CRON_EXPRESSION=fixture-secret${"x".repeat(500)}\nAWS_SECRET_ACCESS_KEY=fixture-secret\n`);
  const jobs = await f.read("backup://jobs");
  assert.equal(jobs.jobs.length, 100);
  assert.equal(jobs.total, 106);
  assert.equal(jobs.truncated, true);
  assert.ok(jobs.jobs.every((j: { schedule: string }) => j.schedule.length <= 140));
  assert.ok(!JSON.stringify(jobs).includes("fixture-secret"));
  for (let i = 0; i < 55; i++) await f.manager.start(loadJobs(f.dir, false)[0]);
  const recent = await f.read("backup://runs/recent");
  assert.equal(recent.runs.length, 20);
  assert.equal(recent.runs[0].run, 55);
  assert.ok((await f.rpc("resources/read", { uri: "backup://runs/1" })).error);
  assert.equal(f.calls.log, 0);
  assert.equal(f.calls.state, 0);
  assert.equal(f.calls.notify, 0);
});
