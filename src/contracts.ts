import { z } from 'zod'

export const LOCATOR_ROLES = [
  'button',
  'checkbox',
  'combobox',
  'heading',
  'link',
  'listitem',
  'menuitem',
  'option',
  'radio',
  'textbox',
] as const

export const LocatorSchema = z
  .object({
    role: z.enum(LOCATOR_ROLES),
    name: z.string().trim().min(1).max(200),
    exact: z.boolean().default(true),
  })
  .strict()

const NavigateOperationSchema = z
  .object({
    type: z.literal('navigate'),
    url: z.string().trim().min(1).max(2048),
  })
  .strict()

const GoBackOperationSchema = z.object({ type: z.literal('goBack') }).strict()

const UploadFilesOperationSchema = z
  .object({
    type: z.literal('uploadFiles'),
    label: z.string().trim().min(1).max(200).describe('Accessible label for the file input.'),
    files: z.array(z.string().trim().min(1).max(1000)).min(1).max(10),
  })
  .strict()

const TargetOperationSchema = z
  .object({
    type: z.enum(['click', 'check', 'uncheck']),
    target: LocatorSchema,
  })
  .strict()

const ScrollOperationSchema = z
  .object({
    type: z.literal('scroll'),
    direction: z.enum(['up', 'down']),
    amount: z.number().int().min(1).max(1200),
  })
  .strict()

const FillOperationSchema = z
  .object({
    type: z.literal('fill'),
    target: LocatorSchema,
    value: z.string().max(1000),
  })
  .strict()

const SelectOperationSchema = z
  .object({
    type: z.literal('select'),
    target: LocatorSchema,
    value: z.string().max(200),
  })
  .strict()

const PressOperationSchema = z
  .object({
    type: z.literal('press'),
    key: z.enum(['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']),
  })
  .strict()

const WaitForVisibleOperationSchema = z
  .object({
    type: z.literal('waitForVisible'),
    target: LocatorSchema,
    timeoutMs: z.number().int().min(100).max(15_000).default(5_000),
  })
  .strict()

export const BrowserOperationSchema = z.discriminatedUnion('type', [
  NavigateOperationSchema,
  GoBackOperationSchema,
  UploadFilesOperationSchema,
  TargetOperationSchema,
  ScrollOperationSchema,
  FillOperationSchema,
  SelectOperationSchema,
  PressOperationSchema,
  WaitForVisibleOperationSchema,
])

const AssertionTarget = z.object({
  role: z.enum(LOCATOR_ROLES),
  name: z.string().trim().min(1).max(200),
  exact: z.boolean().default(true),
})

const PatternSchema = z.string().trim().min(1).max(300)

function isHttpWebsiteUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && Boolean(url.hostname)
  } catch {
    return false
  }
}

function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return isHttpWebsiteUrl(value) && url.origin === value.replace(/\/$/, '')
  } catch {
    return false
  }
}

const WebsiteUrlSchema = z.string().url().refine(isHttpWebsiteUrl, 'Expected an absolute HTTP(S) URL without credentials.')
const HttpOriginSchema = z.string().url().refine(isHttpOrigin, 'Expected an HTTP(S) origin without a path or credentials.')

export const AssertionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('urlMatches'), pattern: PatternSchema, timeoutMs: z.number().int().min(0).max(5_000).default(5_000) }).strict(),
  z.object({ type: z.literal('titleIncludes'), text: z.string().min(1).max(300), timeoutMs: z.number().int().min(0).max(5_000).default(5_000) }).strict(),
  z.object({ type: z.literal('elementVisible'), target: AssertionTarget, timeoutMs: z.number().int().min(0).max(5_000).default(5_000) }).strict(),
  z.object({ type: z.literal('elementHidden'), target: AssertionTarget, timeoutMs: z.number().int().min(0).max(5_000).default(5_000) }).strict(),
  z.object({ type: z.literal('textVisible'), text: z.string().trim().min(1).max(500), timeoutMs: z.number().int().min(0).max(5_000).default(5_000) }).strict(),
  z.object({
    type: z.literal('elementState'),
    target: AssertionTarget,
    state: z.enum(['checked', 'unchecked', 'disabled', 'enabled']),
    timeoutMs: z.number().int().min(0).max(5_000).default(5_000),
  }).strict(),
  z.object({
    type: z.literal('httpStatus'),
    urlPattern: PatternSchema.describe('Substring matched against recorded response URLs.'),
    expect: z.array(z.number().int().min(100).max(599)).max(20).optional(),
    not: z.array(z.number().int().min(100).max(599)).max(20).optional(),
  }).strict(),
  z.object({
    type: z.literal('consoleErrorCount'),
    max: z.number().int().min(0).max(1000),
    pattern: PatternSchema.optional(),
  }).strict(),
  z.object({ type: z.literal('pageErrorCount'), max: z.number().int().min(0).max(1000) }).strict(),
])

export const StepSchema = z.object({
  op: BrowserOperationSchema,
  purpose: z.string().trim().min(1).max(300),
  expect: z.array(AssertionSchema).max(20).default([]),
}).strict()

export const FlowSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  preconditions: z.array(AssertionSchema).max(20).default([]),
  steps: z.array(StepSchema).min(1).max(150),
  maxSteps: z.number().int().min(1).max(150).optional(),
}).strict()

export const BugReportSchema = z.object({
  title: z.string().trim().min(1).max(160),
  steps: z.array(StepSchema.extend({ expectedFailure: z.boolean().default(false) })).min(1).max(150),
}).strict()

export const TestPlanSchema = z.object({
  schemaVersion: z.literal('2'),
  name: z.string().trim().min(1).max(120),
  source: z.string().trim().min(1).max(500),
  startUrl: WebsiteUrlSchema.optional(),
  origins: z.array(HttpOriginSchema).max(20).default([]),
  flows: z.array(FlowSchema).min(1).max(50),
  globalAssertions: z.array(AssertionSchema).max(50).default([]),
}).strict().superRefine((plan, context) => {
  const ids = new Set<string>()
  plan.flows.forEach((flow, index) => {
    if (ids.has(flow.id)) {
      context.addIssue({ code: 'custom', path: ['flows', index, 'id'], message: `Flow id "${flow.id}" must be unique within a plan.` })
    }
    ids.add(flow.id)
  })
})

export const VerdictSchema = z.enum([
  'passed',
  'assertion_failed',
  'action_failed',
  'policy_blocked',
  'budget_stopped',
])

export const AssertionResultSchema = z.object({
  pass: z.boolean(),
  actual: z.unknown(),
  detail: z.string().max(2000),
}).strict()

export const RunRecordSchema = z.object({
  schemaVersion: z.literal('2'),
  runId: z.string().min(1).max(120),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  url: z.string().max(2048),
  verdict: VerdictSchema,
  startUrl: WebsiteUrlSchema.optional(),
  origins: z.array(HttpOriginSchema).max(20).optional(),
  flows: z.array(z.object({
    id: z.string().min(1).max(120),
    preconditions: z.array(AssertionSchema).default([]),
    maxSteps: z.number().int().min(1).max(150).optional(),
    verdict: VerdictSchema.optional(),
    detail: z.string().max(2000).optional(),
    globalPageAssertions: z.array(AssertionResultSchema).optional(),
  }).strict()).max(50).optional(),
  globalAssertions: z.array(AssertionSchema).max(50).optional(),
  steps: z.array(z.object({
    purpose: z.string().max(300),
    startedAt: z.string().datetime(),
    durationMs: z.number().finite().nonnegative(),
    operationOk: z.boolean(),
    operationDetail: z.string().max(2000),
    flowId: z.string().max(120).optional(),
    operation: BrowserOperationSchema.optional(),
    expect: z.array(AssertionSchema).max(20).optional(),
    assertions: z.array(AssertionResultSchema),
  }).strict()),
  facts: z.array(z.unknown()),
  evidencePaths: z.array(z.string().max(1000)),
}).strict()

export type Locator = z.infer<typeof LocatorSchema>
export type BrowserOperation = z.infer<typeof BrowserOperationSchema>
export type Assertion = z.infer<typeof AssertionSchema>
export type AssertionResult = z.infer<typeof AssertionResultSchema>
export type Step = z.infer<typeof StepSchema>
export type Flow = z.infer<typeof FlowSchema>
export type TestPlan = z.infer<typeof TestPlanSchema>
export type Verdict = z.infer<typeof VerdictSchema>
export type RunRecord = z.infer<typeof RunRecordSchema>
