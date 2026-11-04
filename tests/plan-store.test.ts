import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import test, { after } from 'node:test'
import {
  buildPlanFromRunRecord,
  evidenceRelativePath,
  loadPlan,
  loadRunRecord,
  listPlans,
  saveEvidenceArtifact,
  savePlan,
  saveRunRecord,
} from '../src/artifacts/store.js'
import { RunRecordSchema, TestPlanSchema } from '../src/contracts.js'

// Artifact paths are resolved against the server working directory; tests run in
// an isolated sandbox so the repo checkout is never polluted.
const sandbox = mkdtempSync(join(tmpdir(), 'phloem-store-'))
process.chdir(sandbox)
after(() => {
  try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* Windows may hold locks briefly */ }
})

function validPlan(name: string): Record<string, unknown> {
  return {
    schemaVersion: '2',
    name,
    source: 'plan-store test',
    startUrl: 'http://127.0.0.1:4545/',
    origins: ['http://127.0.0.1:4545'],
    flows: [{
      id: 'main',
      preconditions: [],
      steps: [{
        op: { type: 'navigate', url: 'http://127.0.0.1:4545/cart' },
        purpose: 'open cart',
        expect: [],
      }],
    }],
    globalAssertions: [],
  }
}

function validRecord(runId: string): Record<string, unknown> {
  return {
    schemaVersion: '2',
    runId,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    url: 'http://127.0.0.1:4545/cart',
    verdict: 'passed',
    steps: [{
      purpose: 'open cart',
      startedAt: '2026-01-01T00:00:00.100Z',
      durationMs: 42,
      operationOk: true,
      operationDetail: 'Navigate to /cart.',
      assertions: [],
    }],
    facts: [],
    evidencePaths: [],
  }
}

test('savePlan validates, persists, and refuses silent overwrites', async () => {
  const name = 'overwrite-probe'
  const saved = await savePlan(validPlan(name))
  assert.match(saved.path, /\.phloem\/plans\/schema-2\/overwrite-probe\.json/)
  const loaded = await loadPlan(name)
  assert.equal(loaded.plan.name, name)
  assert.equal(loaded.plan.flows[0]?.steps[0]?.purpose, 'open cart')
  await assert.rejects(() => savePlan(validPlan(name)), /already exists/)
})

test('savePlan rejects schemaVersion mismatches with an actionable error', async () => {
  await assert.rejects(
    () => savePlan({ ...validPlan('bad-version'), schemaVersion: '1' }),
    (error: unknown) => {
      const message = (error as Error).message
      return message.includes('Invalid TestPlan') && message.includes('schemaVersion')
    },
  )
})

test('loadPlan rejects unknown versions and missing files with actionable errors', async () => {
  const directory = join('.phloem', 'plans', 'schema-2')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'legacy.json'), JSON.stringify({ schemaVersion: '1', name: 'legacy' }))
  await assert.rejects(() => loadPlan('legacy'), /schemaVersion 1/)
  await assert.rejects(() => loadPlan('not-a-real-plan'), /Could not read plan/)
})

test('listPlans reports discoverable plans with schema versions', async () => {
  await savePlan(validPlan('discoverable-plan'))
  const plans = await listPlans()
  assert.ok(plans.some((plan) => plan.name === 'discoverable-plan' && plan.schemaVersion === '2'))
})

test('saveRunRecord persists a validated record that loadRunRecord can round-trip by runId', async () => {
  const runId = 'round-trip-record'
  const recordPath = await saveRunRecord(validRecord(runId))
  assert.match(recordPath, /\.phloem\/runs\//)
  const loaded = await loadRunRecord(runId)
  assert.equal(loaded.record.runId, runId)
  assert.equal(loaded.record.verdict, 'passed')
})

test('saveRunRecord rejects malformed records', async () => {
  await assert.rejects(() => saveRunRecord({ schemaVersion: '9' }), /Invalid RunRecord/)
})

test('evidence artifacts are redacted at write time', async () => {
  const secret = 'api-key-8Zw2P6mFq4'
  const runId = 'redaction-evidence'
  const textPath = await saveEvidenceArtifact(
    runId,
    'facts-main.json',
    JSON.stringify({ note: 'the key is api-key-8Zw2P6mFq4 and should never persist raw' }),
    [secret],
  )
  assert.equal(textPath, evidenceRelativePath(runId, 'facts-main.json'))
  const text = readFileSync(join(sandbox, textPath), 'utf8')
  assert.ok(text.includes('[redacted]'), 'redaction marker should be present')
  assert.ok(!text.includes(secret), 'seeded secret must be masked on disk')

  const bytes = new Uint8Array([0x00, 0x01, 0xff, 0xfe])
  const binaryPath = await saveEvidenceArtifact(runId, 'snap.bin', Buffer.from(bytes))
  assert.deepEqual([...readFileSync(join(sandbox, binaryPath))], [...bytes])
})

test('loadRunRecord rejects unreadable and malformed run records', async () => {
  await assert.rejects(() => loadRunRecord('definitely-missing-run-id'), /No persisted run record matches/)
})

test('buildPlanFromRunRecord preserves assertion definitions and flow provenance', async () => {
  const record = RunRecordSchema.parse({
    ...validRecord('provenance-record'),
    url: 'http://127.0.0.1:4545/cart',
    globalAssertions: [{ type: 'consoleErrorCount', max: 0 }],
    flows: [{ id: 'checkout', preconditions: [{ type: 'textVisible', text: 'Cart', timeoutMs: 100 }] }],
    steps: [{
      purpose: 'checkout',
      startedAt: '2026-01-01T00:00:00.100Z',
      durationMs: 42,
      operationOk: true,
      operationDetail: 'Navigate to /cart.',
      flowId: 'checkout',
      operation: { type: 'navigate', url: 'http://127.0.0.1:4545/cart' },
      expect: [{ type: 'textVisible', text: 'Cart', timeoutMs: 100 }],
      assertions: [{ pass: true, actual: true, detail: 'matched' }],
    }],
    // A third-party subresource origin must never widen the replay allowlist.
    facts: [{ kind: 'http', ts: '2026-01-01T00:00:00.100Z', method: 'GET', url: 'https://cdn.example.net/app.js', status: 200 }],
  })
  const plan = buildPlanFromRunRecord(record, 'reborn plan')
  assert.equal(plan.schemaVersion, '2')
  assert.deepEqual(plan.origins, ['http://127.0.0.1:4545'])
  assert.equal(plan.startUrl, 'http://127.0.0.1:4545/cart')
  assert.deepEqual(plan.globalAssertions, [{ type: 'consoleErrorCount', max: 0 }])
  assert.deepEqual(plan.flows[0]?.preconditions, [{ type: 'textVisible', text: 'Cart', timeoutMs: 100 }])
  assert.deepEqual(plan.flows[0]?.steps[0]?.expect, [{ type: 'textVisible', text: 'Cart', timeoutMs: 100 }])
  assert.equal(plan.flows[0]?.id, 'checkout')
  assert.ok(TestPlanSchema.safeParse(plan).success)
  const saved = await savePlan(plan)
  assert.match(saved.path, /reborn-plan\.json/)
})

test('buildPlanFromRunRecord falls back to a single flow for legacy records without flow provenance', async () => {
  const record = RunRecordSchema.parse({
    ...validRecord('legacy-provenance'),
    steps: [{
      purpose: 'go to cart',
      startedAt: '2026-01-01T00:00:00.100Z',
      durationMs: 10,
      operationOk: true,
      operationDetail: 'navigate',
      operation: { type: 'navigate', url: 'http://127.0.0.1:4545/cart' },
      assertions: [],
    }],
  })
  const plan = buildPlanFromRunRecord(record, 'legacy plan')
  assert.equal(plan.flows.length, 1)
  assert.equal(plan.flows[0]?.id, 'replayed-run-record')
  assert.deepEqual(plan.flows[0]?.steps[0]?.expect, [])
})

test('buildPlanFromRunRecord refuses records without operation provenance', async () => {
  const record = RunRecordSchema.parse(validRecord('legacy-record-no-ops'))
  assert.throws(() => buildPlanFromRunRecord(record, 'nope'), /no recorded operations to replay/)
})

test('punctuation-only plan names can be saved and loaded by name', async () => {
  await savePlan(validPlan('!!!'))
  const loaded = await loadPlan('!!!')
  assert.equal(loaded.plan.name, '!!!')
  const plans = await listPlans()
  assert.ok(plans.some((plan) => plan.name === '!!!'))
})

test('plans are human-readable JSON with no control characters leaking', async () => {
  const name = 'readable-plan'
  await savePlan(validPlan(name))
  const text = readFileSync(join('.phloem', 'plans', 'schema-2', `${name}.json`), 'utf8')
  assert.match(text, /"schemaVersion": "2"/)
})
