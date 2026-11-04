import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BrowserOperationSchema, RunRecordSchema, TestPlanSchema, type BrowserOperation, type RunRecord, type TestPlan } from '../contracts.js'
import { redactText } from '../security/redaction.js'

function workspacePath(path: string): string {
  const root = resolve(process.cwd())
  const target = resolve(root, path)
  if (target !== root && !target.startsWith(root + sep)) throw new Error('Artifact paths must stay inside the server working directory.')
  return target
}

export async function savePlan(plan: unknown, secrets: readonly string[] = []): Promise<{ path: string; plan: TestPlan }> {
  const parsed = TestPlanSchema.safeParse(plan)
  if (!parsed.success) throw new Error('Invalid TestPlan: ' + parsed.error.issues.map(i => i.message).join('; '))
  const directory = workspacePath('.phloem/plans/schema-2')
  await mkdir(directory, { recursive: true })
  const path = join(directory, safeName(parsed.data.name) + '.json')
  const content = redactText(JSON.stringify(parsed.data, null, 2), secrets) + '\n'
  await writeFile(path, content, { encoding: 'utf8', flag: 'wx' }).catch(async error => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    throw new Error('A plan with this name already exists; choose another name.')
  })
  return { path: '.phloem/plans/schema-2/' + basename(path), plan: parsed.data }
}

export async function loadPlan(pathOrName: string): Promise<{ path: string; plan: TestPlan }> {
  const path = pathOrName.endsWith('.json') ? workspacePath(pathOrName) : workspacePath('.phloem/plans/schema-2/' + safeName(pathOrName) + '.json')
  let raw: unknown
  try { raw = JSON.parse(await readFile(path, 'utf8')) } catch (error) { throw new Error('Could not read plan: ' + (error instanceof Error ? error.message : 'invalid JSON')) }
  const parsed = TestPlanSchema.safeParse(raw)
  if (!parsed.success) {
    const version = typeof raw === 'object' && raw !== null && 'schemaVersion' in raw ? String((raw as {schemaVersion: unknown}).schemaVersion) : 'missing'
    throw new Error('Invalid TestPlan schemaVersion or fields (received schemaVersion ' + version + '): ' + parsed.error.issues.map(i => i.message).join('; '))
  }
  return { path: '.phloem/plans/schema-2/' + basename(path), plan: parsed.data }
}

export async function listPlans(): Promise<Array<{ name: string; path: string; schemaVersion: string }>> {
  const directory = workspacePath('.phloem/plans/schema-2')
  await mkdir(directory, { recursive: true })
  const names = (await readdir(directory)).filter(name => name.endsWith('.json')).sort()
  const result = []
  for (const name of names) { const loaded = await loadPlan(join('.phloem/plans/schema-2', name)); result.push({ name: loaded.plan.name, path: loaded.path, schemaVersion: loaded.plan.schemaVersion }) }
  return result
}

export async function saveRunRecord(record: unknown, secrets: readonly string[] = []): Promise<string> {
  const parsed = RunRecordSchema.safeParse(record)
  if (!parsed.success) throw new Error('Invalid RunRecord: ' + parsed.error.issues.map(i => i.message).join('; '))
  const directory = workspacePath('.phloem/runs')
  await mkdir(directory, { recursive: true })
  const filename = new Date().toISOString().replaceAll(':','-') + '-' + safeName(parsed.data.runId) + '.json'
  await writeFile(join(directory, filename), redactText(JSON.stringify(parsed.data, null, 2), secrets) + '\n', 'utf8')
  return '.phloem/runs/' + filename
}

export async function loadRunRecord(pathOrRunId: string): Promise<{ path: string; record: RunRecord }> {
  let path: string
  if (pathOrRunId.endsWith('.json')) {
    path = pathOrRunId
  } else {
    const directory = workspacePath('.phloem/runs')
    let names: string[] = []
    try { names = (await readdir(directory)).filter(name => name.endsWith('.json')).sort() } catch { names = [] }
    const match = names.find(name => name.includes(safeName(pathOrRunId)))
    if (!match) throw new Error('No persisted run record matches runId "' + pathOrRunId + '" under .phloem/runs/.')
    path = join('.phloem/runs', match)
  }
  let raw: unknown
  try { raw = JSON.parse(await readFile(workspacePath(path), 'utf8')) } catch (error) { throw new Error('Could not read run record: ' + (error instanceof Error ? error.message : 'invalid JSON')) }
  const parsed = RunRecordSchema.safeParse(raw)
  if (!parsed.success) {
    const version = typeof raw === 'object' && raw !== null && 'schemaVersion' in raw ? String((raw as {schemaVersion: unknown}).schemaVersion) : 'missing'
    throw new Error('Invalid RunRecord schemaVersion or fields (received schemaVersion ' + version + '): ' + parsed.error.issues.map(i => i.message).join('; '))
  }
  return { path: toPosix('.phloem/runs/' + basename(path)), record: parsed.data }
}

export function buildPlanFromRunRecord(record: RunRecord, name: string, source?: string): TestPlan {
  const replayableSteps = record.steps.filter((step): step is typeof step & { operation: BrowserOperation } => Boolean(step.operation))
  if (!replayableSteps.length) {
    throw new Error('This run record has no recorded operations to replay; only runs persisted with operation provenance can be turned into a plan.')
  }
  const origins = new Set<string>()
  const addOrigin = (value: string): void => { try { origins.add(new URL(value).origin) } catch { /* ignore malformed URLs */ } }
  addOrigin(record.url)
  for (const fact of record.facts) {
    if (typeof fact === 'object' && fact !== null && 'kind' in fact && 'url' in fact) addOrigin(String((fact as { url: unknown }).url))
  }
  for (const step of replayableSteps) {
    if (step.operation.type === 'navigate') addOrigin(step.operation.url)
  }
  const startUrl = replayableSteps.find(step => step.operation.type === 'navigate')?.operation.type === 'navigate'
    ? replayableSteps.find(step => step.operation.type === 'navigate')!.operation.url
    : undefined
  const plan = {
    schemaVersion: '2' as const,
    name,
    source: source && source.trim().length > 0 ? source : 'Rebuilt from persisted run record ' + record.runId,
    ...(startUrl ? { startUrl } : {}),
    origins: [...origins].slice(0, 20),
    flows: [{ id: 'replayed-run-record', preconditions: [], steps: replayableSteps.map(step => ({
      op: step.operation,
      purpose: step.purpose.length > 0 ? step.purpose : 'replayed step',
      expect: [],
    })) }],
    globalAssertions: [],
  }
  const parsed = TestPlanSchema.safeParse(plan)
  if (!parsed.success) throw new Error('Could not construct a valid TestPlan from the run record: ' + parsed.error.issues.map(i => i.message).join('; '))
  return parsed.data
}

// Evidence artifacts live under .phloem/evidence/<run-id>/ in the server working
// directory. Text artifacts are redacted at write time; binary artifacts
// (trace.zip) cannot be safely text-redacted and are stored as produced by
// Playwright. Facts dumped here come from the FactStore, which already redacts
// at ingest; the second redaction pass guards against future ingest regressions.

export function evidenceRelativePath(runId: string, filename: string): string {
  return toPosix(`.phloem/evidence/${safeName(runId)}/${safeEvidenceFilename(filename)}`)
}

export function evidenceAbsolutePath(runId: string, filename: string): string {
  return workspacePath(evidenceRelativePath(runId, filename))
}

export async function saveEvidenceArtifact(
  runId: string,
  filename: string,
  content: string | Buffer,
  secrets: readonly string[] = [],
): Promise<string> {
  const relativePath = evidenceRelativePath(runId, filename)
  const path = workspacePath(relativePath)
  await mkdir(join(path, '..'), { recursive: true })
  const data = typeof content === 'string' ? redactText(content, secrets) + '\n' : content
  await writeFile(path, data)
  return relativePath
}

export async function redactEvidenceFile(relativePath: string, secrets: readonly string[] = []): Promise<string> {
  const path = workspacePath(relativePath)
  let text: string
  try { text = await readFile(path, 'utf8') } catch { return relativePath }
  const redacted = redactText(text, secrets)
  if (redacted !== text) await writeFile(path, redacted, 'utf8')
  return relativePath
}

function safeEvidenceFilename(value: string): string {
  const extension = value.includes('.') ? '.' + value.split('.').pop()! : ''
  const base = value.slice(0, extension ? value.length - extension.length : value.length)
  return safeName(base) + extension.toLowerCase().replace(/[^.a-z0-9]/g, '')
}

function toPosix(value: string): string {
  return value.split(sep).join('/')
}

function safeName(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || randomUUID() }
