import assert from 'node:assert/strict'
import test from 'node:test'
import { collectRunInputs, requireInteractiveTerminal, validateBrief, type PromptDependencies } from '../src/cli/prompts.js'

test('terminal setup refuses non-interactive input', () => {
  assert.throws(() => requireInteractiveTerminal({ isTTY: false }, { isTTY: true }), /interactive terminal/)
})

test('brief validation rejects empty and oversized content', () => {
  assert.notEqual(validateBrief('   '), true)
  assert.notEqual(validateBrief('x'.repeat(20_001)), true)
  assert.equal(validateBrief('Check that users can sign in.'), true)
})

test('setup saves a first-use key and returns validated run inputs without displaying the key', async () => {
  const savedKeys: string[] = []
  const warnings: string[] = []
  const prompts: string[] = []
  const dependencies: PromptDependencies = {
    readKey: () => undefined,
    saveKey: (apiKey) => savedKeys.push(apiKey),
    askForKey: async () => 'private-test-key',
    askForUrl: async () => 'https://example.test/login',
    askForBrief: async () => 'Test the sign-in flow.',
    writeWarning: (message) => warnings.push(message),
  }

  const result = await collectRunInputs(dependencies, () => prompts.push('terminal-checked'))

  assert.deepEqual(savedKeys, ['private-test-key'])
  assert.deepEqual(prompts, ['terminal-checked'])
  assert.equal(result.websiteUrl.pathname, '/login')
  assert.equal(result.brief, 'Test the sign-in flow.')
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0]?.includes('sent to Google Gemma'), true)
})

test('setup reuses a saved key without prompting or saving again', async () => {
  let keyPrompts = 0
  const dependencies: PromptDependencies = {
    readKey: () => 'already-stored-key',
    saveKey: () => assert.fail('Should not rewrite a stored key.'),
    askForKey: async () => {
      keyPrompts += 1
      return 'unexpected'
    },
    askForUrl: async () => 'http://localhost:4173',
    askForBrief: async () => 'Check the home page.',
    writeWarning: () => undefined,
  }

  const result = await collectRunInputs(dependencies, () => undefined)
  assert.equal(result.apiKey, 'already-stored-key')
  assert.equal(keyPrompts, 0)
})