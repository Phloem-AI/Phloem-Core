import { Entry } from '@napi-rs/keyring'

const SERVICE_NAME = 'phloem'
const GEMMA_KEY_ACCOUNT = 'gemma-api-key'

export class CredentialStoreError extends Error {
  constructor(options?: ErrorOptions) {
    super('Unable to access the operating system credential store. Unlock or configure its secure keychain and try again.', options)
    this.name = 'CredentialStoreError'
  }
}

function createEntry(): Entry {
  if (process.platform === 'linux') {
    return new Entry(SERVICE_NAME, GEMMA_KEY_ACCOUNT, { linux: { store: 'secret-service' } })
  }
  return new Entry(SERVICE_NAME, GEMMA_KEY_ACCOUNT)
}

export function readGemmaApiKey(): string | undefined {
  try {
    return createEntry().getPassword() ?? undefined
  } catch (error) {
    throw new CredentialStoreError({ cause: error })
  }
}

export function saveGemmaApiKey(apiKey: string): void {
  if (apiKey.trim().length === 0) {
    throw new Error('The Gemma API key cannot be empty.')
  }

  try {
    createEntry().setPassword(apiKey)
  } catch (error) {
    throw new CredentialStoreError({ cause: error })
  }
}