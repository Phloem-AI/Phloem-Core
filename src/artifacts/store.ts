import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RunRecordSchema, TestPlanSchema, type RunRecord, type TestPlan } from '../contracts.js'
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
  const { readdir } = await import('node:fs/promises')
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

function safeName(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || randomUUID() }
