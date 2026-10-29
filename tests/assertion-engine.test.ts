import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateAssertions } from '../src/assert/engine.js'
import { FactStore } from '../src/instrument/taps.js'

test('recorded HTTP, console, and page-error assertions are deterministic and bounded', async () => {
  const facts = new FactStore(() => [])
  facts.append({ kind: 'http', ts: '2026-01-01T00:00:00.000Z', method: 'POST', url: 'https://app.test/api/save', status: 500 })
  facts.append({ kind: 'console', ts: '2026-01-01T00:00:01.000Z', level: 'error', text: 'request failed' })
  facts.append({ kind: 'pageerror', ts: '2026-01-01T00:00:02.000Z', message: 'hydration failed' })
  const assertions = [
    { type: 'httpStatus', urlPattern: '/api/save' },
    { type: 'consoleErrorCount', max: 1 },
    { type: 'pageErrorCount', max: 0 },
  ] as const

  const first = await evaluateAssertions(assertions, { facts })
  const second = await evaluateAssertions(assertions, { facts })
  assert.deepEqual(first, second)
  assert.deepEqual(first.map((result) => result.pass), [false, true, false])
  assert.deepEqual(first[0]?.actual, [500])
  assert.equal(first[1]?.actual, 1)
  assert.match(first[2]?.detail ?? '', /exceeds maximum 0/)
})

test('HTTP assertions fail when there are no matching response facts', async () => {
  const result = await evaluateAssertions(
    [{ type: 'httpStatus', urlPattern: '/missing' }],
    { facts: new FactStore(() => []) },
  )
  assert.equal(result[0]?.pass, false)
  assert.deepEqual(result[0]?.actual, [])
  assert.match(result[0]?.detail ?? '', /No recorded HTTP responses/)
})

test('fact ring buffers expose dropped counts and preserve cursor-based deltas', () => {
  const facts = new FactStore(() => [])
  facts.append({ kind: 'console', ts: '2026-01-01T00:00:00.000Z', level: 'error', text: 'first' })
  const cursor = facts.length
  for (let index = 0; index < 105; index += 1) {
    facts.append({ kind: 'console', ts: '2026-01-01T00:00:01.000Z', level: 'error', text: `error ${index}` })
  }
  assert.equal(facts.droppedCounts().console, 6)
  assert.equal(facts.since(cursor).length, 100)
  assert.equal(facts.all().length, 100)
})
