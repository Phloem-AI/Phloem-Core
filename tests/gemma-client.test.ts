import assert from 'node:assert/strict'
import test from 'node:test'
import { GemmaApiError, GemmaClient, GemmaInputError, GemmaResponseError } from '../src/gemma/client.js'
import { RunBudget, RunCancelledError, ThreeConsecutiveGemmaFailuresError } from '../src/policy/run-budget.js'

const validPlan = {
  schemaVersion: '1',
  objectives: [
    {
      id: 'home-page',
      name: 'Home page',
      purpose: 'Check the home page',
      expectedOutcome: 'The main heading is visible',
      successCriteria: ['A main heading is visible'],
    },
  ],
}

function modelResponse(text: string, status = 200, headers?: HeadersInit): Response {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }),
    { status, ...(headers ? { headers } : {}) },
  )
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

test('Gemma client sends key only in header and validates objective plan JSON', async () => {
  const apiKey = 'never-put-this-in-the-request-body'
  let requestUrl = ''
  let requestBody = ''
  let requestKey = ''
  const client = new GemmaClient({
    apiKey,
    budget: fakeBudget(),
    fetchImpl: async (input, init) => {
      requestUrl = String(input)
      requestBody = String(init?.body)
      requestKey = new Headers(init?.headers).get('x-goog-api-key') ?? ''
      return modelResponse(JSON.stringify(validPlan))
    },
  })

  const plan = await client.deriveObjectives('Test the home page.', 'heading: Home')

  assert.equal(plan.objectives[0]?.id, 'home-page')
  assert.equal(requestKey, apiKey)
  assert.equal(requestUrl.includes(apiKey), false)
  assert.equal(requestBody.includes(apiKey), false)
  assert.equal(requestBody.includes('Test the home page.'), true)
  assert.equal(requestBody.includes('You are Gemma powering Phloem'), true)
})

test('Gemma client counts malformed structured output toward the three-failure stop', async () => {
  const client = new GemmaClient({
    apiKey: 'test-api-key',
    budget: fakeBudget(),
    fetchImpl: async () => modelResponse('{"schemaVersion":"1","objectives":[]}'),
  })

  await assert.rejects(client.deriveObjectives('Brief', 'Snapshot'), GemmaResponseError)
  await assert.rejects(client.deriveObjectives('Brief', 'Snapshot'), GemmaResponseError)
  await assert.rejects(client.deriveObjectives('Brief', 'Snapshot'), ThreeConsecutiveGemmaFailuresError)
})

test('Gemma HTTP errors expose status and retry guidance without echoing response bodies', async () => {
  const client = new GemmaClient({
    apiKey: 'test-api-key',
    budget: fakeBudget(),
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: { message: 'sensitive provider body' } }), {
        status: 429,
        headers: { 'retry-after': '12' },
      }),
  })

  await assert.rejects(client.deriveObjectives('Brief', 'Snapshot'), (error: unknown) => {
    assert.ok(error instanceof GemmaApiError)
    assert.equal(error.status, 429)
    assert.equal(error.retryAfterMs, 12_000)
    assert.equal(error.message.includes('sensitive provider body'), false)
    return true
  })
})

test('Gemma client rejects oversized context before sending a request', async () => {
  let requestCount = 0
  const client = new GemmaClient({
    apiKey: 'test-api-key',
    budget: fakeBudget(),
    fetchImpl: async () => {
      requestCount += 1
      return modelResponse(JSON.stringify(validPlan))
    },
  })

  await assert.rejects(client.deriveObjectives('Brief', 'x'.repeat(30_001)), GemmaInputError)
  assert.equal(requestCount, 0)
})

test('cancellation does not count as a failed Gemma request', async () => {
  const controller = new AbortController()
  controller.abort()
  const budget = fakeBudget()
  await assert.rejects(budget.runGemmaRequest(async () => 'unused', controller.signal), RunCancelledError)
  assert.equal(await budget.runGemmaRequest(async () => 'usable response'), 'usable response')
})

test('Gemma client refuses non-Gemma model identifiers', () => {
  assert.throws(
    () => new GemmaClient({ apiKey: 'test-api-key', model: 'gemini-3.8-flash', fetchImpl: fetch }),
    /only supports Google Gemma/,
  )
})