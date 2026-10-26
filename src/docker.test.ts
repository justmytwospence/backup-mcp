import { test } from "node:test";
import assert from "node:assert/strict";
import { execDetached, execState, logsSince, ExecStartError, MAX_LOG_BYTES } from "./docker.js";

const ID = "a".repeat(64);

test("Docker uses exactly create/start POSTs with fixed arguments; no automatic retry", async (t) => {
  const requests: { url: string; method: string; body: unknown }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    requests.push({ url, method: init.method!, body: JSON.parse(init.body as string) });
    assert.ok(init.signal);
    return requests.length === 1 ? Response.json({ Id: ID }) : new Response(null, { status: 200 });
  });
  assert.equal(await execDetached("configured/container", ["fixed", "command"], ["SECRET=fixture"]), ID);
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /\/containers\/configured%2Fcontainer\/exec$/);
  assert.deepEqual(requests[0].body, { Cmd: ["fixed", "command"], Env: ["SECRET=fixture"], AttachStdout: false, AttachStderr: false, Tty: false });
  assert.match(requests[1].url, new RegExp(`/exec/${ID}/start$`));
  assert.deepEqual(requests[1].body, { Detach: true, Tty: false });
  assert.ok(requests.every((r) => r.method === "POST"));
});

test("start timeout/HTTP error preserves exec id and never replays", async (t) => {
  for (const failure of [new Error("timeout"), new Response("not reachable", { status: 503 })]) {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      if (++calls === 1) return Response.json({ Id: ID });
      if (failure instanceof Error) throw failure;
      return failure;
    });
    await assert.rejects(execDetached("backup", ["fixed"], []), (error: unknown) => {
      assert.ok(error instanceof ExecStartError);
      assert.equal(error.exec, ID);
      assert.match(error.message, /outcome unknown/);
      return true;
    });
    assert.equal(calls, 2);
  }
});

test("invalid create payload/HTTP error cannot reach exec start", async (t) => {
  for (const response of [Response.json({ Id: "../another/exec" }), new Response("not found", { status: 404 })]) {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; return response; });
    await assert.rejects(execDetached("backup", ["fixed"], []), (error) => !(error instanceof ExecStartError));
    assert.equal(calls, 1);
  }
});

test("exec inspection validates path/payload and preserves unknown exit codes", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ Running: false, ExitCode: null });
  });
  await assert.rejects(execState("../escape"), /Invalid Docker exec id/);
  assert.equal(calls, 0);
  assert.deepEqual(await execState(ID), { running: false, exitCode: null });
  for (const payload of [{}, { Running: "false", ExitCode: 0 }, { Running: false, ExitCode: "0" }]) {
    t.mock.method(globalThis, "fetch", async () => Response.json(payload));
    await assert.rejects(execState(ID), /invalid exec state/);
  }
});

test("Docker logs bound upstream tail and byte consumption even for one enormous line", async (t) => {
  let cancelled = false;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.match(url, /\/containers\/backup\/logs\?stdout=1&stderr=1&since=123&tail=30$/);
    return new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(MAX_LOG_BYTES + 100).fill(120)); },
      cancel() { cancelled = true; },
    }));
  });
  const lines = await logsSince("backup", 123.9, 30);
  assert.ok(cancelled);
  assert.match(lines[0], /truncated/);
  assert.ok(lines.join("\n").length <= MAX_LOG_BYTES + 100);
});
