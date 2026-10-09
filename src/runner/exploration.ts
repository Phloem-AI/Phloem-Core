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
  RUN_LIMITS,
  RunBudget,
  RunCancelledError,
  RunLimitError,
  GemmaFailureLimitError,
} from '../policy/run-budget.js'
import type { RunInputs } from '../cli/prompts.js'
import { extractSensitiveValues, redactText } from '../security/redaction.js'

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
  headless?: boolean
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
  const openBrowser =
    dependencies.openBrowser ??
    ((options: BrowserSessionOptions) =>
      BrowserSession.open({ ...options, headless: dependencies.headless ?? true }))
  const results: ObjectiveRunResult[] = []
  const sensitiveValues = [inputs.apiKey, ...extractSensitiveValues(inputs.brief)]
  let plan: ObjectivePlan | undefined
  let activeObjective: Objective | undefined
  let stopReason: string | undefined

  try {
    const discoverySnapshot = await withBrowser(openBrowser, {
      startUrl: inputs.websiteUrl,
      navigationPolicy: inputs.navigationPolicy,
      budget,
      ...(signal ? { signal } : {}),
      sensitiveValues,
    }, async (browser) => browser.observe())

    plan = await requestWithRetries(() => model.deriveObjectives(inputs.brief, discoverySnapshot, signal))

    for (const objective of plan.objectives) {
      activeObjective = objective
      budget.beginObjective()
      try {
        const result = await runObjective(objective, inputs, model, budget, openBrowser, results, sensitiveValues, signal)
        results.push(result)
        activeObjective = undefined
      } catch (error) {
        if (isRunStoppingError(error)) throw error
        throw new BrowserRuntimeError('An unexpected error stopped the exploration run.', { cause: error })
      }
    }
  } catch (error) {
    stopReason = redactText(errorMessage(error), sensitiveValues)
    if (activeObjective && !results.some((result) => result.id === activeObjective?.id)) {
      results.push(notRunResult(activeObjective, stopReason, sensitiveValues))
    }
  }

  if (stopReason && plan) {
    const completedIds = new Set(results.map((result) => result.id))
    for (const objective of plan.objectives) {
      if (!completedIds.has(objective.id)) results.push(notRunResult(objective, stopReason, sensitiveValues))
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
  sensitiveValues: string[],
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
      ...(signal ? { signal } : {}),
      sensitiveValues,
    },
    async (browser) => {
      active.snapshot = await browser.observe()

      while (true) {
        const response = await requestWithRetries(() =>
          model.proposeNextOperation(
            inputs.brief,
            objective,
            active.snapshot,
            summarizeProgress(previousResults, active.observedSteps),
            signal,
          ),
        )

        if (response.kind === 'complete') {
          completionSummary = response.summary
          break
        }

        try {
          const operationSummary = await browser.execute(response.operation)
          active.observedSteps.push(redactText(operationSummary, sensitiveValues))
        } catch (error) {
          if (error instanceof RunLimitError || error instanceof RunCancelledError || error instanceof BrowserRuntimeError) {
            throw error
          }
          active.actionFailure = errorMessage(error)
          active.observedSteps.push(`Operation failed: ${redactText(active.actionFailure, sensitiveValues)}`)
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
        status,
        name: redactText(objective.name, sensitiveValues),
        purpose: redactText(objective.purpose, sensitiveValues),
        expectedOutcome: redactText(objective.expectedOutcome, sensitiveValues),
        reason: redactText(reason, sensitiveValues),
        evidence: verdict.evidence.map((item) => redactText(item, sensitiveValues)),
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
  let consecutiveFailures = 0
  while (true) {
    try {
      return await request()
    } catch (error) {
      if (error instanceof GemmaFailureLimitError) throw error
      if (error instanceof GemmaApiError && error.status === 400) throw error
      if (!(error instanceof GemmaApiError || error instanceof GemmaResponseError)) throw error
      consecutiveFailures += 1
      if (consecutiveFailures >= RUN_LIMITS.maxConsecutiveGemmaFailures) {
        throw new GemmaFailureLimitError({ cause: error })
      }
    }
  }
}

function summarizeResults(results: ObjectiveRunResult[]): string {
  return results
    .map((result) => `${result.id}: ${result.status} - ${result.reason}`)
    .join('\n')
    .slice(0, 10_000)
}

function summarizeProgress(results: ObjectiveRunResult[], observedSteps: string[]): string {
  const previousObjectives = summarizeResults(results).slice(-3_000)
  const currentSteps = observedSteps.slice(-10).map((step, index) => `${index + 1}. ${step}`).join('\n').slice(-7_000)
  return [`Completed objectives:\n${previousObjectives}`, `Current flow actions:\n${currentSteps}`].join('\n\n').slice(-10_000)
}

function notRunResult(objective: Objective, reason: string, sensitiveValues: string[]): ObjectiveRunResult {
  return {
    id: redactText(objective.id, sensitiveValues),
    name: redactText(objective.name, sensitiveValues),
    purpose: redactText(objective.purpose, sensitiveValues),
    expectedOutcome: redactText(objective.expectedOutcome, sensitiveValues),
    status: 'not run',
    reason: redactText(reason, sensitiveValues),
    evidence: [],
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'An unexpected error occurred.'
}

function isRunStoppingError(error: unknown): boolean {
  return (
    error instanceof GemmaFailureLimitError ||
    error instanceof RunLimitError ||
    error instanceof RunCancelledError ||
    error instanceof BrowserRuntimeError
  )
}