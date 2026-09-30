import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import type { BrowserOperation, Locator } from '../contracts.js'
import { RunBudget } from '../policy/run-budget.js'
import { resolveAllowedNavigation, UrlPolicyError, type NavigationPolicy } from '../policy/url-policy.js'
import { redactText } from '../security/redaction.js'

const MAX_SNAPSHOT_LENGTH = 30_000
const MAX_DIAGNOSTICS = 10

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
  budget: RunBudget
  signal?: AbortSignal
  sensitiveValues?: readonly string[]
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
  private readonly budget: RunBudget
  private readonly signal: AbortSignal | undefined
  private readonly consoleErrors: string[] = []
  private readonly failedRequests: string[] = []
  private readonly knownSensitiveValues = new Set<string>()
  private readonly prefetchedDocuments = new Map<string, CachedDocumentResponse>()
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
    this.budget = options.budget
    this.signal = options.signal
    for (const value of options.sensitiveValues ?? []) this.knownSensitiveValues.add(value)
    this.attachDiagnostics()
  }

  static async open(options: BrowserSessionOptions): Promise<BrowserSession> {
    let browser: Browser | undefined
    try {
      browser = await chromium.launch({ headless: true, chromiumSandbox: true })
      const context = await browser.newContext({ acceptDownloads: false })
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

  async observe(): Promise<string> {
    this.assertUsable()
    this.budget.recordBrowserOperation()

    try {
      const [title, ariaTree, visibleText] = await Promise.all([
        this.page.title().catch(() => ''),
        this.page.locator('body').ariaSnapshot({ timeout: 5_000 }).catch(() => ''),
        this.page.locator('body').innerText({ timeout: 5_000 }).catch(() => ''),
      ])
      const safeAriaTree = this.redactInputValues(ariaTree)
      const safeText = this.redactKnownValues(visibleText).slice(0, 8_000)
      const payload = {
        url: safePageUrl(this.page.url()),
        title: this.redactKnownValues(title).slice(0, 300),
        accessibleSnapshot: safeAriaTree.slice(0, 18_000),
        visibleText: safeText,
        consoleErrors: this.consoleErrors.slice(-MAX_DIAGNOSTICS),
        failedRequests: this.failedRequests.slice(-MAX_DIAGNOSTICS),
      }
      return JSON.stringify(payload).slice(0, MAX_SNAPSHOT_LENGTH)
    } catch (error) {
      if (!this.browser.isConnected() || this.page.isClosed()) {
        throw new BrowserRuntimeError('Chromium exited while capturing the page snapshot.', { cause: error })
      }
      throw new BrowserOperationError('Could not capture the current page snapshot.', { cause: error })
    }
  }

  async execute(operation: BrowserOperation): Promise<string> {
    this.assertUsable()
    this.budget.recordBrowserOperation()
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
      return operationDescription ?? describeOperation(operation)
    } catch (error) {
      if (error instanceof BrowserOperationError) throw error
      if (!this.browser.isConnected() || this.page.isClosed()) {
        throw new BrowserRuntimeError('Chromium exited while executing a browser operation.', { cause: error })
      }
      if (this.blockedNavigation) throw new BrowserOperationError(this.blockedNavigation, { cause: error })
      if (error instanceof UrlPolicyError) throw new BrowserOperationError(error.message, { cause: error })
      throw new BrowserOperationError(`${describeOperation(operation)} failed.`, { cause: error })
    }
  }

  async captureTemporaryScreenshot(): Promise<Buffer | undefined> {
    if (this.closed || this.page.isClosed() || !this.browser.isConnected()) return undefined
    this.budget.recordBrowserOperation()
    try {
      return await this.page.screenshot({ type: 'png', fullPage: false, timeout: 5_000 })
    } catch {
      return undefined
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.context.close().catch(() => undefined)
    await this.browser.close().catch(() => undefined)
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

  private attachDiagnostics(): void {
    this.page.on('console', (message) => {
      if (message.type() === 'error') this.pushBounded(this.consoleErrors, this.redactKnownValues(message.text()))
    })
    this.page.on('requestfailed', (request) => {
      this.pushBounded(this.failedRequests, `${request.method()} ${safePageUrl(request.url())}`)
    })
  }

  private async installNavigationGuard(): Promise<void> {
    await this.context.route('**/*', async (route) => {
      const request = route.request()
      if (
        request.resourceType() !== 'document' ||
        !request.isNavigationRequest() ||
        request.frame().parentFrame() !== null
      ) {
        await route.continue()
        return
      }

      try {
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
          this.blockedNavigation = `Navigation blocked by Phloem origin policy: ${reason}`
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
      this.budget.recordBrowserOperation()
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

  private pushBounded(target: string[], value: string): void {
    target.push(value.slice(0, 500))
    if (target.length > MAX_DIAGNOSTICS) target.shift()
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

function isSensitiveLocator(name: string): boolean {
  return /password|passcode|secret|token|credential|api\s*key/i.test(name)
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