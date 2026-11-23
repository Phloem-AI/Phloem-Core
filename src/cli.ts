import { runSavedPlan } from './plans/run-saved-plan.js'

const HELP = `Phloem-AI

Usage:
  phloem-ai                         Start the MCP server
  phloem-ai run <plan-name|path>    Replay a saved test plan

Run options:
  --headed                 Show the Chromium window
  --headless               Run without a visible window (default)
  --storage-state <path>   Load Playwright storage state from the working directory
  --max-steps <number>     Limit total replay steps (default: 150)
  --shared-flows           Reuse one browser context across flows
  --no-evidence            Skip screenshots, traces, HAR, and fact dumps
  --json                   Print a machine-readable JSON result
  -h, --help               Show this help

Plans, run records, and evidence use the Phloem data directory. Set
PHLOEM_DATA_DIR to select a directory (it must be an absolute path).
`

type ParsedRunOptions = {
  planPathOrName: string
  headless: boolean
  storageStatePath?: string
  maxSteps: number
  isolatedFlows: boolean
  captureEvidence: boolean
  json: boolean
}

export async function runCli(args = process.argv.slice(2)): Promise<number | null> {
  if (args.length === 0) return null
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    process.stdout.write(HELP)
    return 0
  }
  if (args[0] !== 'run') {
    process.stderr.write(`Unknown command "${args[0]}".\n\n${HELP}`)
    return 2
  }
  if (args.slice(1).includes('--help') || args.slice(1).includes('-h')) {
    process.stdout.write(HELP)
    return 0
  }

  const parsed = parseRunOptions(args.slice(1))
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n\n${HELP}`)
    return 2
  }

  try {
    const { planPathOrName, json, ...options } = parsed
    const { planPath, runRecordPath, result } = await runSavedPlan({ planPathOrName, ...options })
    const flowResults = result.flows.map((flow) => ({
      flowId: flow.flowId,
      verdict: flow.verdict,
      steps: flow.steps.filter((step) => step.operation !== undefined).length,
      ...(flow.detail ? { detail: flow.detail } : {}),
    }))
    const output = {
      runId: result.runId,
      verdict: result.verdict,
      planPath,
      runRecordPath,
      flows: flowResults,
      evidencePaths: result.record.evidencePaths,
    }

    if (json) {
      process.stdout.write(JSON.stringify(output, null, 2) + '\n')
    } else {
      process.stdout.write(`Plan: ${planPath}\n`)
      process.stdout.write(`Verdict: ${result.verdict}\n`)
      for (const flow of flowResults) {
        process.stdout.write(`  ${flow.flowId}: ${flow.verdict} (${flow.steps} steps)${flow.detail ? ` — ${flow.detail}` : ''}\n`)
      }
      process.stdout.write(`Run record: ${runRecordPath}\n`)
      if (result.record.evidencePaths.length > 0) {
        process.stdout.write(`Evidence: ${result.record.evidencePaths.join(', ')}\n`)
      }
    }

    return result.verdict === 'passed' ? 0 : 1
  } catch (error) {
    const message = error instanceof Error ? error.message : 'An unexpected error occurred.'
    process.stderr.write(`Phloem plan run failed: ${message}\n`)
    return 2
  }
}

function parseRunOptions(args: string[]): ParsedRunOptions | { error: string } {
  let planPathOrName: string | undefined
  let headless = true
  let storageStatePath: string | undefined
  let maxSteps = 150
  let isolatedFlows = true
  let captureEvidence = true
  let json = false

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '--headed') {
      headless = false
      continue
    }
    if (arg === '--headless') {
      headless = true
      continue
    }
    if (arg === '--shared-flows') {
      isolatedFlows = false
      continue
    }
    if (arg === '--no-evidence') {
      captureEvidence = false
      continue
    }
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--plan' || arg === '--storage-state' || arg === '--max-steps') {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) return { error: `${arg} requires a value.` }
      index += 1
      if (arg === '--plan') {
        if (planPathOrName) return { error: 'Provide the plan name or path only once.' }
        planPathOrName = value
      } else if (arg === '--storage-state') {
        storageStatePath = value
      } else {
        const parsed = Number(value)
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) return { error: '--max-steps must be an integer from 1 to 500.' }
        maxSteps = parsed
      }
      continue
    }
    if (arg.startsWith('-')) return { error: `Unknown option "${arg}".` }
    if (planPathOrName) return { error: 'Provide exactly one plan name or path.' }
    planPathOrName = arg
  }

  if (!planPathOrName) return { error: 'Provide a saved plan name or path.' }
  return {
    planPathOrName,
    headless,
    ...(storageStatePath ? { storageStatePath } : {}),
    maxSteps,
    isolatedFlows,
    captureEvidence,
    json,
  }
}
