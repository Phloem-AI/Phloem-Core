import assert from 'node:assert/strict'
import test from 'node:test'
import { GemmaApiError, GemmaClient, GemmaResponseError } from '../src/gemma/client.js'
import { RunBudget, ThreeConsecutiveGemmaFailuresError } from '../src/policy/run-budget.js'

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