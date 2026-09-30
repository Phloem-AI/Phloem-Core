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
    timeoutMs: z.number().int().min(100).max(10_000).default(5_000),
  })
  .strict()

export const BrowserOperationSchema = z.discriminatedUnion('type', [
  NavigateOperationSchema,
  TargetOperationSchema,
  ScrollOperationSchema,
  FillOperationSchema,
  SelectOperationSchema,
  PressOperationSchema,
  WaitForVisibleOperationSchema,
])

export const ObjectiveSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    name: z.string().trim().min(1).max(120),
    purpose: z.string().trim().min(1).max(500),
    expectedOutcome: z.string().trim().min(1).max(500),
    successCriteria: z.array(z.string().trim().min(1).max(300)).min(1).max(5),
  })
  .strict()

export const ObjectivePlanSchema = z
  .object({
    schemaVersion: z.literal('1'),
    objectives: z.array(ObjectiveSchema).min(1).max(15),
  })
  .superRefine((plan, context) => {
    const ids = new Set<string>()
    for (const [index, objective] of plan.objectives.entries()) {
      if (ids.has(objective.id)) {
        context.addIssue({ code: 'custom', path: ['objectives', index, 'id'], message: 'Objective IDs must be unique.' })
      }
      ids.add(objective.id)
    }
  })
  .strict()

export const FlowStepResponseSchema = z.discriminatedUnion('kind', [
  z
    .object({
      schemaVersion: z.literal('1'),
      kind: z.literal('operation'),
      operation: BrowserOperationSchema,
      purpose: z.string().trim().min(1).max(300),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal('1'),
      kind: z.literal('complete'),
      summary: z.string().trim().min(1).max(500),
    })
    .strict(),
])

export const ObjectiveVerdictSchema = z
  .object({
    schemaVersion: z.literal('1'),
    status: z.enum(['passed', 'failed']),
    reason: z.string().trim().min(1).max(1000),
    evidence: z.array(z.string().trim().min(1).max(300)).max(5),
  })
  .strict()

export type Locator = z.infer<typeof LocatorSchema>
export type BrowserOperation = z.infer<typeof BrowserOperationSchema>
export type Objective = z.infer<typeof ObjectiveSchema>
export type ObjectivePlan = z.infer<typeof ObjectivePlanSchema>
export type FlowStepResponse = z.infer<typeof FlowStepResponseSchema>
export type ObjectiveVerdict = z.infer<typeof ObjectiveVerdictSchema>