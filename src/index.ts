#!/usr/bin/env node
import { runMcpServer } from './mcp/server.js'
import { runCli } from './cli.js'

async function main(): Promise<void> {
  const cliExitCode = await runCli()
  if (cliExitCode === null) {
    await runMcpServer()
  } else {
    process.exitCode = cliExitCode
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'An unexpected startup error occurred.'
  process.stderr.write(`Phloem failed to start: ${message}\n`)
  process.exitCode = 1
})
