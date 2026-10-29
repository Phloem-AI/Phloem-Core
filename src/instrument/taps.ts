import type { Page, Request, Response } from 'playwright'
import { redactText } from '../security/redaction.js'

export type BrowserFact =
  | { kind: 'console'; ts: string; level: 'warning' | 'error'; text: string }
  | { kind: 'pageerror'; ts: string; message: string; stack?: string }
  | { kind: 'http'; ts: string; method: string; url: string; status: number; bytes?: number; ttfbMs?: number }
  | { kind: 'requestfailed'; ts: string; method: string; url: string; failure?: string }
  | { kind: 'dialog'; ts: string; dialogType: string; message: string; action: 'dismissed' }
  | { kind: 'lifecycle'; ts: string; event: 'page-close' | 'page-crash' | 'context-close' }

export type FactKind = BrowserFact['kind']
export type FactCounts = Record<FactKind, number>

const FACT_LIMITS: Record<FactKind, number> = {
  console: 100,
  pageerror: 50,
  http: 200,
  requestfailed: 100,
  dialog: 50,
  lifecycle: 20,
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`.slice(0, 2048)
  } catch {
    return 'about:blank'
  }
}

function requestUrl(request: Request): string {
  return safeUrl(request.url())
}

export class FactStore {
  private readonly records: BrowserFact[] = []
  private readonly dropped: FactCounts = {
    console: 0,
    pageerror: 0,
    http: 0,
    requestfailed: 0,
    dialog: 0,
    lifecycle: 0,
  }

  constructor(private readonly secrets: () => readonly string[]) {}

  append(fact: BrowserFact): void {
    const limit = FACT_LIMITS[fact.kind]
    const kindCount = this.records.reduce((count, item) => count + Number(item.kind === fact.kind), 0)
    if (kindCount >= limit) {
      const oldestIndex = this.records.findIndex((item) => item.kind === fact.kind)
      if (oldestIndex >= 0) this.records.splice(oldestIndex, 1)
      this.dropped[fact.kind] += 1
    }
    this.records.push(this.redactFact(fact))
  }

  all(): readonly BrowserFact[] {
    return this.records
  }

  since(index: number): readonly BrowserFact[] {
    return this.records.slice(index)
  }

  get length(): number {
    return this.records.length
  }

  droppedCounts(): FactCounts {
    return { ...this.dropped }
  }

  digest(facts: readonly BrowserFact[]): { counts: FactCounts; exemplars: BrowserFact[]; dropped: FactCounts } {
    const counts: FactCounts = {
      console: 0,
      pageerror: 0,
      http: 0,
      requestfailed: 0,
      dialog: 0,
      lifecycle: 0,
    }
    for (const fact of facts) counts[fact.kind] += 1
    return { counts, exemplars: facts.slice(0, 8).map((fact) => ({ ...fact })), dropped: this.droppedCounts() }
  }

  private redactFact(fact: BrowserFact): BrowserFact {
    switch (fact.kind) {
      case 'console':
        return { ...fact, text: redactText(fact.text, this.secrets()).slice(0, 1000) }
      case 'pageerror':
        return {
          ...fact,
          message: redactText(fact.message, this.secrets()).slice(0, 1000),
          ...(fact.stack ? { stack: redactText(fact.stack, this.secrets()).slice(0, 1500) } : {}),
        }
      case 'http':
      case 'requestfailed':
        return {
          ...fact,
          url: redactText(fact.url, this.secrets()).slice(0, 2048),
          ...(fact.kind === 'requestfailed' && fact.failure
            ? { failure: redactText(fact.failure, this.secrets()).slice(0, 500) }
            : {}),
        }
      case 'dialog':
        return { ...fact, message: redactText(fact.message, this.secrets()).slice(0, 1000) }
      case 'lifecycle':
        return fact
    }
  }
}

export function attachPageTaps(page: Page, facts: FactStore, onDialogDismissed?: () => void): void {
  page.on('console', (message) => {
    const level = message.type()
    if (level !== 'error' && level !== 'warning') return
    facts.append({
      kind: 'console',
      ts: new Date().toISOString(),
      level,
      text: message.text(),
    })
  })
  page.on('pageerror', (error) => {
    facts.append({
      kind: 'pageerror',
      ts: new Date().toISOString(),
      message: error.message,
      ...(error.stack ? { stack: error.stack.split('\n').slice(0, 4).join('\n') } : {}),
    })
  })
  page.on('requestfailed', (request) => appendFailedRequest(request, facts))
  page.on('response', (response) => appendResponse(response, facts))
  page.on('dialog', async (dialog) => {
    facts.append({
      kind: 'dialog',
      ts: new Date().toISOString(),
      dialogType: dialog.type(),
      message: dialog.message(),
      action: 'dismissed',
    })
    onDialogDismissed?.()
    await dialog.dismiss().catch(() => undefined)
  })
  page.on('close', () => facts.append({ kind: 'lifecycle', ts: new Date().toISOString(), event: 'page-close' }))
  page.on('crash', () => facts.append({ kind: 'lifecycle', ts: new Date().toISOString(), event: 'page-crash' }))
}

function appendFailedRequest(request: Request, facts: FactStore): void {
  facts.append({
    kind: 'requestfailed',
    ts: new Date().toISOString(),
    method: request.method(),
    url: requestUrl(request),
    ...(request.failure()?.errorText ? { failure: request.failure()!.errorText } : {}),
  })
}

function appendResponse(response: Response, facts: FactStore): void {
  const request = response.request()
  const timing = response.timing()
  const contentLength = Number(response.headers()['content-length'])
  facts.append({
    kind: 'http',
    ts: new Date().toISOString(),
    method: request.method(),
    url: requestUrl(request),
    status: response.status(),
    ...(Number.isFinite(contentLength) && contentLength >= 0 ? { bytes: contentLength } : {}),
    ...(timing.responseStart >= 0 ? { ttfbMs: timing.responseStart - timing.requestStart } : {}),
  })
}
