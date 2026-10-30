import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { devices } from '@playwright/test'
import type { BrowserOperation, Locator } from '../contracts.js'
import { resolveAllowedNavigation, UrlPolicyError, type NavigationPolicy } from '../policy/url-policy.js'
import { redactText } from '../security/redaction.js'
import { attachPageTaps, FactStore } from '../instrument/taps.js'

const MAX_SNAPSHOT_LENGTH = 30_000

export class BrowserOperationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BrowserOperationError'
  }
}

export class BrowserRuntimeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BrowserRuntimeError'
  }
}

export interface BrowserSessionOptions {
  startUrl: URL
  navigationPolicy: NavigationPolicy
  headless?: boolean
  signal?: AbortSignal
  sensitiveValues?: readonly string[]
  viewport?: { width: number; height: number } | null
  deviceName?: string | null
  storageStatePath?: string
}

type CachedDocumentResponse = {
  status: number
  headers: Record<string, string>
  body: Buffer
}

export class BrowserSession {
  private readonly browser: Browser
  private readonly context: BrowserContext
  private readonly page: Page
  private readonly navigationPolicy: NavigationPolicy
  private readonly signal: AbortSignal | undefined
  private readonly knownSensitiveValues = new Set<string>()
  private readonly factStore: FactStore
  private readonly prefetchedDocuments = new Map<string, CachedDocumentResponse>()
  private lastAriaSnapshot = ''
  private lastVisibleText = ''
  private lastObservedFactIndex = 0
  private lastActionStatus: { ok: boolean; detail: string } | undefined
  private blockedNavigation: string | undefined
  private redirectedDocumentUrl: string | undefined
  private closed = false

  private constructor(
    browser: Browser,
    context: BrowserContext,
    page: Page,
    options: BrowserSessionOptions,
  ) {
    this.browser = browser
    this.context = context
    this.page = page
    this.navigationPolicy = options.navigationPolicy
    this.signal = options.signal
    for (const value of options.sensitiveValues ?? []) this.knownSensitiveValues.add(value)
    this.factStore = new FactStore(() => [...this.knownSensitiveValues])
    attachPageTaps(page, this.factStore)
    browser.on('disconnected', () =>
      this.factStore.append({ kind: 'lifecycle', ts: new Date().toISOString(), event: 'browser-disconnected' }),
    )
    context.on('close', () =>
      this.factStore.append({ kind: 'lifecycle', ts: new Date().toISOString(), event: 'context-close' }),
    )
  }

  static async open(options: BrowserSessionOptions): Promise<BrowserSession> {
    let browser: Browser | undefined
    try {
      browser = await chromium.launch({ headless: options.headless ?? true, chromiumSandbox: true })
      const device = options.deviceName ? devices[options.deviceName] : undefined
      if (options.deviceName && !device) throw new Error(`Unknown Playwright device descriptor: ${options.deviceName}`)
      const { defaultBrowserType: _defaultBrowserType, ...deviceOptions } = device ?? {}
      const context = await browser.newContext({
        acceptDownloads: false,
        ...deviceOptions,
        ...(options.viewport !== undefined ? { viewport: options.viewport } : {}),
        ...(options.storageStatePath ? { storageState: options.storageStatePath } : {}),
      })
      const page = await context.newPage()
      page.setDefaultTimeout(5_000)
      page.setDefaultNavigationTimeout(15_000)
      const session = new BrowserSession(browser, context, page, options)
      await session.installNavigationGuard()
      await session.execute({ type: 'navigate', url: options.startUrl.href })
      return session
    } catch (error) {
      await browser?.close().catch(() => undefined)
      if (error instanceof BrowserRuntimeError || error instanceof BrowserOperationError) throw error
      throw new BrowserRuntimeError('Could not start Chromium or load the website.', { cause: error })
    }
  }

  get currentUrl(): string {
    return this.page.url()
  }

  get facts(): FactStore {
    return this.factStore
  }

  get assertionPage(): Page {
    this.assertUsable()
    return this.page
  }

  async observe(): Promise<string> {
    this.assertUsable()

    try {
      const [title, ariaTree, visibleText] = await Promise.all([
        this.page.title().catch(() => ''),
        this.page.locator('body').ariaSnapshot({ timeout: 5_000 }).catch(() => ''),
        this.page.locator('body').innerText({ timeout: 5_000 }).catch(() => ''),
      ])
      const redactedAriaTree = this.redactInputValues(ariaTree)
      const redactedText = this.redactKnownValues(visibleText)
      const safeAriaTree = redactedAriaTree.slice(0, 18_000)
      const safeText = redactedText.slice(0, 8_000)
      const newFacts = this.factStore.since(this.lastObservedFactIndex)
      const factDigest = this.factStore.digest(newFacts)
      const payload = {
        url: this.redactKnownValues(safePageUrl(this.page.url())),
        title: this.redactKnownValues(title).slice(0, 300),
        accessibleSnapshot: safeAriaTree.slice(0, 18_000),
        accessibleSnapshotDelta: snapshotDelta(this.lastAriaSnapshot, safeAriaTree),
        visibleText: safeText,
        visibleTextDelta: textDelta(this.lastVisibleText, safeText),
        actionStatus: this.lastActionStatus,
        facts: factDigest,
        truncated: {
          accessibleSnapshot: redactedAriaTree.length > 18_000,
          visibleText: redactedText.length > 8_000,
          total: false,
        },
      }
      this.lastAriaSnapshot = safeAriaTree
      this.lastVisibleText = safeText
      this.lastObservedFactIndex = this.factStore.length
      let serialized = JSON.stringify(payload)
      if (serialized.length > MAX_SNAPSHOT_LENGTH) {
        payload.accessibleSnapshot = payload.accessibleSnapshot.slice(0, 12_000)
        payload.accessibleSnapshotDelta = payload.accessibleSnapshotDelta.slice(0, 2_000)
        payload.visibleText = payload.visibleText.slice(0, 3_000)
        payload.visibleTextDelta = payload.visibleTextDelta.slice(0, 1_000)
        payload.facts.exemplars = payload.facts.exemplars.slice(0, 2)
        payload.truncated.total = true
        payload.truncated.accessibleSnapshot = true
        payload.truncated.visibleText = true
        serialized = JSON.stringify(payload)
      }
      if (serialized.length > MAX_SNAPSHOT_LENGTH) {
        payload.accessibleSnapshot = payload.accessibleSnapshot.slice(0, 8_000)
        payload.accessibleSnapshotDelta = ''
        payload.visibleText = payload.visibleText.slice(0, 1_000)
        payload.visibleTextDelta = ''
        payload.facts.exemplars = []
        serialized = JSON.stringify(payload)
      }
      return serialized
    } catch (error) {
      if (!this.browser.isConnected() || this.page.isClosed()) {
        throw new BrowserRuntimeError('Chromium exited while capturing the page snapshot.', { cause: error })
      }
      throw new BrowserOperationError('Could not capture the current page snapshot.', { cause: error })
    }
  }

  async execute(operation: BrowserOperation): Promise<string> {
    this.assertUsable()
    this.blockedNavigation = undefined
    this.redirectedDocumentUrl = undefined
    let operationDescription: string | undefined

    try {
      switch (operation.type) {
        case 'navigate': {
          const destination = resolveAllowedNavigation(operation.url, this.page.url(), this.navigationPolicy)
          await this.page.goto(destination.href, { waitUntil: 'domcontentloaded', timeout: 15_000 })
          break
        }
        case 'click':
          await this.target(operation.target).click()
          break
        case 'check':
          await this.target(operation.target).check()
          break
        case 'uncheck':
          await this.target(operation.target).uncheck()
          break
        case 'fill':
          if (isSensitiveLocator(operation.target.name)) this.knownSensitiveValues.add(operation.value)
          await this.target(operation.target).fill(operation.value)
          operationDescription = `Filled the ${operation.target.role} named "${operation.target.name}" with [value omitted].`
          break
        case 'select':
          await this.target(operation.target).selectOption(operation.value)
          operationDescription = `Selected an option in the ${operation.target.role} named "${operation.target.name}".`
          break
        case 'press':
          await this.page.keyboard.press(operation.key)
          break
        case 'scroll':
          await this.page.mouse.wheel(0, operation.direction === 'down' ? operation.amount : -operation.amount)
          break
        case 'waitForVisible':
          await this.target(operation.target).waitFor({ state: 'visible', timeout: operation.timeoutMs })
          break
      }

      if (this.blockedNavigation) throw new BrowserOperationError(this.blockedNavigation)
      await this.completeAllowedRedirects()
      if (this.blockedNavigation) throw new BrowserOperationError(this.blockedNavigation)
      const detail = this.redactKnownValues(operationDescription ?? describeOperation(operation))
      this.lastActionStatus = { ok: true, detail }
      return detail
    } catch (error) {
      this.lastActionStatus = { ok: false, detail: error instanceof Error ? error.message : 'Browser action failed.' }
      if (error instanceof BrowserOperationError) throw error
      if (!this.browser.isConnected() || this.page.isClosed()) {
        throw new BrowserRuntimeError('Chromium exited while executing a browser operation.', { cause: error })
      }
      if (this.blockedNavigation) throw new BrowserOperationError(this.blockedNavigation, { cause: error })
      if (error instanceof UrlPolicyError) throw new BrowserOperationError(error.message, { cause: error })
      throw new BrowserOperationError(`${describeOperation(operation)} failed.`, { cause: error })
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    let closeError: unknown
    try {
      await this.context.close()
    } catch (error) {
      closeError = error
    } finally {
      await this.browser.close().catch((error: unknown) => {
        if (closeError === undefined) closeError = error
      })
    }
    if (closeError !== undefined) {
      throw new BrowserRuntimeError('Could not close the Chromium session cleanly.', { cause: closeError })
    }
  }

  private target(locator: Locator) {
    return this.page.getByRole(locator.role, { name: locator.name, exact: locator.exact })
  }

  private assertUsable(): void {
    if (this.signal?.aborted) throw new BrowserRuntimeError('The run was cancelled.')
    if (this.closed || this.page.isClosed() || !this.browser.isConnected()) {
      throw new BrowserRuntimeError('The Chromium session is no longer available.')
    }
  }

  private async installNavigationGuard(): Promise<void> {
    await this.context.route('**/*', async (route) => {
      try {
        const request = route.request()
        if (request.resourceType() !== 'document' || !request.isNavigationRequest()) {
          await route.continue()
          return
        }

        let isSubframeNavigation = false
        try {
          isSubframeNavigation = request.frame().parentFrame() !== null
        } catch {
          // Playwright can issue a navigation before its frame exists. Treat it
          // as a main-frame candidate so it still passes through origin policy.
        }
        if (isSubframeNavigation) {
          await route.continue()
          return
        }

        const cached = this.prefetchedDocuments.get(request.url())
        if (cached) {
          this.prefetchedDocuments.delete(request.url())
          await route.fulfill(cached)
          return
        }
        await this.fulfillDocumentNavigation(route)
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Navigation target is not allowed.'
        if (error instanceof UrlPolicyError) {
          this.blockedNavigation = 'Navigation blocked by Phloem origin policy: ' + reason
        }
        await route.abort('blockedbyclient').catch(() => undefined)
      }
    })
  }

  private async fulfillDocumentNavigation(route: import('playwright').Route): Promise<void> {
    const request = route.request()
    let currentUrl = resolveAllowedNavigation(
      request.url(),
      this.navigationPolicy.startUrl.href,
      this.navigationPolicy,
    )
    let method = request.method()
    let postData = request.postDataBuffer() ?? undefined
    let headers = await request.allHeaders()

    for (let redirectCount = 0; redirectCount <= 10; redirectCount += 1) {
      const response = await route.fetch({
        url: currentUrl.href,
        method,
        ...(postData ? { postData } : {}),
        headers,
        maxRedirects: 0,
        timeout: 15_000,
      })
      const status = response.status()
      const location = response.headers()['location']

      if (status < 300 || status >= 400 || !location) {
        if (currentUrl.href !== request.url()) {
          this.redirectedDocumentUrl = currentUrl.href
          const responseHeaders = await response.headers()
          delete responseHeaders['content-encoding']
          delete responseHeaders['content-length']
          delete responseHeaders['transfer-encoding']
          this.prefetchedDocuments.set(currentUrl.href, {
            status,
            headers: responseHeaders,
            body: await response.body(),
          })
        }
        await route.fulfill({ response })
        return
      }

      if (redirectCount === 10) {
        throw new UrlPolicyError('Navigation exceeded Phloem\'s 10-redirect limit.')
      }

      const destination = resolveAllowedNavigation(location, currentUrl.href, this.navigationPolicy)
      if (destination.origin !== currentUrl.origin) {
        headers = { ...headers }
        delete headers.authorization
        delete headers['proxy-authorization']
        const destinationCookies = await this.context.cookies(destination.href)
        headers.cookie = destinationCookies.map(({ name, value }) => `${name}=${value}`).join('; ')
      }

      if ([301, 302, 303].includes(status) && method !== 'GET' && method !== 'HEAD') {
        method = 'GET'
        postData = undefined
        delete headers['content-length']
        delete headers['content-type']
      }
      currentUrl = destination
    }
  }

  private async completeAllowedRedirects(): Promise<void> {
    for (let count = 0; this.redirectedDocumentUrl && count < 10; count += 1) {
      const destination = this.redirectedDocumentUrl
      this.redirectedDocumentUrl = undefined
      if (destination === this.page.url()) return
      await this.page.goto(destination, { waitUntil: 'domcontentloaded', timeout: 15_000 })
      if (this.blockedNavigation) return
    }
    if (this.redirectedDocumentUrl) {
      this.blockedNavigation = 'Navigation exceeded Phloem\'s 10-redirect limit.'
    }
  }

  private redactInputValues(snapshot: string): string {
    return snapshot
      .split('\n')
      .map((line) => (/\b(?:textbox|combobox|searchbox|spinbutton)\b/i.test(line) && line.includes(':')
        ? line.slice(0, line.indexOf(':') + 1) + ' [value omitted]'
        : this.redactKnownValues(line)))
      .join('\n')
  }

  private redactKnownValues(value: string): string {
    return redactText(value, [...this.knownSensitiveValues])
  }

}

function safePageUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`.slice(0, 2048)
  } catch {
    return 'about:blank'
  }
}

function snapshotDelta(previous: string, current: string): string {
  const previousLines = new Set(previous.split('\n'))
  const currentLines = current.split('\n')
  const added = currentLines.filter((line) => !previousLines.has(line))
  const removed = previous.split('\n').filter((line) => line.length > 0 && !currentLines.includes(line))
  return JSON.stringify({ added: added.slice(0, 100), removed: removed.slice(0, 100) }).slice(0, 18_000)
}

function textDelta(previous: string, current: string): string {
  const previousLines = new Set(previous.split('\n'))
  return current.split('\n').filter((line) => !previousLines.has(line)).join('\n').slice(0, 8_000)
}

function isSensitiveLocator(name: string): boolean {
  return /password|passcode|secret|token|credential|api\s*key|username|user\s*name|email/i.test(name)
}

function describeOperation(operation: BrowserOperation): string {
  switch (operation.type) {
    case 'click':
    case 'check':
    case 'uncheck':
    case 'waitForVisible':
      return `${operation.type} ${operation.target.role} "${operation.target.name}".`
    case 'fill':
      return `Filled ${operation.target.role} "${operation.target.name}" with [value omitted].`
    case 'select':
      return `Selected an option in ${operation.target.role} "${operation.target.name}".`
    case 'navigate':
      return `Navigate to ${safePageUrl(operation.url)}.`
    case 'press':
      return `Pressed ${operation.key}.`
    case 'scroll':
      return `Scrolled ${operation.direction} ${operation.amount} pixels.`
  }
}