import { createPrompt, isEnterKey, makeTheme, useKeypress, usePrefix, useState } from '@inquirer/core'
import clipboard from 'clipboardy'
import { readGemmaApiKey, saveGemmaApiKey } from '../credentials/key-store.js'
import { createNavigationPolicy, parseWebsiteUrl, type NavigationPolicy } from '../policy/url-policy.js'

export const URL_PROMPT = 'Enter website URL. Make sure it is safe for public visibility and contains no confidential information.'

export const BRIEF_WARNING =
  "Ensure the website you're testing doesn't contain any malware/installable viruses and is safe for public viewing (doesn't contain any credentials). If the website requires auth, please add the demo credentials in the product brief, and clearly label them as required for auth. The product brief, including these demo credentials, will be sent to Google Gemma. Never provide production credentials, API keys, or other confidential information."

const LIGHT_YELLOW = '\u001b[38;5;229m'
const WHITE = '\u001b[97m'
const ANSI_RESET = '\u001b[0m'

function formatDisclaimer(message: string): string {
  const terminalWidth = process.stdout.columns || 80
  const contentWidth = Math.max(12, Math.min(88, terminalWidth - 10))
  const lines: string[] = []
  let currentLine = ''

  for (const word of message.trim().split(/\s+/)) {
    if (currentLine.length > 0 && currentLine.length + word.length + 1 > contentWidth) {
      lines.push(currentLine)
      currentLine = word
    } else {
      currentLine = currentLine.length > 0 ? currentLine + ' ' + word : word
    }
  }
  if (currentLine.length > 0) lines.push(currentLine)

  const border = '  +' + '-'.repeat(contentWidth + 4) + '+'
  const paddedLines = lines.map((line) => '  |  ' + line.padEnd(contentWidth) + '  |')
  return LIGHT_YELLOW + [border, ...paddedLines, border].join('\n') + ANSI_RESET + '\n\n'
}

export interface RunInputs {
  apiKey: string
  websiteUrl: URL
  brief: string
  navigationPolicy: NavigationPolicy
}

export interface PromptDependencies {
  readKey: () => string | undefined
  saveKey: (apiKey: string) => void
  askForKey: () => Promise<string>
  askForUrl: () => Promise<string>
  askForBrief: () => Promise<string>
  writeWarning: (message: string) => void
}

type PasteablePromptConfig = {
  message: string
  mask?: string
  padded?: boolean
  validate?: (value: string) => true | string | Promise<true | string>
}

const pasteableInput = createPrompt<string, PasteablePromptConfig>((config, done) => {
  const theme = makeTheme()
  const [status, setStatus] = useState<'idle' | 'loading' | 'done'>('idle')
  const [value, setValue] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | undefined>()
  const prefix = usePrefix({ status, theme })

  useKeypress(async (key, readline) => {
    if (status !== 'idle') return

    if (key.ctrl && key.name === 'v') {
      setStatus('loading')
      try {
        const pastedText = normalizePastedText(await clipboard.read())
        if (pastedText.length === 0) {
          setErrorMessage('The clipboard does not contain any text.')
        } else {
          readline.write(pastedText)
          setValue(readline.line)
          setErrorMessage(undefined)
        }
      } catch {
        setErrorMessage('Could not read text from the clipboard.')
      } finally {
        setStatus('idle')
      }
      return
    }

    if (isEnterKey(key)) {
      const answer = value
      setStatus('loading')
      const validation = await config.validate?.(answer) ?? true
      if (validation === true) {
        setValue(answer)
        setStatus('done')
        done(answer)
      } else {
        setValue(answer)
        setErrorMessage(validation)
        setStatus('idle')
        readline.write(answer)
      }
      return
    }

    setValue(readline.line)
    setErrorMessage(undefined)
  })

  const visibleValue = config.mask ? config.mask.repeat(value.length) : value
  const displayedValue = status === 'done' ? theme.style.answer(visibleValue) : visibleValue
  const styledMessage = config.padded
    ? WHITE + config.message + ':' + ANSI_RESET
    : theme.style.message(config.message, status)
  const content = [prefix, styledMessage, displayedValue].filter(Boolean).join(' ')
  const paddedContent = config.padded ? '  ' + content + '  ' : content
  const renderedContent = config.padded ? '\n' + paddedContent + '\n' : paddedContent
  const error = errorMessage ? theme.style.error(errorMessage) : ''
  return [renderedContent, error]
})

function normalizePastedText(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}

export function requireInteractiveTerminal(
  stdin: Pick<NodeJS.ReadStream, 'isTTY'> = process.stdin,
  stdout: Pick<NodeJS.WriteStream, 'isTTY'> = process.stdout,
): void {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error('Phloem setup requires an interactive terminal. Run it from a terminal that supports prompts.')
  }
}

export function validateBrief(value: string): true | string {
  const brief = value.trim()
  if (brief.length === 0) return 'Enter a product brief.'
  if (brief.length > 20_000) return 'The product brief must be 20,000 characters or fewer.'
  return true
}

function createPromptDependencies(): PromptDependencies {
  return {
    readKey: readGemmaApiKey,
    saveKey: saveGemmaApiKey,
    askForKey: () =>
      pasteableInput({
        message: 'Enter your Google AI Studio / Gemini API key for Gemma',
        mask: '*',
        validate: (value) => (value.trim().length > 0 ? true : 'The API key cannot be empty.'),
      }),
    askForUrl: () =>
      pasteableInput({
        message: 'Enter URL',
        padded: true,
        validate: (value) => {
          try {
            parseWebsiteUrl(value)
            return true
          } catch (error) {
            return error instanceof Error ? error.message : 'Enter a valid website URL.'
          }
        },
      }),
    askForBrief: () =>
      pasteableInput({
        message: 'Enter Product Definition',
        padded: true,
        validate: validateBrief,
      }),
    writeWarning: (message) => process.stdout.write(formatDisclaimer(message)),
  }
}

export async function collectRunInputs(
  dependencies: PromptDependencies = createPromptDependencies(),
  terminalCheck: () => void = requireInteractiveTerminal,
): Promise<RunInputs> {
  terminalCheck()
  dependencies.writeWarning(BRIEF_WARNING)

  const websiteUrl = parseWebsiteUrl(await dependencies.askForUrl())
  const brief = await dependencies.askForBrief()
  const briefValidation = validateBrief(brief)
  if (briefValidation !== true) throw new Error(briefValidation)

  let apiKey = dependencies.readKey()
  if (!apiKey) {
    apiKey = (await dependencies.askForKey()).trim()
    if (apiKey.length === 0) throw new Error('The Gemma API key cannot be empty.')
    dependencies.saveKey(apiKey)
  }

  return {
    apiKey,
    websiteUrl,
    brief: brief.trim(),
    navigationPolicy: createNavigationPolicy(websiteUrl, brief),
  }
}

export async function updateGemmaApiKey(
  dependencies: Pick<PromptDependencies, 'askForKey' | 'saveKey'> = createPromptDependencies(),
  terminalCheck: () => void = requireInteractiveTerminal,
): Promise<void> {
  terminalCheck()
  const apiKey = (await dependencies.askForKey()).trim()
  if (apiKey.length === 0) throw new Error('The Gemma API key cannot be empty.')
  dependencies.saveKey(apiKey)
}
