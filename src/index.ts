#!/usr/bin/env node
import { collectRunInputs, updateGemmaApiKey } from './cli/prompts.js'
import { GemmaClient } from './gemma/client.js'
import { RUN_LIMITS, RunBudget } from './policy/run-budget.js'
import { runExploration } from './runner/exploration.js'

function printHelp(): void {
  console.log('Usage: phloem [--headless=true|false] [--update-key | --help]')
  console.log('  --headless=false  Show the Chromium browser (default: headless)')
  console.log('  --headless=true   Run Chromium without a visible window')
  console.log('  --update-key      Replace the saved Gemma API key')
}

function parseHeadlessFlag(arguments_: string[]): { headless: boolean; remainingArguments: string[] } {
  const headlessArguments = arguments_.filter((argument) => argument.startsWith('--headless='))
  if (headlessArguments.length > 1) throw new Error('Pass the --headless option only once.')

  const remainingArguments = arguments_.filter((argument) => !argument.startsWith('--headless='))
  if (headlessArguments.length === 0) return { headless: true, remainingArguments }

  const value = headlessArguments[0]!.slice('--headless='.length)
  if (value !== 'true' && value !== 'false') {
    throw new Error('Use --headless=true or --headless=false.')
  }
  return { headless: value === 'true', remainingArguments }
}

async function main(arguments_: string[] = process.argv.slice(2)): Promise<void> {
  const { headless, remainingArguments } = parseHeadlessFlag(arguments_)
  if (remainingArguments.length === 1 && remainingArguments[0] === '--help') {
    printHelp()
    return
  }
  if (remainingArguments.length === 1 && remainingArguments[0] === '--update-key') {
    await updateGemmaApiKey()
    console.log('Gemma API key updated in the operating system credential store.')
    return
  }
  if (remainingArguments.length > 0) {
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
    const result = await runExploration(runInputs, { model: gemma, budget, headless }, controller.signal)
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