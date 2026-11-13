import { chromium, type Browser, type BrowserContext, type Download, type Page } from 'playwright'
import { devices } from 'playwright'
import { mkdir, open as openFile, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { BrowserOperation, Locator } from '../contracts.js'
import { resolveAllowedNavigation, resolveDownloadUrl, UrlPolicyError, type NavigationPolicy } from '../policy/url-policy.js'
import { redactText } from '../security/redaction.js'
import { resolveWorkspacePath } from '../security/workspace.js'
import { attachPageTaps, FactStore } from '../instrument/taps.js'

const MAX_SNAPSHOT_LENGTH = 30_000
const MAX_OBSERVATION_WAIT_MS = 60_000
const MAX_DOWNLOAD_READ_BYTES = 64 * 1024
const MAX_UPLOAD_TOTAL_BYTES = 50 * 1024 * 1024

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

export class BrowserEvidenceError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'BrowserEvidenceError' }
}

export interface BrowserEvidenceOptions {
  /** Absolute file path where Playwright's trace.zip is written on flushEvidence(). */
  tracePath?: string
  /** Absolute file path where the context HAR is written when the context closes. */
  harPath?: string
  /** Save a browser-context recording at this path after close. */
  videoPath?: string
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
  evidence?: BrowserEvidenceOptions
}

type CachedDocumentResponse = {
  status: number
  headers: Record<string, string>
  body: Buffer
}

type CapturedDownload = {
  id: string
  download: Download
  fileName: string
  url: string
  startedAt: string
  status: 'pending' | 'completed' | 'failed'
  failure?: string
}

export class BrowserSession {
  private readonly browser: Browser
  private readonly context: BrowserContext
  private readonly page: Page
  private readonly navigationPolicy: NavigationPolicy
  private readonly signal: AbortSignal | undefined
  private readonly knownSensitiveValues = new Set<string>()
  private readonly sensitiveLocators: Array<ReturnType<BrowserSession['target']>> = []
  private readonly factStore: FactStore
  private readonly prefetchedDocuments = new Map<string, CachedDocumentResponse>()
  private readonly downloads = new Map<string, CapturedDownload>()
  private lastAriaSnapshot = ''
  private lastVisibleText = ''
  private lastObservedFactIndex = 0
  private lastActionStatus: { ok: boolean; detail: string } | undefined
  private blockedNavigation: string | undefined
  private redirectedDocumentUrl: string | undefined
  private lastAllowedUrl = 'about:blank'
  private readonly evidence: BrowserEvidenceOptions | undefined
  private readonly videoPath: string | undefined
  private tracing = false
  private closed = false

  private constructor(
    browser: Browser,
    context: BrowserContext,
    page: Page,
    options: BrowserSessionOptions,
    tracingStarted: boolean = false,
  ) {
    this.browser = browser
    this.context = context
    this.page = page
    this.navigationPolicy = options.navigationPolicy
    this.lastAllowedUrl = options.startUrl.href
    this.signal = options.signal
    this.evidence = options.evidence
    this.videoPath = options.evidence?.videoPath
    this.tracing = tracingStarted
    for (const value of options.sensitiveValues ?? []) this.knownSensitiveValues.add(value)
    this.factStore = new FactStore(() => [...this.knownSensitiveValues])
    attachPageTaps(page, this.factStore)
    this.attachDownloadCapture(page)
    context.on('page', (openedPage) => this.attachDownloadCapture(openedPage))
    browser.on('disconnected', () =>
      this.factStore.append({ kind: 'lifecycle', ts: new Date().toISOString(), event: 'browser-disconnected' }),
    )
    context.on('close', () =>
      this.factStore.append({ kind: 'lifecycle', ts: new Date().toISOString(), event: 'context-close' }),
    )
  }

  static async open(options: BrowserSessionOptions): Promise<BrowserSession> {
    let browser: Browser | undefined
    let tracingStarted = false
    try {
      browser = await chromium.launch({ headless: options.headless ?? true, chromiumSandbox: true })
      const device = options.deviceName ? devices[options.deviceName] : undefined
      if (options.deviceName && !device) throw new Error(`Unknown Playwright device descriptor: ${options.deviceName}`)
      const { defaultBrowserType: _defaultBrowserType, ...deviceOptions } = device ?? {}
      if (options.evidence?.videoPath) await mkdir(dirname(options.evidence.videoPath), { recursive: true })
      const context = await browser.newContext({
        acceptDownloads: true,
        ...deviceOptions,
        ...(options.viewport !== undefined ? { viewport: options.viewport } : {}),
        ...(options.storageStatePath ? { storageState: options.storageStatePath } : {}),
        ...(options.evidence?.harPath ? { recordHar: { path: options.evidence.harPath } } : {}),
        ...(options.evidence?.videoPath ? { recordVideo: { dir: dirname(options.evidence.videoPath) } } : {}),
      })
      if (options.evidence?.tracePath) {
        // Text snapshots are redacted from the trace archive at finalization.
        // Omitting trace screenshots avoids retaining sensitive rendered values
        // in binary PNG entries that cannot be text-redacted.
        await context.tracing.start({ screenshots: false, snapshots: true, sources: false })
        tracingStarted = true
      }      const page = await context.newPage()
      page.setDefaultTimeout(5_000)
      page.setDefaultNavigationTimeout(15_000)
      const session = new BrowserSession(browser, context, page, options, tracingStarted)
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

  get sensitiveValues(): readonly string[] {
    return [...this.knownSensitiveValues]
  }

  listDownloads(): Array<{ downloadId: string; fileName: string; url: string; startedAt: string; status: string; failure?: string }> {
    this.assertUsable()
    return [...this.downloads.values()].map(({ id, fileName, url, startedAt, status, failure }) => ({
      downloadId: id, fileName, url, startedAt, status, ...(failure ? { failure } : {}),
    }))
  }

  async readDownload(downloadId: string, offset = 0, maxBytes = MAX_DOWNLOAD_READ_BYTES): Promise<{
    downloadId: string; fileName: string; totalBytes: number; offset: number; nextOffset: number | null; encoding: 'utf-8' | 'base64'; content: string
  }> {
    this.assertUsable()
    if (!Number.isInteger(offset) || offset < 0) throw new BrowserOperationError('Download offset must be a non-negative integer.')
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_DOWNLOAD_READ_BYTES) {
      throw new BrowserOperationError(`Download read size must be between 1 and ${MAX_DOWNLOAD_READ_BYTES} bytes.`)
    }
    const captured = this.downloads.get(downloadId)
    if (!captured) throw new BrowserOperationError(`No download with id "${downloadId}" exists in this browser session.`)
    const failure = await captured.download.failure()
    if (failure) throw new BrowserOperationError(`Download "${captured.fileName}" failed: ${failure}`)
    const path = await captured.download.path()
    const file = await openFile(path, 'r')
    try {
      const { size } = await file.stat()
      if (offset > size) throw new BrowserOperationError(`Download offset ${offset} exceeds file length ${size}.`)
      const length = Math.min(maxBytes, size - offset)
      const buffer = Buffer.alloc(length)
      let bytesRead = 0
      while (bytesRead < length) {
        const chunk = await file.read(buffer, bytesRead, length - bytesRead, offset + bytesRead)
        if (chunk.bytesRead === 0) break
        bytesRead += chunk.bytesRead
      }
      const data = buffer.subarray(0, bytesRead)
      let content: string
      let encoding: 'utf-8' | 'base64'
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(data)
        encoding = 'utf-8'
      } catch {
        content = data.toString('base64')
        encoding = 'base64'
      }
      const nextOffset = offset + bytesRead
      return {
        downloadId,
        fileName: captured.fileName,
        totalBytes: size,
        offset,
        nextOffset: nextOffset < size ? nextOffset : null,
        encoding,
        content,
      }
    } finally {
      await file.close()
    }
  }

  /** Write Playwright's trace.zip (screenshot + DOM snapshots); returns true when a trace was written. */
  async flushEvidence(): Promise<boolean> {
    if (!this.evidence?.tracePath || !this.tracing) return false
    this.assertUsable()
    await this.context.tracing.stop({ path: this.evidence.tracePath })
    this.tracing = false
    return true
  }

  async screenshot(): Promise<Buffer> {
    this.assertUsable()
    return this.page.screenshot({
      type: 'png',
      ...(this.sensitiveLocators.length > 0 ? { mask: this.sensitiveLocators } : {}),
    })
  }

  get assertionPage(): Page {
    this.assertUsable()
    return this.page
  }

  async observe(waitMs = 0): Promise<string> {
    this.assertUsable()
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_OBSERVATION_WAIT_MS) {
      throw new BrowserOperationError(`Observation wait must be an integer between 0 and ${MAX_OBSERVATION_WAIT_MS} milliseconds.`)
    }

    try {
      if (waitMs > 0) await this.page.waitForTimeout(waitMs)
      this.assertUsable()
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
          const currentUrl = this.page.url()
          const baseUrl = /^https?:\/\//i.test(currentUrl) ? currentUrl : this.lastAllowedUrl
          const destination = resolveAllowedNavigation(operation.url, baseUrl, this.navigationPolicy)
          await this.page.goto(destination.href, { waitUntil: 'domcontentloaded', timeout: 15_000 })
          break
        }
        case 'goBack':
          await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 })
          operationDescription = 'Went back to the previous page in browser history.'
          break
        case 'uploadFiles': {
          const files: string[] = []
          let totalBytes = 0
          for (const filePath of operation.files) {
            const resolvedPath = await resolveWorkspacePath(filePath)
            const metadata = await stat(resolvedPath)
            if (!metadata.isFile()) throw new BrowserOperationError('Uploaded paths must refer to files inside the server working directory.')
            totalBytes += metadata.size
            if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) {
              throw new BrowserOperationError(`Uploaded files must total no more than ${MAX_UPLOAD_TOTAL_BYTES} bytes.`)
            }
            files.push(resolvedPath)
          }
          await this.page.getByLabel(operation.label, { exact: true }).setInputFiles(files)
          operationDescription = `Uploaded ${files.length} file${files.length === 1 ? '' : 's'} to the file input labeled "${operation.label}".`
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
          {
            const target = this.target(operation.target)
            const inputType = await target.getAttribute('type').catch(() => null)
            const sensitive = isSensitiveLocator(operation.target.name)
              || inputType?.toLowerCase() === 'password'
              || [...this.knownSensitiveValues].some((secret) => secret.length > 0 && operation.value.includes(secret))
            if (sensitive) {
            this.knownSensitiveValues.add(operation.value)
              if (!this.sensitiveLocators.includes(target)) this.sensitiveLocators.push(target)
            }
            await target.fill(operation.value)
          }
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
      if (/^https?:/.test(this.page.url())) this.lastAllowedUrl = this.page.url()
      const detail = this.redactKnownValues(operationDescription ?? describeOperation(operation))
      this.lastActionStatus = { ok: true, detail }
      return detail
    } catch (error) {
      this.lastActionStatus = { ok: false, detail: error instanceof Error ? error.message : 'Browser action failed.' }
      if (this.blockedNavigation) {
        const blocked = this.blockedNavigation
        try {
          // Chromium may still be committing its internal error page after an
          // aborted main-frame request. History traversal cancels that provisional
          // navigation more reliably than starting another goto immediately.
          await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => null)
          if (this.page.url() !== this.lastAllowedUrl) {
            await this.page.goto(this.lastAllowedUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 })
          }
        } catch (recoveryError) {
          throw new BrowserRuntimeError(`${blocked} Session recovery also failed.`, { cause: recoveryError })
        }
        throw new BrowserOperationError(blocked, { cause: error })
      }
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
    let evidenceError: unknown
    const video = this.videoPath ? this.page.video() : null
    let videoSave: Promise<void> | undefined
    if (this.videoPath) {
      try {
        if (!video) throw new Error('Playwright did not expose a recording for this page.')
        // Start saveAs while the page/context is still alive; it waits for the
        // recording to finalize when the context closes.
        videoSave = video.saveAs(this.videoPath)
      } catch (error) { evidenceError = error }
    }
    await Promise.all([...this.downloads.values()].map(async ({ download }) => {
      await download.cancel().catch(() => undefined)
      await download.delete().catch(() => undefined)
    }))
    this.downloads.clear()
    try {
      await this.context.close()
    } catch (error) {
      closeError = error
    } finally {
      await this.browser.close().catch((error: unknown) => {
        if (closeError === undefined) closeError = error
      })
    }
    if (this.videoPath && videoSave) {
      try {
        await videoSave
      } catch (error) {
        evidenceError = error
        const orphan = await video?.path().catch(() => undefined)
        if (orphan) await unlink(orphan).catch(() => undefined)
        await video?.delete().catch(() => undefined)
      }
    }
    if (evidenceError !== undefined) throw new BrowserEvidenceError('Could not save the browser video evidence.', { cause: evidenceError })
    if (closeError !== undefined) {
      throw new BrowserRuntimeError('Could not close the Chromium session cleanly.', { cause: closeError })
    }
  }

  private target(locator: Locator) {
    return this.page.getByRole(locator.role, { name: locator.name, exact: locator.exact })
  }

  private attachDownloadCapture(page: Page): void {
    page.on('download', (download) => {
      const captured: CapturedDownload = {
        id: randomUUID(),
        download,
        fileName: this.redactKnownValues(download.suggestedFilename()).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 255),
        url: this.redactKnownValues(safePageUrl(download.url())),
        startedAt: new Date().toISOString(),
        status: 'pending',
      }
      this.downloads.set(captured.id, captured)
      void download.failure().then((failure) => {
        if (failure) {
          captured.status = 'failed'
          captured.failure = this.redactKnownValues(failure).slice(0, 500)
        } else {
          captured.status = 'completed'
        }
      }).catch((error: unknown) => {
        captured.status = 'failed'
        captured.failure = error instanceof Error ? error.message.slice(0, 500) : 'Download status is unavailable.'
      })
    })
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
    const requestUrl = resolveDownloadUrl(
      request.url(),
      this.navigationPolicy.startUrl.href,
      this.navigationPolicy,
    )
    if (!this.navigationPolicy.allowedOrigins.has(requestUrl.origin)) {
      await this.fulfillExternalDownload(route, requestUrl, request.method(), request.postDataBuffer() ?? undefined, await request.allHeaders())
      return
    }

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

  private async fulfillExternalDownload(
    route: import('playwright').Route,
    startUrl: URL,
    method: string,
    postData: Buffer | undefined,
    requestHeaders: Record<string, string>,
  ): Promise<void> {
    let currentUrl = startUrl
    let headers = requestHeaders
    const sourceUrl = new URL(this.page.url())
    headers = await this.headersForDestination(headers, sourceUrl, currentUrl)

    for (let redirectCount = 0; redirectCount <= 10; redirectCount += 1) {
      const response = await route.fetch({
        url: currentUrl.href,
        method,
        ...(postData ? { postData } : {}),
        headers,
        maxRedirects: 0,
        timeout: 15_000,
      })
      const responseHeaders = await response.headers()
      const status = response.status()
      const location = responseHeaders.location

      const csvDownload = /^(?:text\/csv|application\/csv)$/.test(responseHeaders['content-type']?.split(';', 1)[0]?.trim().toLowerCase() ?? '')
        && /\.csv(?:$|[?#])/i.test(currentUrl.href)
      if (isDownloadResponse(responseHeaders) || csvDownload) {
        if (csvDownload && !responseHeaders['content-disposition']) responseHeaders['content-disposition'] = 'attachment'
        delete responseHeaders['content-encoding']
        delete responseHeaders['content-length']
        delete responseHeaders['transfer-encoding']
        await route.fulfill({
          status,
          headers: responseHeaders,
          body: await response.body(),
        })
        return
      }

      if (status < 300 || status >= 400 || !location) {
        throw new UrlPolicyError('Cross-origin response is not a downloadable file.')
      }
      if (redirectCount === 10) {
        throw new UrlPolicyError('Download exceeded Phloem\'s 10-redirect limit.')
      }

      const destination = resolveDownloadUrl(location, currentUrl.href, this.navigationPolicy)
      headers = await this.headersForDestination(headers, currentUrl, destination)
      if ([301, 302, 303].includes(status) && method !== 'GET' && method !== 'HEAD') {
        method = 'GET'
        postData = undefined
        delete headers['content-length']
        delete headers['content-type']
      }
      currentUrl = destination
    }
  }

  private async headersForDestination(
    headers: Record<string, string>,
    source: URL,
    destination: URL,
  ): Promise<Record<string, string>> {
    if (destination.origin === source.origin) return headers

    const destinationHeaders = { ...headers }
    delete destinationHeaders.authorization
    delete destinationHeaders['proxy-authorization']
    const destinationCookies = await this.context.cookies(destination.href)
    if (destinationCookies.length > 0) {
      destinationHeaders.cookie = destinationCookies.map(({ name, value }) => `${name}=${value}`).join('; ')
    } else {
      delete destinationHeaders.cookie
    }
    return destinationHeaders
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

function isDownloadResponse(headers: Record<string, string>): boolean {
  const disposition = headers['content-disposition']?.split(';', 1)[0]?.trim().toLowerCase()
  if (disposition === 'attachment') return true

  const contentType = headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (!contentType) return false
  if (/^(text\/|image\/|audio\/|video\/)/.test(contentType)) return false
  if ([
    'application/pdf',
    'application/json',
    'application/javascript',
    'application/ecmascript',
    'application/xml',
    'application/xhtml+xml',
  ].includes(contentType) || /\+(?:json|xml)$/.test(contentType)) return false
  return true
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
    case 'goBack':
      return 'Went back to the previous page in browser history.'
    case 'uploadFiles':
      return `Uploaded ${operation.files.length} file${operation.files.length === 1 ? '' : 's'} to the file input labeled "${operation.label}".`
    case 'press':
      return `Pressed ${operation.key}.`
    case 'scroll':
      return `Scrolled ${operation.direction} ${operation.amount} pixels.`
  }
}
