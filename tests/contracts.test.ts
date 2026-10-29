import assert from 'node:assert/strict'
import test from 'node:test'
import { AssertionSchema, BrowserOperationSchema, TestPlanSchema, VerdictSchema } from '../src/contracts.js'

test('browser operations retain the allowlist and reject executable or extra fields', () => {
  assert.equal(
    BrowserOperationSchema.safeParse({ type: 'click', target: { role: 'button', name: 'Continue' } }).success,
    true,
  )
  assert.equal(BrowserOperationSchema.safeParse({ type: 'evaluate', code: 'alert(1)' }).success, false)
  assert.equal(
    BrowserOperationSchema.safeParse({
      type: 'click',
      target: { role: 'button', name: 'Continue' },
      javascript: 'alert(1)',
    }).success,
    false,
  )
})

test('assertion and plan schemas reject unknown types and malformed plans', () => {
  assert.equal(AssertionSchema.safeParse({ type: 'pageErrorCount', max: 0 }).success, true)
  assert.equal(AssertionSchema.safeParse({ type: 'evaluate', expression: '1 + 1' }).success, false)
  const plan = {
    schemaVersion: '2',
    name: 'Sign in',
    source: 'agent session',
    flows: [{
      id: 'sign-in',
      preconditions: [],
      steps: [{ purpose: 'Open the login form', op: { type: 'click', target: { role: 'button', name: 'Sign in' } }, expect: [] }],
    }],
    globalAssertions: [],
  }
  assert.equal(TestPlanSchema.safeParse(plan).success, true)
  assert.equal(TestPlanSchema.safeParse({ ...plan, schemaVersion: '1' }).success, false)
  assert.equal(VerdictSchema.safeParse('agent_passed').success, false)
})
