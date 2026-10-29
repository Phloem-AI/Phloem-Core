#!/usr/bin/env node
import { runMcpServer } from './mcp/server.js'

runMcpServer().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'An unexpected startup error occurred.'
  process.stderr.write(`Phloem MCP server failed to start: ${message}\n`)
  process.exitCode = 1
})
