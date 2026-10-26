#!/usr/bin/env node

// Entry point: serve createServer() over Streamable HTTP (the default here, for running
// next to the backup containers) or stdio (MCP_TRANSPORT=stdio). All of the protocol
// handling is the MCP SDK's; this file only picks a transport.

import { serve } from "@hono/node-server";
import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { Context } from "hono";
import { createServer, SERVER_NAME, VERSION } from "./server.js";

const transport = (process.env.MCP_TRANSPORT ?? "http").toLowerCase();

if (transport === "stdio") {
  serveStdio(() => createServer());
  console.error(`${SERVER_NAME} ${VERSION} running via stdio`);
} else if (transport === "http") {
  const port = Number(process.env.PORT ?? 8000);
  // Hostnames clients may use in the Host header (DNS-rebinding protection).
  const extraHosts = (process.env.MCP_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  const allowedHosts = extraHosts.length ? ["localhost", "127.0.0.1", ...extraHosts] : undefined;

  const handler = createMcpHandler(() => createServer());
  const app = createMcpHonoApp({ host: "0.0.0.0", allowedHosts });
  app.get("/health", (c) => c.json({ status: "ok", name: SERVER_NAME, version: VERSION }));
  const mcp = (c: Context) => handler.fetch(c.req.raw, { parsedBody: c.get("parsedBody") });
  app.all("/mcp", mcp);
  app.all("/", mcp);

  const httpServer = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) =>
    console.error(`${SERVER_NAME} ${VERSION} listening on http://0.0.0.0:${info.port}/mcp`),
  );
  const shutdown = async () => {
    await handler.close();
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} else {
  console.error(`ERROR: MCP_TRANSPORT must be "http" or "stdio", got "${transport}".`);
  process.exit(1);
}
