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
    const text = await readBounded(res, 4096).then(({ buf }) => buf.toString("utf8")).catch(() => "");
    // Sanitized with the job's secret values at the public boundary, before display truncation.
    throw new Error(`docker ${method} ${path}: HTTP ${res.status} ${text}`);
  }
  return res;
}

const EXEC_ID = /^[a-f0-9]{64}(?![\s\S])/;
export const MAX_LOG_BYTES = 128 * 1024;

/** A start was attempted: even a timeout/HTTP error is NOT permission to replay it. */
export class ExecStartError extends Error {
  constructor(public readonly exec: string, cause: unknown) {
    super(`Docker exec start outcome unknown: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/** Start `cmd` in `container`, detached; never retries either POST. */
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
  if (!EXEC_ID.test(created.Id)) throw new Error("Docker exec create returned an invalid id; start was not attempted.");
  try {
    const started = await call("POST", `/exec/${created.Id}/start`, { Detach: true, Tty: false });
    await started.body?.cancel();
  } catch (error) {
    throw new ExecStartError(created.Id, error);
  }
  return created.Id;
}

export async function execState(id: string): Promise<{ running: boolean; exitCode: number | null }> {
  if (!EXEC_ID.test(id)) throw new Error("Invalid Docker exec id.");
  const j = (await (await call("GET", `/exec/${id}/json`)).json()) as { Running: boolean; ExitCode: number | null };
  if (typeof j.Running !== "boolean" || (j.ExitCode !== null && !Number.isInteger(j.ExitCode))) {
    throw new Error("Docker returned an invalid exec state.");
  }
  return { running: j.Running, exitCode: j.Running ? null : j.ExitCode };
}

/** A container's log lines since `sinceSec` (unix seconds), demultiplexed, last `tail`. */
export async function logsSince(container: string, sinceSec: number, tail = 40): Promise<string[]> {
  const res = await call(
    "GET",
    `/containers/${encodeURIComponent(container)}/logs?stdout=1&stderr=1&since=${Math.floor(sinceSec)}&tail=${tail}`,
  );
  // tail bounds lines at Docker, not bytes: a hook can still emit one enormous line.
  const { buf, truncated } = await readBounded(res, MAX_LOG_BYTES);
  const lines = demux(buf).split("\n").filter(Boolean).slice(-tail);
  return truncated ? ["(log response truncated at 128 KiB)", ...lines].slice(-tail - 1) : lines;
}

async function readBounded(res: Response, limit: number): Promise<{ buf: Buffer; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { buf: Buffer.alloc(0), truncated: false };
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value.subarray(0, limit - size)));
      size += value.length;
      if (size >= limit) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { buf: Buffer.concat(chunks), truncated };
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
