#!/usr/bin/env node
import { collectRunInputs, updateGemmaApiKey } from './cli/prompts.js'
import { GemmaClient } from './gemma/client.js'
import { RUN_LIMITS, RunBudget } from './policy/run-budget.js'
import { runExploration } from './runner/exploration.js'

function printHelp(): void {
  console.log('Usage: phloem [--update-key | --help]')
  console.log('  --update-key  Replace the saved Gemma API key')
}

async function main(arguments_: string[] = process.argv.slice(2)): Promise<void> {
  if (arguments_.length === 1 && arguments_[0] === '--help') {
    printHelp()
    return
  }
  if (arguments_.length === 1 && arguments_[0] === '--update-key') {
    await updateGemmaApiKey()
    console.log('Gemma API key updated in the operating system credential store.')
    return
  }
  if (arguments_.length > 0) {
    throw new Error('Unknown command. Use --help to see available commands.')
  }

  const runInputs = await collectRunInputs()
  console.warn('Phloem will automatically explore this website using its limited browser operation allowlist.')
  const controller = new AbortController()
  const onInterrupt = () => controller.abort()
  process.once('SIGINT', onInterrupt)

  try {
    const budget = new RunBudget()
    const gemma = new GemmaClient({ apiKey: runInputs.apiKey, budget })
    const result = await runExploration(runInputs, { model: gemma, budget }, controller.signal)
    printResult(result)
    if (result.status === 'incomplete' || result.objectives.some((objective) => objective.status === 'failed')) {
      process.exitCode = 1
    }
  } finally {
    process.removeListener('SIGINT', onInterrupt)
  }
}

function printResult(result: Awaited<ReturnType<typeof runExploration>>): void {
  console.log('\nPhloem smoke test results')
  for (const [index, objective] of result.objectives.entries()) {
    console.log(`\n${index + 1}. ${objective.name} [${objective.status}]`)
    console.log(`   Flow: ${objective.purpose}`)
    console.log(`   Expected: ${objective.expectedOutcome}`)
    console.log(`   Result: ${objective.reason}`)
    for (const evidence of objective.evidence) console.log(`   Evidence: ${evidence}`)
  }

  if (result.stopReason) console.error(`\nRun stopped: ${result.stopReason}`)
  else console.log(`\nAll planned objectives processed (limit: ${RUN_LIMITS.maxObjectives}).`)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'An unexpected setup error occurred.'
  console.error(`Phloem setup failed: ${message}`)
  process.exitCode = 1
})