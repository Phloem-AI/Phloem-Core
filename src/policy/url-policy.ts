const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/gi

export class UrlPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UrlPolicyError'
  }
}

export interface NavigationPolicy {
  readonly startUrl: URL
  readonly baseHostname: string
  readonly allowedOrigins: ReadonlySet<string>
}

export function parseWebsiteUrl(value: string): URL {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 2048) {
    throw new UrlPolicyError('Enter a website URL between 1 and 2048 characters long.')
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new UrlPolicyError('Enter a valid absolute website URL, including http:// or https://.')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlPolicyError('Only http:// and https:// website URLs are supported.')
  }
  if (url.username || url.password) {
    throw new UrlPolicyError('Do not put credentials in the website URL.')
  }
  if (!url.hostname) {
    throw new UrlPolicyError('The website URL must include a hostname.')
  }

  return url
}

function isSubdomain(hostname: string, baseHostname: string): boolean {
  return hostname !== baseHostname && hostname.endsWith(`.${baseHostname}`)
}

function extractExplicitOrigins(brief: string, baseHostname: string): Set<string> {
  const origins = new Set<string>()

  for (const match of brief.matchAll(URL_PATTERN)) {
    const candidate = match[0].replace(/[.,;:!?]+$/, '')
    try {
      const url = parseWebsiteUrl(candidate)
      if (!isSubdomain(url.hostname, baseHostname)) {
        origins.add(url.origin)
      }
    } catch {
      // Ignore non-URL text that happens to match the pattern.
    }
  }

  return origins
}

export function createNavigationPolicy(startUrl: URL, brief: string): NavigationPolicy {
  const allowedOrigins = extractExplicitOrigins(brief, startUrl.hostname)
  allowedOrigins.add(startUrl.origin)

  return {
    startUrl,
    baseHostname: startUrl.hostname,
    allowedOrigins,
  }
}

export function resolveAllowedNavigation(
  candidate: string,
  currentUrl: string,
  policy: NavigationPolicy,
): URL {
  let resolved: URL
  try {
    resolved = new URL(candidate, currentUrl)
  } catch {
    throw new UrlPolicyError('Gemma proposed an invalid navigation URL.')
  }

  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    throw new UrlPolicyError('Navigation is limited to http:// and https:// URLs.')
  }
  if (resolved.username || resolved.password) {
    throw new UrlPolicyError('Navigation URLs must not contain credentials.')
  }
  if (isSubdomain(resolved.hostname, policy.baseHostname)) {
    throw new UrlPolicyError('Phloem does not explore subdomains.')
  }
  if (!policy.allowedOrigins.has(resolved.origin)) {
    throw new UrlPolicyError('Navigation target is outside the origins allowed by the original brief.')
  }

  return resolved
}