// Best-effort defense for diagnostics, not a general secret detector. Never expose job
// environments, hook commands, Docker exec payloads or notification credentials as context.
const SENSITIVE = /(?:secret|password|passwd|passphrase|token|credential|authorization|key|url|dsn)/i;
export const MAX_DIAGNOSTIC_CHARS = 1000;

export function sanitizer(...environments: Record<string, string | undefined>[]): (text: string, maxChars?: number) => string {
  const secrets = [...new Set(environments.flatMap((env) => Object.entries(env)
    .filter(([key, value]) => SENSITIVE.test(key) && value)
    .map(([, value]) => value!)))].sort((a, b) => b.length - a.length);
  return (text: string, maxChars = MAX_DIAGNOSTIC_CHARS) => {
    let safe = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
    for (const secret of secrets) {
      safe = safe.split(secret).join("[REDACTED]");
      safe = safe.split(encodeURIComponent(secret)).join("[REDACTED]");
    }
    safe = safe
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]")
      .replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, "$1 [REDACTED]")
      .replace(/\b([A-Z0-9_]{0,64}(?:SECRET|PASSWORD|PASSWD|PASSPHRASE|TOKEN|CREDENTIAL|AUTHORIZATION|KEY)[A-Z0-9_]{0,64}["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, "$1[REDACTED]")
      // Bounded scheme/key patterns avoid quadratic scans of enormous hook lines.
      .replace(/\b([a-z][a-z0-9+.-]{0,31}:\/\/)([^\s/"'<>]+)/gi, (url, scheme: string, authority: string) => {
        const at = authority.lastIndexOf("@");
        return at < 0 ? url : `${scheme}[REDACTED]@${authority.slice(at + 1)}`;
      })
      .replace(/(https?:\/\/[^\s?"'<>]+)\?[^\s"'<>]*/gi, "$1?[REDACTED]")
      .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED]")
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]");
    return safe.length > maxChars ? safe.slice(0, maxChars) + " [truncated]" : safe;
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
