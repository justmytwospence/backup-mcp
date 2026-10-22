// The little of the Docker Engine API this server uses: create and start an exec in a
// named container, read its exit code, and read that container's recent log lines.
// Talks to DOCKER_HOST (tcp://, normally a socket proxy that allows only containers and
// exec), never to a socket directly.

const API = "/v1.41";

function base(): string {
  const host = process.env.DOCKER_HOST ?? "tcp://backup-mcp-docker:2375";
  return host.replace(/^tcp:\/\//, "http://").replace(/\/+$/, "");
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const res = await fetch(base() + API + path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`docker ${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return res;
}

/** Start `cmd` in `container`, detached; returns the exec id. */
export async function execDetached(container: string, cmd: string[], env: string[]): Promise<string> {
  const created = (await (
    await call("POST", `/containers/${encodeURIComponent(container)}/exec`, {
      Cmd: cmd,
      Env: env,
      AttachStdout: false,
      AttachStderr: false,
      Tty: false,
    })
  ).json()) as { Id: string };
  await call("POST", `/exec/${created.Id}/start`, { Detach: true, Tty: false });
  return created.Id;
}

export async function execState(id: string): Promise<{ running: boolean; exitCode: number | null }> {
  const j = (await (await call("GET", `/exec/${id}/json`)).json()) as { Running: boolean; ExitCode: number | null };
  return { running: j.Running, exitCode: j.Running ? null : j.ExitCode };
}

/** A container's log lines since `sinceSec` (unix seconds), demultiplexed, last `tail`. */
export async function logsSince(container: string, sinceSec: number, tail = 40): Promise<string[]> {
  const res = await call(
    "GET",
    `/containers/${encodeURIComponent(container)}/logs?stdout=1&stderr=1&since=${Math.floor(sinceSec)}&tail=${tail}`,
  );
  const buf = Buffer.from(await res.arrayBuffer());
  return demux(buf).split("\n").filter(Boolean).slice(-tail);
}

/** Docker's multiplexed stream: 8-byte headers [stream, 0, 0, 0, size(4)], then payload. */
export function demux(buf: Buffer): string {
  let out = "";
  let i = 0;
  while (i + 8 <= buf.length && buf[i] <= 2 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 0) {
    const size = buf.readUInt32BE(i + 4);
    out += buf.subarray(i + 8, i + 8 + size).toString("utf8");
    i += 8 + size;
  }
  // A TTY container (no framing) or trailing bytes: take the rest as text.
  if (i < buf.length) out += buf.subarray(i).toString("utf8");
  return out;
}
