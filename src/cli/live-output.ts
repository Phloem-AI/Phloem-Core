const stdout = process.stdout
let cursorSaved = false

function updateGemmaArea(content: string): void {
  if (!stdout.isTTY) return

  if (cursorSaved) {
    stdout.write('\x1B[u\x1B[J')
  } else {
    stdout.write('\x1B[s')
    cursorSaved = true
  }

  stdout.write(content)
}

export function renderGemmaRequest(requestNumber: number, task: string): void {
  updateGemmaArea('Gemma request #' + requestNumber + ': ' + task + '\nWaiting for response...')
}

export function renderGemmaResponse(requestNumber: number, task: string, parsedResponse: unknown): void {
  updateGemmaArea(
    'Gemma request #' + requestNumber + ': ' + task + '\n' + JSON.stringify(parsedResponse, null, 2),
  )
}

export function renderGemmaFailure(requestNumber: number, task: string, message: string): void {
  updateGemmaArea('Gemma request #' + requestNumber + ': ' + task + '\nFailed: ' + message)
}

export function clearGemmaArea(): void {
  if (!stdout.isTTY || !cursorSaved) return
  stdout.write('\x1B[u\x1B[J')
  cursorSaved = false
}