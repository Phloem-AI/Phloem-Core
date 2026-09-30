import assert from 'node:assert/strict'
import test from 'node:test'
import { RUN_LIMITS, RunBudget, RunLimitError } from '../src/policy/run-budget.js'

test('Gemma requests are serialized and spaced at least six seconds apart', async () => {
  let now = 1_000
  let activeRequests = 0
  let maxConcurrentRequests = 0
  const starts: number[] = []
  const budget = new RunBudget({
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds
    },
  })
  const request = async () => {
    starts.push(now)
    activeRequests += 1
    maxConcurrentRequests = Math.max(maxConcurrentRequests, activeRequests)
    await Promise.resolve()
    activeRequests -= 1
    return starts.length
  }

  await Promise.all([budget.runGemmaRequest(request), budget.runGemmaRequest(request), budget.runGemmaRequest(request)])

  assert.equal(maxConcurrentRequests, 1)
  assert.ok(starts[1]! - starts[0]! >= RUN_LIMITS.minRequestIntervalMs)
  assert.ok(starts[2]! - starts[1]! >= RUN_LIMITS.minRequestIntervalMs)
})

test('operation and objective caps stop further work', () => {
  const budget = new RunBudget()
  budget.beginObjective()
  for (let operation = 0; operation < RUN_LIMITS.maxOperationsPerObjective; operation += 1) {
    budget.recordBrowserOperation()
  }
  assert.throws(() => budget.recordBrowserOperation(), RunLimitError)

  for (let objective = 1; objective < RUN_LIMITS.maxObjectives; objective += 1) budget.beginObjective()
  assert.throws(() => budget.beginObjective(), RunLimitError)
})