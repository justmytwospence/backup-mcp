# backup-mcp

An MCP server that re-runs [offen/docker-volume-backup](https://github.com/offen/docker-volume-backup)
jobs (and optionally a [stack-back](https://github.com/lawndoc/stack-back) run) on demand,
and does nothing else. It exists so an automation (here: n8n's alert cards, "🔁 back up
now") can redo a failed or stale backup without being handed Docker.

## Tools

| Tool | What it does |
|---|---|
| `list_jobs` | The runnable jobs: one per `conf.d/*.conf`, named by its `AWS_S3_PATH` (the bucket prefix, which is how backup alerts name a job), plus `stack-back` when enabled. Also the run in progress, if any. |
| `run_backup {job}` | Starts that job now, detached, exactly as its schedule would: `backup` in the backup container with the conf file's variables as its environment (offen's documented manual trigger), or stack-back's own cron command. One run at a time. Returns a run id. A run that exits 0 resolves the job's open incidents (`NOTIFY_URL`); a failed one is reported by the backup tool's own notifications, as on a schedule. |
| `run_status {run?}` | A run's state and exit code, plus the backup container's log lines since it started. Without an id: recent runs. |

There is no tool that takes a command, a path or a container name. A job name is looked
up in `conf.d`; anything else is refused.

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

See `compose.yaml`. **Security:** exec into the backup container is root-equivalent on
the host, because that container holds the Docker socket. The socket proxy stops this
server from touching images, volumes, networks or the system directly, but the real limit
is its interface. Expose it only on a private network, or behind an authenticating proxy.

## Development

```sh
npm install
npm test
```

Push a `vX.Y.Z` tag to publish `ghcr.io/justmytwospence/backup-mcp:X.Y.Z`, `:X.Y` and `:X`.
