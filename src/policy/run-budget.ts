export const RUN_LIMITS = {
  maxObjectives: 15,
  maxOperationsPerObjective: 25,
  maxOperationsPerRun: 150,
  maxRunDurationMs: 30 * 60 * 1000,
  minRequestIntervalMs: 6_000,
  maxRequestsPerMinute: 10,
  maxConsecutiveGemmaFailures: 3,
  requestTimeoutMs: 60_000,
} as const

export class RunLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RunLimitError'
  }
}

export class ThreeConsecutiveGemmaFailuresError extends Error {
  constructor(options?: ErrorOptions) {
    const failureReason = describeFailure(options?.cause)
    super(
      failureReason
        ? `Gemma failed to provide three consecutive usable responses. Last failure: ${failureReason}`
        : 'Gemma failed to provide three consecutive usable responses.',
      options,
    )
    this.name = 'ThreeConsecutiveGemmaFailuresError'
  }
}

function describeFailure(error: unknown): string {
  const causes: string[] = []
  let current = error
  while (current instanceof Error) {
    causes.push(`${current.name}: ${current.message}`)
    current = current.cause
  }
  if (causes.length === 0 && error !== undefined) return String(error)
  return causes.join(' -> ')
}

export class RunCancelledError extends Error {
  constructor() {
    super('The Phloem run was cancelled.')
    this.name = 'RunCancelledError'
  }
}

type RunBudgetOptions = {
  now?: () => number
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new RunCancelledError())

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new RunCancelledError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export class RunBudget {
  private readonly startedAt: number
  private readonly now: () => number
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  private requestQueue: Promise<void> = Promise.resolve()
  private requestStarts: number[] = []
  private lastRequestStart = 0
  private retryNotBefore = 0
  private consecutiveFailures = 0
  private objectiveCount = 0
  private objectiveOperations = 0
  private totalOperations = 0

  constructor(options: RunBudgetOptions = {}) {
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? sleep
    this.startedAt = this.now()
  }

  get operationsUsed(): number {
    return this.totalOperations
  }

  get objectivesStarted(): number {
    return this.objectiveCount
  }

  beginObjective(): void {
    this.assertWithinTimeLimit()
    if (this.objectiveCount >= RUN_LIMITS.maxObjectives) {
      throw new RunLimitError('The run reached its maximum of 15 objectives.')
    }
    this.objectiveCount += 1
    this.objectiveOperations = 0
  }

  recordBrowserOperation(): void {
    this.assertWithinTimeLimit()
    if (this.objectiveOperations >= RUN_LIMITS.maxOperationsPerObjective) {
      throw new RunLimitError('The objective reached its 25-operation limit.')
    }
    if (this.totalOperations >= RUN_LIMITS.maxOperationsPerRun) {
      throw new RunLimitError('The run reached its 150-operation limit.')
    }
    this.objectiveOperations += 1
    this.totalOperations += 1
  }

  runGemmaRequest<T>(request: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const result = this.requestQueue.then(() => this.executeGemmaRequest(request, signal))
    this.requestQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async executeGemmaRequest<T>(request: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.assertWithinTimeLimit(signal)
    this.requestStarts = this.requestStarts.filter((startedAt) => this.now() - startedAt < 60_000)

    const spacingDelay = Math.max(0, this.lastRequestStart + RUN_LIMITS.minRequestIntervalMs - this.now())
    const rollingWindowDelay =
      this.requestStarts.length >= RUN_LIMITS.maxRequestsPerMinute
        ? Math.max(0, this.requestStarts[0]! + 60_000 - this.now())
        : 0
    const providerDelay = Math.max(0, this.retryNotBefore - this.now())
    const waitMs = Math.max(spacingDelay, rollingWindowDelay, providerDelay)
    const remainingRunTime = RUN_LIMITS.maxRunDurationMs - (this.now() - this.startedAt)
    if (waitMs >= remainingRunTime) {
      throw new RunLimitError('The required Gemma retry wait would exceed the 30-minute run time limit.')
    }
    if (waitMs > 0) {
      await this.sleep(waitMs, signal)
      this.assertWithinTimeLimit(signal)
    }

    const requestStartedAt = this.now()
    this.requestStarts.push(requestStartedAt)
    this.lastRequestStart = requestStartedAt

    let result: T
    try {
      result = await request()
      this.consecutiveFailures = 0
    } catch (error) {
      if (error instanceof RunCancelledError) throw error
      const retryAfterMs =
        typeof error === 'object' && error !== null && 'retryAfterMs' in error
          ? (error as { retryAfterMs?: unknown }).retryAfterMs
          : undefined
      if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
        this.retryNotBefore = Math.max(this.retryNotBefore, this.now() + retryAfterMs)
      }
      this.consecutiveFailures += 1
      if (this.consecutiveFailures >= RUN_LIMITS.maxConsecutiveGemmaFailures) {
        throw new ThreeConsecutiveGemmaFailuresError({ cause: error })
      }
      throw error
    }

    this.assertWithinTimeLimit(signal)
    return result
  }

  private assertWithinTimeLimit(signal?: AbortSignal): void {
    if (signal?.aborted) throw new RunCancelledError()
    if (this.now() - this.startedAt >= RUN_LIMITS.maxRunDurationMs) {
      throw new RunLimitError('The run reached its 30-minute time limit.')
    }
  }
}
