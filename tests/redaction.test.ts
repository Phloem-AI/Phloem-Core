import assert from 'node:assert/strict'
import test from 'node:test'
import { extractSensitiveValues, redactText } from '../src/security/redaction.js'

test('credential-like brief values and email addresses are found and redacted from output', () => {
  const values = extractSensitiveValues('Demo username: sample-user, password: demo-pass. Contact qa@example.test.')
  assert.deepEqual(values, ['sample-user', 'demo-pass', 'qa@example.test'])
  assert.equal(redactText('Signed in as sample-user with demo-pass', values), 'Signed in as [redacted] with [redacted]')
})