import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserSessionOptions } from '../src/browser/session.js'
import type {
  BrowserOperation,
  FlowStepResponse,
  Objective,
  ObjectivePlan,
  ObjectiveVerdict,
} from '../src/contracts.js'
import type { RunInputs } from '../src/cli/prompts.js'
import {
  runExploration,
  type BrowserSessionPort,
  type ExplorationModel,
} from '../src/runner/exploration.js'
import { createNavigationPolicy, parseWebsiteUrl } from '../src/policy/url-policy.js'
import { RunBudget, ThreeConsecutiveGemmaFailuresError } from '../src/policy/run-budget.js'
import { GemmaResponseError } from '../src/gemma/client.js'

const cartObjective: Objective = {
  id: 'add-to-cart',
  name: 'Add an item to the cart',
  purpose: 'Exercise the add-to-cart flow',
  expectedOutcome: 'The cart count increases',
  successCriteria: ['The cart count shows one item'],
}

const searchObjective: Objective = {
  id: 'search',
  name: 'Search products',
  purpose: 'Search for a product',
  expectedOutcome: 'Matching products are shown',
  successCriteria: ['A matching product is visible'],
}

const plan: ObjectivePlan = { schemaVersion: '1', objectives: [cartObjective, searchObjective] }

function createInputs(brief = 'Test the cart and search flows.'): RunInputs {
  const websiteUrl = parseWebsiteUrl('http://127.0.0.1:4173/app')
  return {
    apiKey: 'test-api-key',
    websiteUrl,
    brief,
    navigationPolicy: createNavigationPolicy(websiteUrl, brief),
  }
}

class FakeBrowser implements BrowserSessionPort {
  currentUrl = 'http://127.0.0.1:4173/app'
  observations = 0
  closed = false
  operations: BrowserOperation[] = []

  async observe(): Promise<string> {
    this.observations += 1
    return JSON.stringify({ observation: this.observations })
  }

  async execute(operation: BrowserOperation): Promise<string> {
    this.operations.push(operation)
    return operation.type === 'fill' ? 'Filled input with [value omitted].' : `${operation.type} completed.`
  }

  async captureTemporaryScreenshot(): Promise<Buffer | undefined> {
    return Buffer.from('temporary-test-screenshot')
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

class FakeModel implements ExplorationModel {
  proposalCounts = new Map<string, number>()

  async deriveObjectives(): Promise<ObjectivePlan> {
    return plan
  }

  async proposeNextOperation(_brief: string, objective: Objective): Promise<FlowStepResponse> {
    const count = this.proposalCounts.get(objective.id) ?? 0
    this.proposalCounts.set(objective.id, count + 1)
    if (objective.id === 'add-to-cart' && count === 0) {
      return {
        schemaVersion: '1',
        kind: 'operation',
        purpose: 'Click Add to cart',
        operation: { type: 'click', target: { role: 'button', name: 'Add to cart', exact: true } },
      }
    }
    return { schemaVersion: '1', kind: 'complete', summary: 'The flow exploration is complete.' }
  }

  async assessObjective(_brief: string, objective: Objective): Promise<ObjectiveVerdict> {
    return {
      schemaVersion: '1',
      status: objective.id === 'add-to-cart' ? 'passed' : 'failed',
      reason: objective.id === 'add-to-cart' ? 'Cart count changed.' : 'No matching result was found.',
      evidence: ['The final page state was reviewed.'],
    }
  }
}

function fakeBudget(): RunBudget {
  let now = 1_000
  return new RunBudget({
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds
    },
  })
}

test('run explores objectives sequentially in fresh browsers and returns each Gemma verdict', async () => {
  const model = new FakeModel()
  const browsers: FakeBrowser[] = []
  const result = await runExploration(
    createInputs(),
    {
      model,
      budget: fakeBudget(),
      openBrowser: async (_options: BrowserSessionOptions) => {
        const browser = new FakeBrowser()
        browsers.push(browser)
        return browser
      },
    },
  )

  assert.equal(result.status, 'completed')
  assert.deepEqual(result.objectives.map((item) => item.status), ['passed', 'failed'])
  assert.equal(browsers.length, 3)
  assert.ok(browsers.every((browser) => browser.closed))
  assert.equal(browsers[1]?.operations.length, 1)
  assert.equal(browsers[2]?.operations.length, 0)
})

test('three consecutive Gemma failures stop the run and leave objectives not run', async () => {
  let requestCount = 0
  const model: ExplorationModel = {
    async deriveObjectives() {
      throw new GemmaResponseError(`invalid ${++requestCount}`)
    },
    async proposeNextOperation() {
      throw new Error('Not reached')
    },
    async assessObjective() {
      throw new Error('Not reached')
    },
  }
  const result = await runExploration(createInputs(), {
    model,
    budget: fakeBudget(),
    openBrowser: async () => new FakeBrowser(),
  })

  assert.equal(requestCount, 3)
  assert.equal(result.status, 'incomplete')
  assert.ok(result.stopReason?.includes('three consecutive'))
  assert.deepEqual(result.objectives, [])
})

test('demo credentials are redacted from model verdicts before terminal reporting', async () => {
  const model: ExplorationModel = {
    async deriveObjectives() {
      return { schemaVersion: '1', objectives: [searchObjective] }
    },
    async proposeNextOperation() {
      return { schemaVersion: '1', kind: 'complete', summary: 'Finished.' }
    },
    async assessObjective() {
      return {
        schemaVersion: '1',
        status: 'failed',
        reason: 'The login failed for sample-user with demo-pass.',
        evidence: ['Tried demo-pass.'],
      }
    },
  }
  const result = await runExploration(
    createInputs('Login username: sample-user, password: demo-pass. Then search.'),
    {
      model,
      budget: fakeBudget(),
      openBrowser: async () => new FakeBrowser(),
    },
  )

  assert.equal(result.objectives[0]?.reason.includes('demo-pass'), false)
  assert.equal(result.objectives[0]?.evidence[0]?.includes('demo-pass'), false)
})