import type { Page } from 'playwright'
import type { Assertion, AssertionResult, Locator } from '../contracts.js'
import type { FactStore } from '../instrument/taps.js'

export interface AssertionContext {
  page?: Page
  facts: FactStore
}

export async function evaluateAssertions(
  assertions: readonly Assertion[],
  context: AssertionContext,
): Promise<AssertionResult[]> {
  const results: AssertionResult[] = []
  for (const assertion of assertions) results.push(await evaluateAssertion(assertion, context))
  return results
}

export async function evaluateAssertion(assertion: Assertion, context: AssertionContext): Promise<AssertionResult> {
  try {
    switch (assertion.type) {
      case 'httpStatus': {
        const matching = context.facts.all().filter((fact) =>
          fact.kind === 'http' && fact.url.includes(assertion.urlPattern),
        )
        if (matching.length === 0) {
          return failed([], `No recorded HTTP responses matched "${assertion.urlPattern}".`)
        }
        const statuses = matching.map((fact) => fact.kind === 'http' ? fact.status : 0)
        const expected = assertion.expect
        const rejected = new Set(assertion.not ?? [])
        const pass = statuses.every((status) =>
          expected ? expected.includes(status) : rejected.has(status) ? false : status < 400,
        )
        return { pass, actual: statuses, detail: pass ? 'Matching HTTP statuses satisfied the assertion.' : 'Matching HTTP response included an unexpected status.' }
      }
      case 'consoleErrorCount': {
        const matching = context.facts.all().filter((fact) =>
          fact.kind === 'console' && fact.level === 'error' && (!assertion.pattern || fact.text.includes(assertion.pattern)),
        )
        return countResult(matching.length, assertion.max, 'console errors')
      }
      case 'pageErrorCount': {
        const matching = context.facts.all().filter((fact) => fact.kind === 'pageerror')
        return countResult(matching.length, assertion.max, 'uncaught page errors')
      }
      default:
        if (!context.page) return failed(undefined, 'This assertion requires an active browser page.')
        return evaluatePageAssertion(assertion, context.page)
    }
  } catch (error) {
    return failed(
      error instanceof Error ? error.message : 'Assertion evaluation failed.',
      `Assertion "${assertion.type}" could not be evaluated.`,
    )
  }
}

function countResult(actual: number, max: number, label: string): AssertionResult {
  const pass = actual <= max
  return { pass, actual, detail: pass ? `${actual} ${label}; maximum is ${max}.` : `${actual} ${label} exceeds maximum ${max}.` }
}

async function evaluatePageAssertion(
  assertion: Exclude<Assertion, { type: 'httpStatus' | 'consoleErrorCount' | 'pageErrorCount' }>,
  page: Page,
): Promise<AssertionResult> {
  const timeoutMs = assertion.timeoutMs
  const deadline = Date.now() + timeoutMs
  let actual: unknown
  while (true) {
    actual = await readPageAssertion(assertion, page)
    const pass = checkPageAssertion(assertion, actual)
    if (pass) return { pass: true, actual, detail: `Assertion "${assertion.type}" matched.` }
    if (Date.now() >= deadline) {
      return { pass: false, actual, detail: `Assertion "${assertion.type}" did not match within ${timeoutMs}ms.` }
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))))
  }
}

async function readPageAssertion(
  assertion: Exclude<Assertion, { type: 'httpStatus' | 'consoleErrorCount' | 'pageErrorCount' }>,
  page: Page,
): Promise<unknown> {
  switch (assertion.type) {
    case 'urlMatches':
      return page.url()
    case 'titleIncludes':
      return page.title()
    case 'elementVisible':
      return locator(page, assertion.target).isVisible().catch(() => false)
    case 'elementHidden':
      return locator(page, assertion.target).isVisible().catch(() => false)
    case 'textVisible':
      return page.locator('body').innerText().then((text) => text.includes(assertion.text)).catch(() => false)
    case 'elementState': {
      const target = locator(page, assertion.target)
      if (assertion.state === 'checked' || assertion.state === 'unchecked') {
        const checked = await target.isChecked().catch(() => false)
        return assertion.state === 'checked' ? checked : !checked
      }
      const disabled = await target.isDisabled().catch(() => false)
      return assertion.state === 'disabled' ? disabled : !disabled
    }
  }
}

function checkPageAssertion(
  assertion: Exclude<Assertion, { type: 'httpStatus' | 'consoleErrorCount' | 'pageErrorCount' }>,
  actual: unknown,
): boolean {
  switch (assertion.type) {
    case 'urlMatches':
      return typeof actual === 'string' && actual.includes(assertion.pattern)
    case 'titleIncludes':
      return typeof actual === 'string' && actual.includes(assertion.text)
    case 'elementVisible':
    case 'textVisible':
      return actual === true
    case 'elementHidden':
      return actual === false
    case 'elementState':
      return actual === true
  }
}

function locator(page: Page, target: Locator) {
  return page.getByRole(target.role, { name: target.name, exact: target.exact })
}

function failed(actual: unknown, detail: string): AssertionResult {
  return { pass: false, actual, detail }
}
