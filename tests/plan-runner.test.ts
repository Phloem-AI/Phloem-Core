import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import test, { after, before } from 'node:test'
import { loadPlan, savePlan, saveRunRecord } from '../src/artifacts/store.js'
import { runPlan } from '../src/plans/runner.js'
import type { Assertion, Flow, TestPlan } from '../src/contracts.js'

const SECRET = 'hush-token-q7Zx42'
const sandbox = mkdtempSync(join(tmpdir(), 'phloem-runner-'))
process.chdir(sandbox)
after(() => {
  try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* Windows may hold locks briefly */ }
})

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not bind fixture server.')
  return `http://127.0.0.1:${address.port}`
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

let baseUrl = ''

const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' })
  response.end(`<!doctype html><html><body>
    <h1>Phloem replay fixture</h1>
    <button id="go">Start checkout</button><p id="status">Waiting</p>
    <script>
      console.error('leaked ${SECRET}');
      document.querySelector('#go').addEventListener('click', () => {
        document.querySelector('#status').textContent = 'Checkout complete';
      });
    </script>
  </body></html>`)
})

before(async () => {
  baseUrl = await listen(server)
})

after(() => close(server))

function loadStep(purpose = 'page loads'): Flow['steps'][number] {
  return {
    op: { type: 'waitForVisible', target: { role: 'heading', name: 'Phloem replay fixture', exact: true }, timeoutMs: 4_000 },
    purpose,
    expect: [],
  }
}

function checkoutStep(): Flow['steps'][number] {
  return {
    op: { type: 'click', target: { role: 'button', name: 'Start checkout', exact: true } },
    purpose: 'start checkout',
    expect: [{ type: 'textVisible', text: 'Checkout complete', timeoutMs: 3_000 }],
  }
}

function buildPlan(overrides: {
  name?: string
  flows?: Flow[]
  globalAssertions?: Assertion[]
  origins?: string[] | null
} = {}): TestPlan {
  return {
    schemaVersion: '2',
    name: overrides.name ?? 'replay fixture',
    source: 'plan-runner test',
    startUrl: baseUrl,
    origins: overrides.origins ?? [baseUrl],
    flows: overrides.flows ?? [{ id: 'main', preconditions: [], steps: [loadStep(), checkoutStep()] }],
    globalAssertions: overrides.globalAssertions ?? [],
  }
}

test('plan replay is deterministic: identical verdicts across two runs', async () => {
  const plan = buildPlan()
  const first = await runPlan({ plan, captureEvidence: false, runId: 'det-run-one' })
  const second = await runPlan({ plan, captureEvidence: false, runId: 'det-run-two' })
  assert.equal(first.verdict, 'passed')
  assert.equal(second.verdict, 'passed')
  assert.deepEqual(
    second.flows.map((flow) => [flow.flowId, flow.verdict, flow.steps.length]),
    first.flows.map((flow) => [flow.flowId, flow.verdict, flow.steps.length]),
  )
  assert.equal(first.record.verdict, 'passed')
})

test('evidence is written per run and the seeded secret never reaches disk unmasked', async () => {
  const plan = buildPlan({ name: 'evidence fixture' })
  const result = await runPlan({ plan, captureEvidence: true, sensitiveValues: [SECRET], runId: 'evidence-run' })
  assert.equal(result.verdict, 'passed')

  const directory = join(sandbox, '.phloem', 'evidence', 'evidence-run')
  assert.ok(existsSync(directory), 'evidence directory must exist')
  const files = readdirSync(directory)
  assert.ok(files.includes('main.har'), 'HAR evidence is captured')
  assert.ok(files.includes('main-trace.zip'), 'trace evidence is captured')
  assert.ok(files.includes('main-final.png'), 'screenshot evidence is captured')
  assert.ok(files.includes('facts-main.json'), 'redacted fact dump is captured')

  const har = JSON.parse(readFileSync(join(directory, 'main.har'), 'utf8')) as { log?: { version?: string } }
  assert.ok(har.log?.version, 'HAR should contain a log structure')

  const factDump = readFileSync(join(directory, 'facts-main.json'), 'utf8')
  assert.ok(!factDump.includes(SECRET), 'seeded secret must be masked in fact dumps')
  assert.ok(factDump.includes('[redacted]'), 'redaction marker should be present in fact dumps')

  for (const relativePath of result.record.evidencePaths) {
    assert.ok(existsSync(join(sandbox, relativePath)), `evidence path exists: ${relativePath}`)
  }
})

test('a failed flow does not stop remaining flows', async () => {
  const failingFlow: Flow = {
    id: 'fails-first',
    preconditions: [],
    steps: [loadStep(), {
      op: { type: 'waitForVisible', target: { role: 'heading', name: 'Phloem replay fixture', exact: true }, timeoutMs: 500 },
      purpose: 'expect the impossible',
      expect: [{ type: 'textVisible', text: 'written nowhere on this page', timeoutMs: 300 }],
    }],
  }
  const plan = buildPlan({ flows: [failingFlow, { id: 'recovers', preconditions: [], steps: [loadStep()] }] })
  const result = await runPlan({ plan, captureEvidence: false, runId: 'independent-flows' })
  assert.equal(result.flows[0]?.verdict, 'assertion_failed')
  assert.equal(result.flows[1]?.verdict, 'passed')
  assert.equal(result.verdict, 'assertion_failed')
})

test('the overall run budget stops later flows with budget_stopped', async () => {
  const plan = buildPlan({ flows: [{ id: 'first', preconditions: [], steps: [loadStep(), checkoutStep()] }, { id: 'second', preconditions: [], steps: [loadStep()] }] })
  const result = await runPlan({ plan, captureEvidence: false, runId: 'budget-run', maxSteps: 2 })
  assert.equal(result.flows[0]?.verdict, 'passed')
  assert.equal(result.flows[1]?.verdict, 'budget_stopped')
  assert.equal(result.record.url, new URL(baseUrl).origin + '/')
})

test('failing preconditions stop their flow with recorded assertion results', async () => {
  const plan = buildPlan({
    flows: [{
      id: 'guarded',
      preconditions: [{ type: 'textVisible', text: 'this text is nowhere', timeoutMs: 200 }],
      steps: [loadStep()],
    }],
  })
  const result = await runPlan({ plan, captureEvidence: false, runId: 'precondition-run' })
  const flow = result.flows[0]
  assert.equal(flow?.verdict, 'assertion_failed')
  assert.equal(flow?.steps.length, 1)
  assert.equal(flow?.steps[0]?.purpose, 'preconditions')
  assert.equal(flow?.steps[0]?.assertions[0]?.pass, false)
  assert.ok(result.record.steps[0]?.purpose, 'preconditions row is persisted in the run record')
})

test('fact-based global assertions are evaluated continuously during a flow', async () => {
  const plan = buildPlan({ globalAssertions: [{ type: 'consoleErrorCount', max: 0 }] })
  const result = await runPlan({ plan, captureEvidence: false, runId: 'global-facts-run' })
  assert.equal(result.verdict, 'assertion_failed')
  const executedSteps = result.flows[0]?.steps.filter((step) => step.operation !== undefined) ?? []
  assert.ok(executedSteps.length < 2, `flow stops early after the global fact assertion fires (stopped after ${executedSteps.length})`)
  assert.ok(result.flows[0]?.detail?.includes('Global assertion failed'))

  const pageGlobals = await runPlan({
    plan: buildPlan({ globalAssertions: [{ type: 'titleIncludes', text: 'Correct title', timeoutMs: 200 }] }),
    captureEvidence: false,
    runId: 'global-page-run',
  })
  assert.equal(pageGlobals.verdict, 'assertion_failed')
})

test('flows share one browser when isolatedFlows is false', async () => {
  const secondFlow: Flow = {
    id: 'depends-on-first',
    preconditions: [{ type: 'textVisible', text: 'Checkout complete', timeoutMs: 3_000 }],
    steps: [loadStep()],
  }
  const shared = await runPlan({
    plan: buildPlan({ flows: [{ id: 'first', preconditions: [], steps: [loadStep(), checkoutStep()] }, secondFlow] }),
    captureEvidence: false,
    isolatedFlows: false,
    runId: 'shared-run',
  })
  assert.equal(shared.verdict, 'passed')

  const isolated = await runPlan({
    plan: buildPlan({ flows: [{ id: 'first', preconditions: [], steps: [loadStep(), checkoutStep()] }, secondFlow] }),
    captureEvidence: false,
    isolatedFlows: true,
    runId: 'isolated-run',
  })
  assert.equal(isolated.flows[1]?.verdict, 'assertion_failed', 'fresh per-flow contexts do not inherit earlier flow state')
})

test('run records keep operation provenance and store round-trips them', async () => {
  const plan = buildPlan({ name: 'provenance fixture' })
  const result = await runPlan({ plan, captureEvidence: false, runId: 'provenance-run' })
  assert.ok(result.record.steps.every((step) => step.operation !== undefined), 'every replayable step stores its operation')
  assert.equal(result.record.evidencePaths.length, 0, 'no evidence expected when captureEvidence is false')
  await saveRunRecord(result.record)
})

test('plans stay addressable by name across save/load and still replay', async () => {
  const plan = buildPlan({ name: 'Round-Trip Regression' })
  const saved = await savePlan(plan)
  const loaded = await loadPlan('round-trip-regression')
  assert.equal(loaded.plan.name, 'Round-Trip Regression')
  const rerun = await runPlan({ plan: loaded.plan, captureEvidence: false, runId: 'round-trip-run' })
  assert.equal(rerun.verdict, 'passed')
  assert.match(saved.path, /round-trip-regression\.json/)
})

test('policy-blocked steps yield policy_blocked verdicts and do not stop later flows', async () => {
  const externalServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><html><body><h1>Blocked destination</h1></body></html>')
  })
  const externalUrl = await listen(externalServer)
  try {
    const plan = buildPlan({
      name: 'policy fixture',
      flows: [
        { id: 'blocked-flow', preconditions: [], steps: [{ op: { type: 'navigate', url: externalUrl }, purpose: 'navigate outside the allowlist', expect: [] }] },
        { id: 'normal-flow', preconditions: [], steps: [loadStep()] },
      ],
    })
    const result = await runPlan({ plan, captureEvidence: false, runId: 'policy-run' })
    assert.equal(result.flows[0]?.verdict, 'policy_blocked')
    assert.equal(result.flows[1]?.verdict, 'passed')
    assert.equal(result.verdict, 'policy_blocked')
  } finally {
    await close(externalServer)
  }
})

test('flows without navigation targets yield action_failed', async () => {
  const plan: TestPlan = {
    schemaVersion: '2',
    name: 'no navigation',
    source: 'plan-runner test',
    origins: [baseUrl],
    flows: [{ id: 'ghost', preconditions: [], steps: [loadStep()] }],
    globalAssertions: [],
  }
  const result = await runPlan({ plan, captureEvidence: false, runId: 'ghost-run' })
  assert.equal(result.verdict, 'action_failed')
  assert.equal(result.flows[0]?.steps.length, 0)
})

test('plans with a relative first navigate fall back to step navigation when startUrl is missing', async () => {
  const plan: TestPlan = {
    schemaVersion: '2',
    name: 'first navigate',
    source: 'plan-runner test',
    origins: [baseUrl],
    flows: [{
      id: 'nav-flow',
      preconditions: [],
      steps: [{
        op: { type: 'navigate', url: baseUrl },
        purpose: 'navigate via step',
        expect: [{ type: 'textVisible', text: 'Phloem replay fixture', timeoutMs: 3_000 }],
      }],
    }],
    globalAssertions: [],
  }
  const result = await runPlan({ plan, captureEvidence: false, runId: 'first-navigate-run' })
  assert.equal(result.verdict, 'passed')
})
