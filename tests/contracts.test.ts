import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BrowserOperationSchema,
  FlowStepResponseSchema,
  ObjectivePlanSchema,
  ObjectiveVerdictSchema,
} from '../src/contracts.js'

test('objective plans accept valid objectives and reject more than 15', () => {
  const objective = {
    id: 'sign-in',
    name: 'Sign in',
    purpose: 'Exercise the sign-in flow',
    expectedOutcome: 'The dashboard is shown',
    successCriteria: ['A Dashboard heading is visible'],
  }
  assert.equal(ObjectivePlanSchema.parse({ schemaVersion: '1', objectives: [objective] }).objectives.length, 1)
  assert.equal(ObjectivePlanSchema.safeParse({ schemaVersion: '1', objectives: Array(16).fill(objective) }).success, false)
  assert.equal(ObjectivePlanSchema.safeParse({ schemaVersion: '1', objectives: [objective, objective] }).success, false)
})

test('browser operation schemas reject unknown operations and arbitrary extra fields', () => {
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

test('flow completion and verdict responses are strict and versioned', () => {
  assert.equal(FlowStepResponseSchema.safeParse({ schemaVersion: '1', kind: 'complete', summary: 'Done' }).success, true)
  assert.equal(FlowStepResponseSchema.safeParse({ schemaVersion: '2', kind: 'complete', summary: 'Done' }).success, false)
  assert.equal(
    ObjectiveVerdictSchema.safeParse({ schemaVersion: '1', status: 'passed', reason: 'Shown', evidence: [] }).success,
    true,
  )
  assert.equal(
    ObjectiveVerdictSchema.safeParse({ schemaVersion: '1', status: 'blocked', reason: 'Auth', evidence: [] }).success,
    false,
  )
})