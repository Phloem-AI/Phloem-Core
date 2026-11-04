import { randomUUID } from 'node:crypto'
import type { Flow } from '../contracts.js'
import {
  RunRecordSchema,
  type Assertion,
  type AssertionResult,
  type BrowserOperation,
  type RunRecord,
  type TestPlan,
  type Verdict,
} from '../contracts.js'
import { evaluateAssertions } from '../assert/engine.js'
import { BrowserSession } from '../browser/session.js'
import type { BrowserFact } from '../instrument/taps.js'
import { createNavigationPolicy, parseWebsiteUrl } from '../policy/url-policy.js'
import { resolveWorkspacePath } from '../security/workspace.js'
import {
  ensureEvidenceDirectory,
  evidenceAbsolutePath,
  evidenceRelativePath,
  redactEvidenceArchive,
  redactEvidenceFile,
  saveEvidenceArtifact,
} from '../artifacts/store.js'

const POLICY_BLOCKED_PATTERN = /origin policy|Navigation target|subdomains/i
const FACT_BASED_ASSERTION_TYPES: ReadonlySet<Assertion['type']> = new Set(['httpStatus', 'consoleErrorCount', 'pageErrorCount'])
const DEFAULT_MAX_STEPS = 150

export interface PlanRunOptions {
  plan: TestPlan
  storageStatePath?: string
  /** Step budget for the whole run; each flow is additionally capped by its own maxSteps. */
  maxSteps?: number
  /** Fresh browser context per flow (default true). When false, flows share one browser and state. */
  isolatedFlows?: boolean
  /** Write trace.zip, HAR, screenshots, and redacted fact dumps under .phloem/evidence/. */
  captureEvidence?: boolean
  sensitiveValues?: readonly string[]
  runId?: string
  startedAt?: string
}

export type FlowRunResult = {
  flowId: string
  verdict: Verdict
  detail?: string
  preconditions: AssertionResult[]
  steps: RunRecord['steps']
  globalPageAssertions: AssertionResult[]
}

export interface PlanRunResult {
  runId: string
  verdict: Verdict
  flows: FlowRunResult[]
  secrets: string[]
  record: RunRecord
}

/**
 * Deterministic plan replay with no model in the loop. The plan is the spec and
 * is not re-negotiated by the model under test: steps execute sequentially, each
 * step's assertions are evaluated behind it, fact-based global assertions are
 * evaluated continuously, and page-based ones at flow end. A failed step stops
 * its flow but does not stop the remaining flows. This is the CI entry point.
 */
export async function runPlan(options: PlanRunOptions): Promise<PlanRunResult> {
  const plan = options.plan
  const runId = options.runId ?? randomUUID()
  const startedAt = options.startedAt ?? new Date().toISOString()
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
  const isolated = options.isolatedFlows ?? true
  const captureEvidence = options.captureEvidence ?? true
  // Validate the storage state boundary up front: a plan run must never read a
  // file outside the server working directory.
  const storageStatePath = options.storageStatePath ? await resolveWorkspacePath(options.storageStatePath) : undefined
  // Playwright writes HAR and trace data before post-processing. Avoid creating
  // raw archives for runs that can carry user values or authenticated state.
  const hasFillOperation = plan.flows.some((flow) => flow.steps.some((step) => step.op.type === 'fill'))
  const captureArchives = captureEvidence && !hasFillOperation && !storageStatePath

  const secrets = new Set<string>()
  const flows: FlowRunResult[] = []
  const evidencePaths: string[] = []
  const factSeen = new Set<string>()
  const collectedFacts: BrowserFact[] = []
  let finalUrl = ''
  const budget = { spent: 0 }
  let shared: { session: BrowserSession; evidence: FlowEvidenceNames } | undefined

  const collectFacts = (session: BrowserSession): void => {
    for (const fact of session.facts.all()) {
      const key = JSON.stringify(fact)
      if (!factSeen.has(key)) {
        factSeen.add(key)
        collectedFacts.push(fact)
      }
    }
  }

  for (const flow of plan.flows) {
    const firstNavigate = flow.steps.find((step) => step.op.type === 'navigate')
    const rawStartUrl = plan.startUrl ?? (firstNavigate?.op.type === 'navigate' ? firstNavigate.op.url : undefined)
    if (!rawStartUrl) {
      flows.push({
        flowId: flow.id,
        verdict: 'action_failed',
        detail: 'Neither the plan nor this flow provides a navigation target; the flow cannot start.',
        preconditions: [],
        steps: [],
        globalPageAssertions: [],
      })
      continue
    }
    if (budget.spent >= maxSteps) {
      flows.push({ flowId: flow.id, verdict: 'budget_stopped', preconditions: [], steps: [], globalPageAssertions: [] })
      continue
    }

    const sharedSession = !isolated && shared !== undefined ? shared : undefined
    const evidence = sharedSession?.evidence ?? flowEvidenceNames(flow.id)
    let session: BrowserSession | undefined
    const freshlyOpened = sharedSession === undefined
    if (freshlyOpened) {
      try {
        session = await openSession({
          rawStartUrl,
          plan,
          runId,
          captureEvidence: captureArchives,
          evidence,
          ...(storageStatePath ? { storageStatePath } : {}),
          ...(options.sensitiveValues ? { sensitiveValues: options.sensitiveValues } : {}),
        })
        if (!isolated) shared = { session, evidence }
      } catch (error) {
        flows.push({
          flowId: flow.id,
          verdict: 'action_failed',
          detail: 'Could not start the browser for this flow: ' + errorMessage(error).slice(0, 1500),
          preconditions: [],
          steps: [],
          globalPageAssertions: [],
        })
        continue
      }
    }

    const active = session ?? sharedSession!.session
    try {
      const outcome = await executeFlow(active, flow, { plan, budget, runBudget: maxSteps })
      flows.push({
        flowId: flow.id,
        verdict: outcome.verdict,
        ...(outcome.detail ? { detail: outcome.detail } : {}),
        preconditions: outcome.preconditions,
        steps: outcome.steps,
        globalPageAssertions: outcome.globalPageAssertions,
      })
    } catch (error) {
      flows.push({
        flowId: flow.id,
        verdict: 'action_failed',
        detail: errorMessage(error).slice(0, 2000),
        preconditions: [],
        steps: [],
        globalPageAssertions: [],
      })
    }
    addSecrets(secrets, active.sensitiveValues)
    try {
      collectFacts(active)
      finalUrl = safeUrl(active.currentUrl)
    } catch {
      // An unusable session still yields a record with whatever facts exist.
    }
    if (captureEvidence) {
      await captureFlowEvidence(active, flow.id, runId, [...secrets], evidencePaths).catch(() => undefined)
    }
    if (isolated) {
      await closeSession(active, runId, evidence, [...secrets], evidencePaths)
    }
  }

  if (shared) {
    try {
      collectFacts(shared.session)
      finalUrl = safeUrl(shared.session.currentUrl)
      if (captureEvidence) {
        await captureFlowEvidence(shared.session, 'shared', runId, [...secrets], evidencePaths)
      }
    } catch {
      // Best-effort roll-up for the shared session.
    }
    await closeSession(shared.session, runId, shared.evidence, [...secrets], evidencePaths)
  }

  const verdict = flowVerdictFor(flows)
  const candidate = {
    schemaVersion: '2',
    runId,
    startedAt,
    endedAt: new Date().toISOString(),
    url: finalUrl,
    verdict,
    startUrl: plan.startUrl ?? firstNavigateUrl(plan),
    origins: plan.origins,
    flows: plan.flows.map((flow, index) => ({
      id: flow.id,
      preconditions: flow.preconditions,
      ...(flow.maxSteps !== undefined ? { maxSteps: flow.maxSteps } : {}),
      ...(flows[index] ? {
        verdict: flows[index]!.verdict,
        ...(flows[index]!.detail ? { detail: flows[index]!.detail } : {}),
        globalPageAssertions: flows[index]!.globalPageAssertions,
      } : {}),
    })),
    globalAssertions: plan.globalAssertions,
    steps: flows.flatMap((flow) => flow.steps),
    facts: collectedFacts.map((fact) => ({ ...fact })),
    evidencePaths,
  }
  const parsed = RunRecordSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new Error('Plan execution produced an invalid run record: ' + parsed.error.issues.map((issue) => issue.message).join('; '))
  }
  return { runId, verdict, flows, secrets: [...secrets], record: parsed.data }
}

// ---------------------------------------------------------------------------
// Flow execution
// ---------------------------------------------------------------------------

type FlowOutcome = {
  verdict: Verdict
  detail?: string
  executedSteps: number
  preconditions: AssertionResult[]
  steps: RunRecord['steps']
  globalPageAssertions: AssertionResult[]
}

async function executeFlow(
  session: BrowserSession,
  flow: Flow,
  context: { plan: TestPlan; budget: { spent: number }; runBudget: number },
): Promise<FlowOutcome> {
  const assertionContext = { page: session.assertionPage, facts: session.facts }
  const steps: RunRecord['steps'] = []
  const reasons: string[] = []
  let verdict: Verdict = 'passed'
  let flowSteps = 0

  const preconditions = await evaluateAssertions(flow.preconditions, assertionContext)
  if (preconditions.length > 0) {
    steps.push({
      purpose: 'preconditions',
      startedAt: new Date().toISOString(),
      durationMs: 0,
      operationOk: true,
      operationDetail: 'Flow preconditions evaluated before the first step.',
      flowId: flow.id,
      assertions: preconditions,
    })
  }
  if (preconditions.some((result) => !result.pass)) {
    reasons.push('Preconditions failed: ' + preconditions.filter((result) => !result.pass).map(describeFailure).join(' | '))
    return { verdict: 'assertion_failed', detail: reasons.join(' '), executedSteps: 0, preconditions, steps, globalPageAssertions: [] }
  }

  const factBasedGlobals = context.plan.globalAssertions.filter((assertion) => FACT_BASED_ASSERTION_TYPES.has(assertion.type))
  const flowBudget = Math.min(flow.maxSteps ?? Number.POSITIVE_INFINITY, context.runBudget)

  for (const step of flow.steps) {
    if (flowSteps >= flowBudget || context.budget.spent + flowSteps >= context.runBudget) {
      if (verdict === 'passed') verdict = 'budget_stopped'
      reasons.push(`Step budget reached (${flow.maxSteps !== undefined ? `flow maxSteps ${flow.maxSteps}` : `run maxSteps ${context.runBudget}`}).`)
      break
    }
    flowSteps += 1
    const startedAt = new Date().toISOString()
    const began = Date.now()
    let operationOk = true
    let operationDetail = ''
    try {
      operationDetail = await session.execute(step.op)
    } catch (error) {
      operationOk = false
      operationDetail = errorMessage(error)
    }
    const assertions = operationOk ? await evaluateAssertions(step.expect, assertionContext) : []
    const factResults = factBasedGlobals.length > 0
      ? await evaluateAssertions(factBasedGlobals, assertionContext)
      : []
    steps.push({
      purpose: step.purpose,
      startedAt,
      durationMs: Date.now() - began,
      operationOk,
      operationDetail: session.facts.redact(operationDetail).slice(0, 2000),
      flowId: flow.id,
      operation: step.op as BrowserOperation,
      expect: step.expect,
      assertions,
    })
    if (!operationOk) {
      verdict = POLICY_BLOCKED_PATTERN.test(operationDetail) ? 'policy_blocked' : 'action_failed'
      reasons.push(`Step "${step.purpose}" failed: ${session.facts.redact(operationDetail).slice(0, 500)}`)
      const failingFactAssertion = factResults.find((result) => !result.pass)
      if (failingFactAssertion) {
        reasons.push(`Global assertion also failed after step "${step.purpose}": ${describeFailure(failingFactAssertion)}`)
      }
      break
    }
    const failingAssertion = assertions.find((result) => !result.pass)
    if (failingAssertion) {
      verdict = 'assertion_failed'
      reasons.push(`Step "${step.purpose}" assertion failed: ${describeFailure(failingAssertion)}`)
      break
    }
    const failingFactAssertion = factResults.find((result) => !result.pass)
    if (failingFactAssertion) {
      verdict = 'assertion_failed'
      reasons.push(`Global assertion failed after step "${step.purpose}": ${describeFailure(failingFactAssertion)}`)
      break
    }
  }

  const runBudgetExhausted = context.budget.spent + flowSteps >= context.runBudget && flowSteps > 0
  context.budget.spent += flowSteps
  if (runBudgetExhausted && verdict === 'passed' && flowSteps < flow.steps.length) {
    reasons.push(`Run step budget (${context.runBudget}) was reached.`)
  }

  const pageGlobals = context.plan.globalAssertions.filter((assertion) => !FACT_BASED_ASSERTION_TYPES.has(assertion.type))
  const globalPageAssertions = pageGlobals.length ? await evaluateAssertions(pageGlobals, assertionContext) : []
  if (globalPageAssertions.some((result) => !result.pass) && verdict === 'passed') {
    verdict = 'assertion_failed'
    reasons.push('Global assertion failed at flow end: ' + globalPageAssertions.filter((result) => !result.pass).map(describeFailure).join(' | '))
  }

  const detail = reasons.join(' ')
  return {
    verdict,
    ...(detail ? { detail: detail.slice(0, 2000) } : {}),
    executedSteps: flowSteps,
    preconditions,
    steps,
    globalPageAssertions,
  }
}

function describeFailure(result: AssertionResult): string {
  return `[${JSON.stringify(result.actual)}] ${result.detail}`.slice(0, 300)
}

// ---------------------------------------------------------------------------
// Session lifecycle + evidence
// ---------------------------------------------------------------------------

type FlowEvidenceNames = { har: string; trace: string }

function flowEvidenceNames(prefix: string): FlowEvidenceNames {
  return { har: `${prefix}.har`, trace: `${prefix}-trace.zip` }
}

function firstNavigateUrl(plan: TestPlan): string | undefined {
  for (const flow of plan.flows) {
    for (const step of flow.steps) {
      if (step.op.type === 'navigate') return step.op.url
    }
  }
  return undefined
}

function addSecrets(secrets: Set<string>, values: readonly string[]): void {
  for (const value of values) if (value.length >= 3) secrets.add(value)
}

async function openSession(options: {
  rawStartUrl: string
  plan: TestPlan
  runId: string
  captureEvidence: boolean
  evidence: FlowEvidenceNames
  storageStatePath?: string | undefined
  sensitiveValues?: readonly string[] | undefined
}): Promise<BrowserSession> {
  const startUrl = parseWebsiteUrl(options.rawStartUrl)
  if (options.captureEvidence) await ensureEvidenceDirectory(options.runId)
  return BrowserSession.open({
    startUrl,
    navigationPolicy: createNavigationPolicy(startUrl, '', options.plan.origins),
    ...(options.storageStatePath ? { storageStatePath: options.storageStatePath } : {}),
    ...(options.sensitiveValues ? { sensitiveValues: options.sensitiveValues } : {}),
    ...(options.captureEvidence
      ? {
          evidence: {
            harPath: evidenceAbsolutePath(options.runId, options.evidence.har),
            tracePath: evidenceAbsolutePath(options.runId, options.evidence.trace),
          },
        }
      : {}),
  })
}

async function captureFlowEvidence(
  session: BrowserSession,
  flowId: string,
  runId: string,
  secrets: readonly string[],
  evidencePaths: string[],
): Promise<void> {
  try {
    evidencePaths.push(await saveEvidenceArtifact(runId, `facts-${flowId}.json`, JSON.stringify(session.facts.all(), null, 2), secrets))
  } catch {
    // Fact dumping must never fail a run.
  }
  try {
    evidencePaths.push(await saveEvidenceArtifact(runId, `${flowId}-final.png`, await session.screenshot(), secrets))
  } catch {
    // An unusable session produces no screenshot; the verdict is unaffected.
  }
}

/** Close a session and finalize its trace/HAR evidence with a redaction pass. */
async function closeSession(
  session: BrowserSession,
  runId: string,
  evidence: FlowEvidenceNames,
  secrets: readonly string[],
  evidencePaths: string[],
): Promise<void> {
  let traceWritten = false
  try {
    traceWritten = await session.flushEvidence()
  } catch {
    traceWritten = false
  }
  const harPath = evidenceRelativePath(runId, evidence.har)
  try {
    await session.close()
  } catch {
    // Close failures must not mask the flow verdict, but evidence is still
    // redacted below whenever the files made it to disk.
  }
  if (traceWritten) {
    const tracePath = evidenceRelativePath(runId, evidence.trace)
    if (await redactEvidenceArchive(tracePath, secrets)) evidencePaths.push(tracePath)
  }
  const redacted = await redactEvidenceFile(harPath, secrets)
  if (redacted) evidencePaths.push(harPath)
}

function flowVerdictFor(flows: FlowRunResult[]): Verdict {
  const failing = flows.find((flow) => flow.verdict !== 'passed')
  return failing ? failing.verdict : 'passed'
}

function safeUrl(value: string): string {
  try {
    const parsed = new URL(value)
    return `${parsed.origin}${parsed.pathname}`.slice(0, 2048)
  } catch {
    return 'about:blank'
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'An unexpected error occurred.'
}
