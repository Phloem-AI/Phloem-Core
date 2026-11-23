import {
  loadPlan,
  saveRunRecord,
} from '../artifacts/store.js'
import {
  runPlan,
  type PlanRunOptions,
  type PlanRunResult,
} from './runner.js'

export interface RunSavedPlanOptions extends Omit<PlanRunOptions, 'plan'> {
  planPathOrName: string
}

export interface RunSavedPlanResult {
  planPath: string
  runRecordPath: string
  result: PlanRunResult
}

/** Load and replay a persisted plan, then store its validated run record. */
export async function runSavedPlan(options: RunSavedPlanOptions): Promise<RunSavedPlanResult> {
  const { plan, path } = await loadPlan(options.planPathOrName)
  const { planPathOrName: _planPathOrName, ...runOptions } = options
  const result = await runPlan({ ...runOptions, plan })
  const runRecordPath = await saveRunRecord(result.record, result.secrets)
  return { planPath: path, runRecordPath, result }
}
