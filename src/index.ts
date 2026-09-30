#!/usr/bin/env node
import { collectRunInputs } from './cli/prompts.js'
import { updateGemmaApiKey } from './cli/prompts.js'

function printHelp(): void {
  console.log('Usage: phloem [--update-key | --help]')
  console.log('  --update-key  Replace the saved Gemma API key')
}

async function main(arguments_: string[] = process.argv.slice(2)): Promise<void> {
  if (arguments_.length === 1 && arguments_[0] === '--help') {
    printHelp()
    return
  }
  if (arguments_.length === 1 && arguments_[0] === '--update-key') {
    await updateGemmaApiKey()
    console.log('Gemma API key updated in the operating system credential store.')
    return
  }
  if (arguments_.length > 0) {
    throw new Error('Unknown command. Use --help to see available commands.')
  }

  const runInputs = await collectRunInputs()
  console.log(`Inputs validated for ${runInputs.websiteUrl.origin}.`)
  console.log('The browser exploration runner is not available yet.')
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'An unexpected setup error occurred.'
  console.error(`Phloem setup failed: ${message}`)
  process.exitCode = 1
})