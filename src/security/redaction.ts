const CREDENTIAL_VALUE_PATTERN =
  /\b(?:password|passcode|secret|token|api[-_ ]?key|credential|username|user[-_ ]?name|email)\s*(?:is|:|=)\s*["']?([^\s,;"'`]+)/gi

export function extractSensitiveValues(brief: string): string[] {
  const values = new Set<string>()
  for (const match of brief.matchAll(CREDENTIAL_VALUE_PATTERN)) {
    const value = match[1]?.trim()
    if (value && value.length >= 3) values.add(value)
  }
  return [...values]
}

export function redactText(value: string, secrets: readonly string[] = []): string {
  let redacted = value
  for (const secret of secrets) {
    if (secret.length >= 3) redacted = redacted.replaceAll(secret, '[redacted]')
  }
  return redacted.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').slice(0, 1_000)
}