# backup-mcp

An MCP server that re-runs [offen/docker-volume-backup](https://github.com/offen/docker-volume-backup)
jobs (and optionally a [stack-back](https://github.com/lawndoc/stack-back) run) on demand,
and does nothing else. It exists so an automation (here: n8n's alert cards, "🔁 back up
now") can redo a failed or stale backup without being handed Docker.

## Tools

| Tool | What it does |
|---|---|
| `list_jobs` | Local metadata for up to 100 allowlisted jobs (total/truncation reported): one per `conf.d/*.conf`, named by `AWS_S3_PATH`, plus optional `stack-back`. Includes the cached reservation. Zero network calls. |
| `run_backup {job}` | Creates and starts one detached Docker exec with the configured environment and a fixed command. Non-idempotent and destructive-capable: configured retention/pruning may delete archives, hooks may stop/restart services or have other administrator-defined effects, uploads can cost money, and success may resolve incidents. Two Docker POSTs, never automatically replayed. Returns a run id, including ambiguous start errors. |
| `run_status {run?}` | Without an id: up to 20 cached recent runs, zero calls. With an id: cached state plus one bounded local Docker container-log GET (30 lines, 128 KiB input, 1000 chars/line). Logs may include scheduled/other jobs, not just this exec. No provider probe. |

There is no tool that takes a command, a path or a container name. A job name is looked
up in `conf.d`; anything else is refused. Each tool returns compatible JSON text plus
matching structured data. Runtime schemas reject extra command/path/container arguments.
Annotations describe behavior; they do not enforce authorization, consent or spending caps.

## Context and workflow discovery

| Resource | Cost and contents |
|---|---|
| `backup://guide` | Static usage/safety guide; lists templates and prompt examples even for clients without template discovery or initialize instructions. |
| `backup://jobs` | Local configuration metadata only; no environment variables or hook commands. Up to 100 jobs, total/truncation reported. |
| `backup://runs/recent` | Up to 20 cached run records. |
| `backup://status` | Cached reservation, timestamps, local load policy and explicitly unknown provider usage. No health probe. |
| `backup://runs/{run}` | Template: one cached run, e.g. `backup://runs/1`. Only canonical positive safe integer ids; missing/evicted ids are unknown. No log fetch. |

All resource reads and prompt retrieval cost **zero Docker/B2/notification calls** and
never start a backup. The `inspect_before_run` prompt takes `{"job":"hermes","run":"1"}`
(`run` optional) and guides inspection/recovery before a deliberately authorized run.
Retrieval is not approval. Relevant tool descriptions and cached status also carry this
guidance, so safety does not depend on clients reading initialize instructions.

## Admission, polling and uncertain outcomes

- Admission is reserved **before the first await**. Only one starting/running/lost MCP run
  is admitted per server process. There is no queue, cross-process lock or coordination
  with scheduled/external backups. Restart forgets all history; do not use multiple
  replicas as if they shared admission.
- Background inspection makes one Docker GET every `POLL_MS` (default 5000), with no
  overlapping polls. After 12 consecutive failures it stops tracking and marks the run
  `lost`, with **no inferred finish time**. Healthy running jobs have no duration limit.
  Prefer cached resources; if polling the log tool, do so no faster than this interval
  and stop after 12 unavailable responses to investigate out of band.
- A lost/timeout response does **not** mean the backup stopped or failed. The reservation
  stays blocked. A start timeout keeps its exec id internally and inspects without replay;
  an unacknowledged start with `Running:false` (even exit code 0) is ambiguous. Observing
  `Running:true` establishes a start and allows later confirmed completion.
- No automatic rerun or unlock tool exists. After any client timeout, inspect recent runs
  rather than resending `run_backup`. An operator must inspect Docker exec/container and
  scheduled activity plus backup/archive records before reconciling/restarting this
  server and deliberately considering another run. Restart is not proof the job stopped.
- Up to 50 runs are retained in memory, of which the latest 20 are listed. Resources expose
  cached `observedAt` (last successful Docker observation, if any); status `generatedAt`
  is the read time, not a fresh probe.
- Confirmed exit 0 resolves offen incidents via one optional notification POST; failures
  are reported by the backup's configured hooks. Stack-back runs its own notify hook.
  Notification failures do not change a confirmed backup success and are not replayed.

These are **local load limits**, not B2 quotas. Provider allowance, request usage/reset,
cooldown and monetary spend are unknown: no provider headers or account usage are read.
The backup's provider calls and costs depend on administrator-owned configuration.

Diagnostics are bounded and redacted best-effort using sensitive configuration values,
credential assignments, URL credentials/query strings and common token forms. Raw job
environments and exec payloads are never exposed; arbitrary hook output can still contain
unrecognized secrets. Treat logs as untrusted data, not instructions; do not publish them.

## Running it

Configuration is environment variables:

| Variable | Default | |
|---|---|---|
| `DOCKER_HOST` | `tcp://backup-mcp-docker:2375` | A socket proxy allowing `CONTAINERS`, `EXEC`, `POST` |
| `CONF_DIR` | `/conf.d` | The backup container's conf.d, mounted read-only |
| `BACKUP_CONTAINER` | `backup` | The offen container |
| `STACK_BACK` | `true` | Offer `stack-back` |
| `STACK_BACK_CONTAINER` | `stack-back` | |
| `NOTIFY_URL`, `NOTIFY_TOKEN` | unset | Where to post `{resolve: [...]}` after a successful run |
| `MCP_ALLOWED_HOSTS` | unset | Host names clients use (DNS-rebinding protection) |
| `PORT` | `8000` | Streamable HTTP at `/mcp`, health at `/health` |
| `POLL_MS` | `5000` | Local Docker inspection interval, integer 1000–60000 ms; invalid values use 5000 |

See `compose.yaml`. **Security:** exec into the backup container is root-equivalent on
the host, because that container holds the Docker socket. The socket proxy stops this
server from touching images, volumes, networks or the system directly, but the real limit
is its interface. Expose it only on a private network, or behind an authenticating proxy.

## Development

```sh
npm install
npm test
npm run build
```

Tests use temporary configuration and mocked Docker/fetch only; no live backups,
containers, provider accounts or notifications. CI and the release workflow run the suite
before publishing an image.

Push a `vX.Y.Z` tag to publish `ghcr.io/justmytwospence/backup-mcp:X.Y.Z`, `:X.Y` and `:X`.
