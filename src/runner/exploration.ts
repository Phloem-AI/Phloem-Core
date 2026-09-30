import type {
  FlowStepResponse,
  Objective,
  ObjectivePlan,
  ObjectiveVerdict,
} from '../contracts.js'
import {
  BrowserOperationError,
  BrowserRuntimeError,
  BrowserSession,
  type BrowserSessionOptions,
} from '../browser/session.js'
import { GemmaApiError, GemmaClient, GemmaResponseError } from '../gemma/client.js'
import {
  RunBudget,
  RunCancelledError,
  RunLimitError,
  ThreeConsecutiveGemmaFailuresError,
} from '../policy/run-budget.js'
import type { RunInputs } from '../cli/prompts.js'

export type ObjectiveRunResult = {
  id: string
  name: string
  purpose: string
  expectedOutcome: string
  status: 'passed' | 'failed' | 'not run'
  reason: string
  evidence: string[]
}

export type ExplorationResult = {
  status: 'completed' | 'incomplete'
  objectives: ObjectiveRunResult[]
  stopReason?: string
}

export interface ExplorationModel {
  deriveObjectives(brief: string, initialSnapshot: string, signal?: AbortSignal): Promise<ObjectivePlan>
  proposeNextOperation(
    brief: string,
    objective: Objective,
    currentSnapshot: string,
    runSummary: string,
    signal?: AbortSignal,
  ): Promise<FlowStepResponse>
  assessObjective(
    brief: string,
    objective: Objective,
    finalSnapshot: string,
    observedSteps: string[],
    signal?: AbortSignal,
  ): Promise<ObjectiveVerdict>
}

export interface BrowserSessionPort {
  readonly currentUrl: string
  observe(): Promise<string>
  execute(operation: ObjectiveOperation): Promise<string>
  captureTemporaryScreenshot(): Promise<Buffer | undefined>
  close(): Promise<void>
}

export type ObjectiveOperation = import('../contracts.js').BrowserOperation

export interface ExplorationDependencies {
  model?: ExplorationModel
  budget?: RunBudget
  openBrowser?: (options: BrowserSessionOptions) => Promise<BrowserSessionPort>
}

type ActiveObjective = {
  objective: Objective
  observedSteps: string[]
  snapshot: string
  actionFailure?: string
}

export async function runExploration(
  inputs: RunInputs,
  dependencies: ExplorationDependencies = {},
  signal?: AbortSignal,
): Promise<ExplorationResult> {
  const budget = dependencies.budget ?? new RunBudget()
  const model = dependencies.model ?? new GemmaClient({ apiKey: inputs.apiKey, budget })
  const openBrowser = dependencies.openBrowser ?? BrowserSession.open
  const results: ObjectiveRunResult[] = []
  let plan: ObjectivePlan | undefined
  let activeObjective: Objective | undefined
  let stopReason: string | undefined

  try {
    const discoverySnapshot = await withBrowser(openBrowser, {
      startUrl: inputs.websiteUrl,
      navigationPolicy: inputs.navigationPolicy,
      budget,
      signal,
    }, async (browser) => browser.observe())

    plan = await requestWithRetries(() => model.deriveObjectives(inputs.brief, discoverySnapshot, signal))

    for (const objective of plan.objectives) {
      activeObjective = objective
      budget.beginObjective()
      try {
        const result = await runObjective(objective, inputs, model, budget, openBrowser, results, signal)
        results.push(result)
        activeObjective = undefined
      } catch (error) {
        if (isRunStoppingError(error)) throw error
        throw new BrowserRuntimeError('An unexpected error stopped the exploration run.', { cause: error })
      }
    }
  } catch (error) {
    stopReason = safeText(errorMessage(error), inputs.apiKey)
    if (activeObjective && !results.some((result) => result.id === activeObjective?.id)) {
      results.push(notRunResult(activeObjective, stopReason))
    }
  }

  if (stopReason && plan) {
    const completedIds = new Set(results.map((result) => result.id))
    for (const objective of plan.objectives) {
      if (!completedIds.has(objective.id)) results.push(notRunResult(objective, stopReason))
    }
  }

  return {
    status: stopReason ? 'incomplete' : 'completed',
    objectives: results,
    ...(stopReason ? { stopReason } : {}),
  }
}

async function runObjective(
  objective: Objective,
  inputs: RunInputs,
  model: ExplorationModel,
  budget: RunBudget,
  openBrowser: (options: BrowserSessionOptions) => Promise<BrowserSessionPort>,
  previousResults: ObjectiveRunResult[],
  signal?: AbortSignal,
): Promise<ObjectiveRunResult> {
  const active: ActiveObjective = {
    objective,
    observedSteps: [],
    snapshot: '',
  }
  let completionSummary = ''

  return withBrowser(
    openBrowser,
    {
      startUrl: inputs.websiteUrl,
      navigationPolicy: inputs.navigationPolicy,
      budget,
      signal,
    },
    async (browser) => {
      active.snapshot = await browser.observe()

      while (true) {
        const response = await requestWithRetries(() =>
          model.proposeNextOperation(
            inputs.brief,
            objective,
            active.snapshot,
            summarizeResults(previousResults),
            signal,
          ),
        )

        if (response.kind === 'complete') {
          completionSummary = response.summary
          break
        }

        try {
          const operationSummary = await browser.execute(response.operation)
          active.observedSteps.push(safeText(operationSummary, inputs.apiKey))
        } catch (error) {
          if (error instanceof RunLimitError || error instanceof RunCancelledError || error instanceof BrowserRuntimeError) {
            throw error
          }
          active.actionFailure = errorMessage(error)
          active.observedSteps.push(`Operation failed: ${safeText(active.actionFailure, inputs.apiKey)}`)
        }

        active.snapshot = await browser.observe()

        if (active.actionFailure) {
          const screenshot = await browser.captureTemporaryScreenshot()
          if (screenshot) {
            active.observedSteps.push('A failure screenshot was captured temporarily and will not be retained.')
            screenshot.fill(0)
          }
          break
        }
      }

      const verdict = await requestWithRetries(() =>
        model.assessObjective(inputs.brief, objective, active.snapshot, active.observedSteps, signal),
      )
      const status = active.actionFailure ? 'failed' : verdict.status
      const reason = active.actionFailure ?? verdict.reason ?? completionSummary
      return {
        id: objective.id,
        name: objective.name,
        purpose: objective.purpose,
        expectedOutcome: objective.expectedOutcome,
        status,
        reason: safeText(reason, inputs.apiKey),
        evidence: verdict.evidence.map((item) => safeText(item, inputs.apiKey)),
      }
    },
  )
}

async function withBrowser<T>(
  openBrowser: (options: BrowserSessionOptions) => Promise<BrowserSessionPort>,
  options: BrowserSessionOptions,
  work: (browser: BrowserSessionPort) => Promise<T>,
): Promise<T> {
  const browser = await openBrowser(options)
  try {
    return await work(browser)
  } finally {
    await browser.close()
  }
}

async function requestWithRetries<T>(request: () => Promise<T>): Promise<T> {
  while (true) {
    try {
      return await request()
    } catch (error) {
      if (error instanceof ThreeConsecutiveGemmaFailuresError) throw error
      if (!(error instanceof GemmaApiError || error instanceof GemmaResponseError)) throw error
    }
  }
}

function summarizeResults(results: ObjectiveRunResult[]): string {
  return results
    .map((result) => `${result.id}: ${result.status} - ${result.reason}`)
    .join('\n')
    .slice(0, 10_000)
}

function notRunResult(objective: Objective, reason: string): ObjectiveRunResult {
  return {
    id: objective.id,
    name: objective.name,
    purpose: objective.purpose,
    expectedOutcome: objective.expectedOutcome,
    status: 'not run',
    reason: safeText(reason, ''),
    evidence: [],
  }
}

function safeText(value: string, apiKey: string): string {
  let sanitized = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
  if (apiKey.length > 0) sanitized = sanitized.replaceAll(apiKey, '[redacted]')
  return sanitized.slice(0, 1_000)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'An unexpected error occurred.'
}

function isRunStoppingError(error: unknown): boolean {
  return (
    error instanceof ThreeConsecutiveGemmaFailuresError ||
    error instanceof RunLimitError ||
    error instanceof RunCancelledError ||
    error instanceof BrowserRuntimeError
  )
}