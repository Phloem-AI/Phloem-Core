import { unzipSync, zipSync, type Zippable } from 'fflate'
import { redactText } from '../security/redaction.js'

const BINARY_ENTRY = /\.(png|jpe?g|gif|webp|ico|bmp|woff2?|ttf|otf|eot|zip|gz|br|pdf|mp4|webm|avif)$/i

/**
 * Rewrite a Playwright trace archive with the same write-time redaction pass used
 * for other evidence. Trace archives are zip files of NDJSON events and resource
 * payloads; text entries are redacted and re-encoded, binary entries are left
 * byte-for-byte intact. If no entry changes, the original bytes are returned.
 */
export function redactZipArchive(content: Uint8Array, secrets: readonly string[]): Uint8Array {
  const entries = unzipSync(content)
  let changed = false
  const files: Zippable = {}
  for (const [name, data] of Object.entries(entries)) {
    if (BINARY_ENTRY.test(name)) {
      files[name] = data
      continue
    }
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(data)
    } catch {
      // Not text (for example an image or font resource): keep the bytes as-is.
      files[name] = data
      continue
    }
    const redacted = redactText(text, secrets)
    if (redacted === text) {
      files[name] = data
      continue
    }
    changed = true
    files[name] = new TextEncoder().encode(redacted)
  }
  return changed ? zipSync(files) : content
}
