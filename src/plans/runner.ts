import { randomUUID } from 'node:crypto'
import {
  AssertionSchema,
  RunRecordSchema,
  type Assertion,
  type AssertionResult,
  type RunRecord,
  type TestPlan,
  type Verdict,
} from '../contracts.js'
import { evaluateAssertions } from '../assert/engine.js'
import { BrowserSession } from '../browser/session.js'
import type { BrowserFact } from '../instrument/taps.js'
import { createNavigationPolicy, parseWebsiteUrl } from '../policy/url-policy.js'
import {
  evidenceAbsolutePath,
  evidenceRelativePath,
  redactEvidenceFile,
  saveEvidenceArtifact,
} from '../artifacts/store.js'

const POLICY_BLOCKED_PATTERN = /origin policy|Navigation target|subdomains/i
const FACT_BASED_ASSERTION_TYPES = new Set<Assertion['type']>(['httpStatus', 'consoleErrorCount', 'pageErrorCount'])
const DEFAULT_MAX_STEPS = 150

export interface PlanRunOptions {
  plan: TestPlan
  storageStatePath?: string
  /** Step budget for the whole run; each flow is additionally capped by its own maxSteps. */
  maxSteps?: number
  /** Fresh browser context per flow (default true). When false, flows share one session/state. */
  isolatedFlows?: boolean
  /** Write trace.zip, HAR, screenshots, and redacted fact dumps under .phloem/evidence/. */
  captureEvidence?: boolean
  sensitiveValues?: readonly string[]
  startAt?: string
  runId?: string
}

export type FlowRunResult = {
  flowId: string
  verdict: Verdict
  detail?: string
  preconditions: Array<RunRecord['steps'][number]['assertions'][number]>
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
 * Deterministic plan replay with no model in the loop. Plans are the spec: steps
 * execute one after another, assertions are evaluated against recorded facts and
 * the live page, and every artifact (run record + evidence) is written with a
 * redaction pass. This function is the CI entry point and the anti-bias fixture.
 */
export async function runPlan(options: PlanRunOptions): Promise<PlanRunResult> {
  const plan = options.plan
  const runId = options.runId ?? randomUUID()
  const startedAt = options.startAt ?? new Date().toISOString()
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
  const isolated = options.isolatedFlows ?? true
  const captureEvidence = options.captureEvidence ?? true
  const secrets = new Set<string>((options.sensitiveValues ?? []).filter((value) => value.length >= 3))
  if (secrets.size !== (options.sensitiveValues ?? []).filter((value) => value.length >= 3).length) {
    throw new Error('Sensitive values must be unique strings of at least 3 characters.')
  }

  const flows: FlowRunResult[] = []
  const factSeen = new Set<string>()
  const collectedFacts: BrowserFact[] = []
  const evidencePaths: string[] = []
  let finalUrl = ''
  let shared: SharedFlowSession | undefined

  for (const flow of plan.flows) {
    if (shared && collectedFacts.length) collectFacts(shared.session)

    const firstNavigate = flow.steps.find((step) => step.op.type === 'navigate')
    const rawStartUrl = plan.startUrl
      ?? (firstNavigate?.op.type === 'navigate' ? firstNavigate.op.url : undefined)
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
    if (exhaustedBudget(flows, maxStepsTotal(flows), maxSteps)) {
      flows.push({
        flowId: flow.id,
        verdict: 'budget_stopped',
        preconditions: [],
        steps: [],
        globalPageAssertions: [],
      })
      continue
    }

    const {
      session,
      evidenceNames,
      freshlyOpened,
    } = await acquireSession(shared ?? undefined, flow.id, isolated, {
      captureEvidence,
      runId,
      rawStartUrl,
      plan,
      storageStatePath: options.storageStatePath,
      secrets,
    })
    if (!shared && !isolated) shared = { session, evidenceNames }
    for (const secret of session.sensitiveValues) secrets.add(secret)

    try {
      const { flowVerdict, steps, preconditionResults, globalPageResults, reasons } = await executeFlow(session, flow, {
        captureEvidence,
        evidenceNames,
        alreadySpentSteps: maxStepsTotal(flows),
        maxSteps,
      })
      collectFacts(session)
      finalUrl = safeUrl(session.currentUrl)

      if (captureEvidence) {
        await captureFlowEvidence(session, flow.id, runId, evidenceNames, [...secrets], evidencePaths)
      }

      flows.push({
        flowId: flow.id,
        verdict: flowVerdict,
        ...(reasons.length > 0 ? { detail: reasons.join('; ') } : {}),
        preconditions: preconditionResults,
        steps,
        globalPageAssertions: globalPageResults,
      })
    } finally {
      if (freshlyOpened) await closeSession(session, evidenceNames.harPath, [...secrets], evidencePaths)
    }
  }

  if (shared) {
    collectFacts(shared.session)
    if (captureEvidence) await captureFlowEvidence(shared.session, 'shared-run', runId, shared.evidenceNames, [...secrets], evidencePaths)
    const harPath = shared.evidenceNames.harPath
    const evidenceNames = shared.evidenceNames
    shared = undefined
    await closeSession(shared0Session(evidenceNames), harPath, [...secrets], evidencePaths, evidenceNames)
  }

  const verdict = flowVerdictFor(flows)
  const endedAt = new Date().toISOString()
  const candidate = {
    schemaVersion: '2',
    runId,
    startedAt,
    endedAt,
    url: finalUrl,
    verdict,
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
// Shared session plumbing (per-flow context reuse when isolatedFlows is false)
// ---------------------------------------------------------------------------

type SharedFlowSession = {
  session: BrowserSession
  evidenceNames: { harPath?: string; tracePath?: string; harName?: string; traceName?: string }
}

function shared0Session(evidenceNames: SharedFlowSession['evidenceNames']): BrowserSession {
  throw new Error('shared session close is handled by placeSharedSessionClose')
}

function exhaustedBudget(previous: FlowRunResult[], spent: number, maxSteps: number): boolean {
  void previous
  return spent >= maxSteps
}

function maxStepsTotal(flows: FlowRunResult[]): number {
  return flows.reduce((sum, flow) => sum + flow.steps.filter((step) => step.operation !== undefined).length, 0)
}

function spentStepsInFlow(flow: FlowRunResult | undefined): number {
  return flow?.steps.filter((step) => step.operation !== undefined).length ?? 0
}

function collectFacts(session: BrowserSession): void {
  for (const fact of session.facts.all()) {
    const key = JSON.stringify(fact)
    if (!factSeen.has(key)) {
      factSeen.add(key)
      collectedFactsPush(fact)
    }
  }
}

function collectedFactsPush(fact: BrowserFact): void {
  collectedFacts.push(fact)
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
