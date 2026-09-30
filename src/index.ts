#!/usr/bin/env node
import { collectRunInputs } from './cli/prompts.js'

async function main(): Promise<void> {
  const runInputs = await collectRunInputs()
  console.log(`Inputs validated for ${runInputs.websiteUrl.origin}.`)
  console.log('The browser exploration runner is the next implementation stage.')
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'An unexpected setup error occurred.'
  console.error(`Phloem setup failed: ${message}`)
  process.exitCode = 1
})