import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { BrowserOperationSchema, RunRecordSchema, TestPlanSchema, type BrowserOperation, type RunRecord, type TestPlan } from '../contracts.js'
import { redactText } from '../security/redaction.js'
import { redactZipArchive } from './redact-archive.js'

export function getArtifactDirectory(): string {
  const configured = process.env.PHLOEM_DATA_DIR?.trim()
  if (configured) {
    if (!isAbsolute(configured)) throw new Error('PHLOEM_DATA_DIR must be an absolute path.')
    return resolve(configured)
  }

  const home = homedir()
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    const dataHome = localAppData && isAbsolute(localAppData) ? localAppData : join(home, 'AppData', 'Local')
    return join(dataHome, 'Phloem')
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Phloem')
  }
  const xdgDataHome = process.env.XDG_DATA_HOME
  const dataHome = xdgDataHome && isAbsolute(xdgDataHome) ? xdgDataHome : join(home, '.local', 'share')
  return join(dataHome, 'phloem')
}

function artifactPath(path: string): string {
  const configuredRoot = getArtifactDirectory()
  mkdirSync(configuredRoot, { recursive: true })
  const root = realpathSync(configuredRoot)
  const target = resolve(root, path)
  if (!isWithin(root, target)) throw new Error('Artifact paths must stay inside the Phloem data directory.')
  let existing = target
  while (true) {
    let found = false
    try {
      lstatSync(existing)
      found = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(existing)
      if (parent === existing) throw new Error('Could not resolve artifact path inside the Phloem data directory.')
      existing = parent
    }
    if (found) {
      // Resolving even a dangling symlink must fail closed rather than treating
      // it as a missing path and later creating files through it.
      if (!isWithin(root, realpathSync(existing))) throw new Error('Artifact paths must stay inside the Phloem data directory.')
      break
    }
  }
  return target
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path))
}

export async function savePlan(plan: unknown): Promise<{ path: string; plan: TestPlan }> {
  const parsed = TestPlanSchema.safeParse(plan)
  if (!parsed.success) {
    throw new Error('Invalid TestPlan: ' + parsed.error.issues.map(describeIssue).join('; '))
  }
  const directory = artifactPath('plans/schema-2')
  await mkdir(directory, { recursive: true })
  const path = join(directory, safeName(parsed.data.name) + '.json')
  const content = JSON.stringify(parsed.data, null, 2) + '\n'
  await writeFile(path, content, { encoding: 'utf8', flag: 'wx' }).catch(async error => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    throw new Error('A plan with this name already exists; choose another name.')
  })
  return { path: toPosix('plans/schema-2/' + basename(path)), plan: parsed.data }
}

export async function loadPlan(pathOrName: string): Promise<{ path: string; plan: TestPlan }> {
  const path = pathOrName.endsWith('.json') ? artifactPath(pathOrName) : artifactPath('plans/schema-2/' + safeName(pathOrName) + '.json')
  let raw: unknown
  try { raw = JSON.parse(await readFile(path, 'utf8')) } catch (error) { throw new Error('Could not read plan: ' + (error instanceof Error ? error.message : 'invalid JSON')) }
  const parsed = TestPlanSchema.safeParse(raw)
  if (!parsed.success) {
    const version = typeof raw === 'object' && raw !== null && 'schemaVersion' in raw ? String((raw as {schemaVersion: unknown}).schemaVersion) : 'missing'
    throw new Error('Invalid TestPlan schemaVersion or fields (received schemaVersion ' + version + '): ' + parsed.error.issues.map(describeIssue).join('; '))
  }
  return { path: toPosix('plans/schema-2/' + basename(path)), plan: parsed.data }
}

export async function listPlans(): Promise<Array<{ name: string; path: string; schemaVersion: string }>> {
  const directory = artifactPath('plans/schema-2')
  await mkdir(directory, { recursive: true })
  const names = (await readdir(directory)).filter(name => name.endsWith('.json')).sort()
  const result = []
  for (const name of names) {
    try {
      const loaded = await loadPlan(join('plans/schema-2', name))
      result.push({ name: loaded.plan.name, path: loaded.path, schemaVersion: loaded.plan.schemaVersion })
    } catch {
      // Corrupt files are surfaced by loading them directly; listing stays usable.
    }
  }
  return result
}

export async function saveRunRecord(record: unknown, secrets: readonly string[] = []): Promise<string> {
  const parsed = RunRecordSchema.safeParse(record)
  if (!parsed.success) throw new Error('Invalid RunRecord: ' + parsed.error.issues.map(describeIssue).join('; '))
  const directory = artifactPath('runs')
  await mkdir(directory, { recursive: true })
  const filename = new Date().toISOString().replaceAll(':','-') + '-' + safeName(parsed.data.runId) + '.json'
  await writeFile(join(directory, filename), redactText(JSON.stringify(redactSensitiveRunOperations(parsed.data, secrets), null, 2), secrets) + '\n', 'utf8')
  return 'runs/' + filename
}

export async function loadRunRecord(pathOrRunId: string): Promise<{ path: string; record: RunRecord }> {
  let path: string
  if (pathOrRunId.endsWith('.json')) {
    path = pathOrRunId
  } else {
    const directory = artifactPath('runs')
    let names: string[] = []
    try { names = (await readdir(directory)).filter(name => name.endsWith('.json')).sort() } catch { names = [] }
    const match = names.find(name => name.includes(safeName(pathOrRunId)))
    if (!match) throw new Error('No persisted run record matches runId "' + pathOrRunId + '" under runs/.')
    path = join('runs', match)
  }
  let raw: unknown
  try { raw = JSON.parse(await readFile(artifactPath(path), 'utf8')) } catch (error) { throw new Error('Could not read run record: ' + (error instanceof Error ? error.message : 'invalid JSON')) }
  const parsed = RunRecordSchema.safeParse(raw)
  if (!parsed.success) {
    const version = typeof raw === 'object' && raw !== null && 'schemaVersion' in raw ? String((raw as {schemaVersion: unknown}).schemaVersion) : 'missing'
    throw new Error('Invalid RunRecord schemaVersion or fields (received schemaVersion ' + version + '): ' + parsed.error.issues.map(describeIssue).join('; '))
  }
  return { path: toPosix('runs/' + basename(path)), record: parsed.data }
}

export function buildPlanFromRunRecord(record: RunRecord, name: string, source?: string): TestPlan {
  const replayableSteps = record.steps.filter((step): step is typeof step & { operation: BrowserOperation } => Boolean(step.operation))
  if (!replayableSteps.length) {
    throw new Error('This run record has no recorded operations to replay; only runs persisted with operation provenance can be turned into a plan.')
  }
  if (replayableSteps.some((step) => step.assertions.length > 0 && !step.expect)) {
    throw new Error('This legacy run record has assertion results but no assertion definitions; refusing to create a plan that could pass without checking the original conditions.')
  }
  if (!record.flows?.length && record.steps.some((step) => !step.operation && step.assertions.length > 0)) {
    throw new Error('This legacy run record has precondition results but no precondition definitions; refusing to create an incomplete plan.')
  }
  // Only approved top-level navigations define the replay allowlist. Subresource
  // facts (third-party scripts, failed requests) must never widen it.
  const origins = new Set<string>()
  const addOrigin = (value: string): void => { try { origins.add(new URL(value).origin) } catch { /* ignore malformed URLs */ } }
  if (record.origins?.length) {
    for (const origin of record.origins) addOrigin(origin)
  } else {
    addOrigin(record.url)
    for (const step of replayableSteps) {
      if (step.operationOk && step.operation.type === 'navigate') addOrigin(step.operation.url)
    }
  }
  let startUrl: string | undefined = record.startUrl
  if (!startUrl) {
    for (const step of replayableSteps) {
      if (step.operationOk && step.operation.type === 'navigate') { startUrl = step.operation.url; break }
    }
  }
  if (!startUrl) {
    // Sessions opened directly at a start URL record no navigate operation; the
    // final recorded URL is still a valid replay entry point.
    try { startUrl = new URL(record.url).href } catch { startUrl = undefined }
  }

  const toStep = (step: (typeof replayableSteps)[number]) => ({
    op: step.operation,
    purpose: step.purpose.trim().length > 0 ? step.purpose : 'replayed step',
    // Preserve the assertion definitions the original plan checked, not only results.
    expect: step.expect ?? [],
  })

  const hasFlowProvenance = record.steps.some((step) => step.flowId !== undefined)
  const flowProvenance = hasFlowProvenance && record.flows?.length ? record.flows : undefined
  const flows = flowProvenance
    ? flowProvenance
        .map((flow) => ({
          id: flow.id,
          preconditions: flow.preconditions,
          ...(flow.maxSteps !== undefined ? { maxSteps: flow.maxSteps } : {}),
          steps: replayableSteps.filter((step) => step.flowId === flow.id).map(toStep),
        }))
        .filter((flow) => flow.steps.length > 0)
    : [{
        id: 'replayed-run-record',
        preconditions: [],
        steps: replayableSteps.map(toStep),
      }]

  if (!flows.length) {
    throw new Error('This run record has flow metadata but no replayable operations for those flows.')
  }

  const plan = {
    schemaVersion: '2' as const,
    name,
    source: source && source.trim().length > 0 ? source : 'Rebuilt from persisted run record ' + record.runId,
    ...(startUrl ? { startUrl } : {}),
    origins: [...origins].slice(0, 20),
    flows,
    globalAssertions: record.globalAssertions ?? [],
  }
  const parsed = TestPlanSchema.safeParse(plan)
  if (!parsed.success) throw new Error('Could not construct a valid TestPlan from the run record: ' + parsed.error.issues.map(i => i.message).join('; '))
  return parsed.data
}

// Evidence artifacts live under evidence/<run-id>/ in the Phloem data directory.
// Every text artifact is redacted at write time, including the text
// entries inside zip-based archives such as trace.zip; binary entries are left
// intact. Facts dumped here come from the FactStore, which already redacts at
// ingest; the second redaction pass guards against future ingest regressions.

export function evidenceRelativePath(runId: string, filename: string): string {
  return toPosix(`evidence/${safeName(runId)}/${safeEvidenceFilename(filename)}`)
}

export function evidenceAbsolutePath(runId: string, filename: string): string {
  return artifactPath(evidenceRelativePath(runId, filename))
}

export async function ensureEvidenceDirectory(runId: string): Promise<void> {
  await mkdir(artifactPath(`evidence/${safeName(runId)}`), { recursive: true })
}

export async function saveEvidenceArtifact(
  runId: string,
  filename: string,
  content: string | Buffer,
  secrets: readonly string[] = [],
): Promise<string> {
  const relativePath = evidenceRelativePath(runId, filename)
  const path = artifactPath(relativePath)
  await mkdir(join(path, '..'), { recursive: true })
  const data = typeof content === 'string' ? redactText(content, secrets) + '\n' : content
  await writeFile(path, data)
  return relativePath
}

export async function redactEvidenceFile(relativePath: string, secrets: readonly string[] = []): Promise<string | null> {
  const path = artifactPath(relativePath)
  let text: string
  try { text = await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    await unlink(path).catch((removeError: unknown) => {
      if ((removeError as NodeJS.ErrnoException).code !== 'ENOENT') throw removeError
    })
    throw new Error('Could not read evidence for redaction; the artifact was discarded.', { cause: error })
  }
  const redacted = redactText(text, secrets)
  if (redacted !== text) {
    try { await writeFile(path, redacted, 'utf8') } catch (error) {
      await unlink(path).catch((removeError: unknown) => {
        if ((removeError as NodeJS.ErrnoException).code !== 'ENOENT') throw removeError
      })
      throw new Error('Could not redact evidence; the artifact was discarded.', { cause: error })
    }
  }
  return relativePath
}

/** Redact the text entries of a zip-based evidence archive (for example trace.zip). */
export async function redactEvidenceArchive(relativePath: string, secrets: readonly string[] = []): Promise<string | null> {
  const path = artifactPath(relativePath)
  let content: Buffer
  try { content = await readFile(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    await unlink(path).catch((removeError: unknown) => {
      if ((removeError as NodeJS.ErrnoException).code !== 'ENOENT') throw removeError
    })
    throw new Error('Could not read evidence archive for redaction; the artifact was discarded.', { cause: error })
  }
  try {
    const redacted = redactZipArchive(content, secrets)
    if (redacted !== content) await writeFile(path, redacted)
  } catch {
    // Never retain or report a trace that could not be proven redacted.
    await unlink(path).catch((removeError: unknown) => {
      if ((removeError as NodeJS.ErrnoException).code !== 'ENOENT') throw removeError
    })
    return null
  }
  return relativePath
}

function safeEvidenceFilename(value: string): string {
  const extension = value.includes('.') ? '.' + value.split('.').pop()! : ''
  const base = value.slice(0, extension ? value.length - extension.length : value.length)
  return safeName(base) + extension.toLowerCase().replace(/[^.a-z0-9]/g, '')
}

function describeIssue(issue: { path: ReadonlyArray<string | number | symbol>; message: string }): string {
  return (issue.path.length > 0 ? issue.path.map(String).join('.') + ': ' : '') + issue.message
}

function redactSensitiveRunOperations(record: RunRecord, secrets: readonly string[]): RunRecord {
  return {
    ...record,
    steps: record.steps.map((step) => step.operation?.type === 'fill' && isSensitiveField(step.operation.target.name, step.operation.value, secrets)
      ? { ...step, operation: { ...step.operation, value: '[redacted]' } }
      : step),
  }
}

function isSensitiveField(name: string, value: string, secrets: readonly string[]): boolean {
  return /password|passcode|secret|token|credential|api\s*key|username|user\s*name|email/i.test(name)
    || secrets.some((secret) => secret.length > 0 && value.includes(secret))
}

function toPosix(value: string): string {
  return value.split(sep).join('/')
}

function safeName(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80)
  // Deterministic fallback: a name with no alphanumerics (for example "!!!") must
  // map to the same file on save and load, so never fall back to a random value.
  return slug || 'item-' + createHash('sha256').update(value).digest('hex').slice(0, 16)
}
