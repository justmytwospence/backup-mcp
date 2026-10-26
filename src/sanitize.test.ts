import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizer } from "./sanitize.js";

test("known configured credentials redact raw and URL-encoded forms before bounding", () => {
  const safe = sanitizer({ B2_ACCOUNT_KEY: "fixture/key+secret", RESTIC_PASSWORD: "fixture pass" });
  const result = safe("upload HTTP 403 fixture/key+secret fixture%2Fkey%2Bsecret fixture pass");
  assert.match(result, /upload HTTP 403/);
  assert.equal((result.match(/\[REDACTED\]/g) ?? []).length, 3);
  assert.ok(!result.includes("fixture"));
  assert.ok(safe("x".repeat(50_000)).length <= 1012);
});

test("common raw log/error credential forms are redacted but operation details remain", () => {
  const text = [
    "HTTP 403: Access denied while uploading archive.tar.gz",
    'AWS_ACCESS_KEY_ID=AKIA1234567890123456 B2_APPLICATION_KEY="another fixture"',
    "RESTIC_PASSWORD='password with spaces' PASSPHRASE=private-fixture",
    'authorization: Bearer oauth-fixture, "token":"json-fixture"',
    "https://user:pass@example.invalid/archive?X-Amz-Signature=signature-fixture&expires=10",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
    "-----BEGIN PRIVATE KEY-----\nprivate payload\n-----END PRIVATE KEY-----",
    "\x1b[31mservice stopped\x1b[0m\x00",
  ].join("\n");
  const result = sanitizer()(text);
  for (const secret of ["AKIA1234567890123456", "another fixture", "password with spaces", "private-fixture", "oauth-fixture", "json-fixture", "user:pass", "signature-fixture", "eyJhbGciOiJIUzI1NiJ9", "private payload", "\x1b", "\x00"]) assert.ok(!result.includes(secret), secret);
  assert.match(result, /HTTP 403: Access denied while uploading archive.tar.gz/);
  assert.match(result, /example.invalid\/archive/);
  assert.match(result, /service stopped/);
});
