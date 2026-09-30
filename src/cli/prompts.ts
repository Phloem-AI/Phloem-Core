import { input, password } from '@inquirer/prompts'
import { readGemmaApiKey, saveGemmaApiKey } from '../credentials/key-store.js'
import { createNavigationPolicy, parseWebsiteUrl, type NavigationPolicy } from '../policy/url-policy.js'

export const URL_PROMPT = 'Enter website URL. Make sure it is safe for public visibility and contains no confidential information.'

export const BRIEF_WARNING =
  "Ensure the website you're testing doesn't contain any malware/installable viruses and is safe for public viewing (doesn't contain any credentials). If the website requires auth, please add the demo credentials in the product brief, and clearly label them as required for auth. The product brief, including these demo credentials, will be sent to Google Gemma. Never provide production credentials, API keys, or other confidential information."

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
      password({
        message: 'Enter your Google AI Studio / Gemini API key for Gemma',
        mask: '*',
        validate: (value) => (value.trim().length > 0 ? true : 'The API key cannot be empty.'),
      }),
    askForUrl: () =>
      input({
        message: URL_PROMPT,
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
      input({
        message: 'Enter the product brief',
        validate: validateBrief,
      }),
    writeWarning: (message) => console.warn(message),
  }
}

export async function collectRunInputs(
  dependencies: PromptDependencies = createPromptDependencies(),
  terminalCheck: () => void = requireInteractiveTerminal,
): Promise<RunInputs> {
  terminalCheck()

  let apiKey = dependencies.readKey()
  if (!apiKey) {
    apiKey = await dependencies.askForKey()
    if (apiKey.trim().length === 0) throw new Error('The Gemma API key cannot be empty.')
    dependencies.saveKey(apiKey)
  }

  const websiteUrl = parseWebsiteUrl(await dependencies.askForUrl())
  dependencies.writeWarning(BRIEF_WARNING)
  const brief = await dependencies.askForBrief()
  const briefValidation = validateBrief(brief)
  if (briefValidation !== true) throw new Error(briefValidation)

  return {
    apiKey,
    websiteUrl,
    brief: brief.trim(),
    navigationPolicy: createNavigationPolicy(websiteUrl, brief),
  }
}