import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { BrowserOperationError, BrowserSession } from '../src/browser/session.js'
import { AssertionSchema } from '../src/contracts.js'
import { evaluateAssertions } from '../src/assert/engine.js'
import { createNavigationPolicy, parseWebsiteUrl } from '../src/policy/url-policy.js'

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not bind fixture server.')
  return `http://127.0.0.1:${address.port}`
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
}

test('Chromium snapshots accessible UI, redacts sensitive fields, and executes an allowed click', async (context) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(`<!doctype html><html><body>
      <h1>Demo shop</h1>
      <label for="password">Password</label><input id="password" type="password" value="demo-pass">
      <button id="add">Add to cart</button><p id="status" aria-live="polite">Cart is empty</p>
      <script>document.querySelector('#add').addEventListener('click', () => { document.querySelector('#status').textContent = 'Cart has one item' })</script>
    </body></html>`)
  })
  const baseUrl = await listen(server)
  context.after(() => close(server))
  const websiteUrl = parseWebsiteUrl(`${baseUrl}/shop`)
  const session = await BrowserSession.open({
    startUrl: websiteUrl,
    navigationPolicy: createNavigationPolicy(websiteUrl, ''),
    sensitiveValues: ['demo-pass'],
  })

  try {
    const before = await session.observe()
    assert.match(before, /Demo shop/)
    assert.match(before, /Add to cart/)
    assert.equal(before.includes('demo-pass'), false)
    const initialAssertions = [
      AssertionSchema.parse({ type: 'elementVisible', target: { role: 'heading', name: 'Demo shop' }, timeoutMs: 0 }),
      AssertionSchema.parse({ type: 'textVisible', text: 'Cart is empty', timeoutMs: 0 }),
      AssertionSchema.parse({
        type: 'elementState',
        target: { role: 'button', name: 'Add to cart' },
        state: 'checked',
        timeoutMs: 0,
      }),
    ]
    const initialResults = await evaluateAssertions(initialAssertions, { page: session.assertionPage, facts: session.facts })
    assert.deepEqual(initialResults.map((result) => result.pass), [true, true, false])
    assert.match(initialResults[2]?.detail ?? '', /requires a checkbox or radio role/)

    const operation = { type: 'click', target: { role: 'button', name: 'Add to cart', exact: true } } as const
    await session.execute(operation)
    const after = await session.observe()
    assert.match(after, /Cart has one item/)
    const result = await evaluateAssertions(
      [AssertionSchema.parse({ type: 'textVisible', text: 'Cart has one item', timeoutMs: 0 })],
      { page: session.assertionPage, facts: session.facts },
    )
    assert.equal(result[0]?.pass, true)
  } finally {
    await session.close()
  }
})

test('Chromium blocks navigation to an origin not named in the brief', async (context) => {
  let externalRequests = 0
  const externalServer = createServer((_request, response) => {
    externalRequests += 1
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><html><body><h1>Named external destination</h1></body></html>')
  })

  const externalUrl = await listen(externalServer)
  context.after(() => close(externalServer))

  const siteServer = createServer((request, response) => {
    if (request.url === '/redirect' || request.url === '/allowed-redirect') {
      response.writeHead(302, { location: `${externalUrl}/outside` })
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><html><body><h1>Allowed app</h1></body></html>')
  })
  const baseUrl = await listen(siteServer)
  context.after(() => close(siteServer))
  const websiteUrl = parseWebsiteUrl(baseUrl)
  const session = await BrowserSession.open({
    startUrl: websiteUrl,
    navigationPolicy: createNavigationPolicy(websiteUrl, ''),
  })

  try {
    const navigationResult = await session.execute({ type: 'navigate', url: '/redirect' }).catch((error: unknown) => error)
    assert.equal(externalRequests, 0)
    assert.ok(navigationResult instanceof BrowserOperationError)
  } finally {
    await session.close()
  }

  const allowedBrief = `The login flow may redirect to ${externalUrl}/outside.`
  const allowedSession = await BrowserSession.open({
    startUrl: websiteUrl,
    navigationPolicy: createNavigationPolicy(websiteUrl, allowedBrief),
  })
  try {
    await allowedSession.execute({ type: 'navigate', url: '/allowed-redirect' })
    assert.equal(allowedSession.currentUrl, `${externalUrl}/outside`)
    assert.match(await allowedSession.observe(), /Named external destination/)
    assert.equal(externalRequests, 1)
  } finally {
    await allowedSession.close()
  }
})

test('Chromium captures cross-origin file downloads without allowing external page navigation', async (context) => {
  const fileContent = 'external download contents'
  let externalRequests = 0
  const externalServer = createServer((request, response) => {
    externalRequests += 1
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/report' })
      response.end()
      return
    }
    if (request.url === '/report') {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="report.bin"',
      })
      response.end(fileContent)
      return
    }
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><html><body><h1>External page</h1></body></html>')
  })
  const externalUrl = await listen(externalServer)
  context.after(() => close(externalServer))

  const siteServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(`<!doctype html><html><body>
      <a href="${externalUrl}/redirect">Download report</a>
      <a href="${externalUrl}/page">External page</a>
    </body></html>`)
  })
  const siteUrl = await listen(siteServer)
  context.after(() => close(siteServer))
  const startUrl = parseWebsiteUrl(siteUrl)
  const session = await BrowserSession.open({
    startUrl,
    navigationPolicy: createNavigationPolicy(startUrl),
  })

  try {
    await session.execute({ type: 'click', target: { role: 'link', name: 'Download report', exact: true } })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(session.currentUrl, siteUrl + '/')
    const downloads = session.listDownloads()
    assert.equal(downloads.length, 1, `externalRequests=${externalRequests}`)
    assert.equal(downloads[0]?.fileName, 'report.bin')
    const content = await session.readDownload(downloads[0]!.downloadId)
    assert.equal(content.encoding, 'utf-8')
    assert.equal(content.content, fileContent)
    assert.equal(externalRequests, 2)

    const navigationResult = await session.execute({
      type: 'click',
      target: { role: 'link', name: 'External page', exact: true },
    }).catch((error: unknown) => error)
    assert.ok(navigationResult instanceof BrowserOperationError)
    assert.match(navigationResult.message, /origin policy/)
    assert.equal(session.currentUrl.startsWith(externalUrl), false)
    assert.equal(externalRequests, 3)
  } finally {
    await session.close()
  }
})

test('session taps record page errors, console warnings, and HTTP failures', async (context) => {
  const server = createServer((request, response) => {
    if (request.url === '/api/failure') {
      response.writeHead(500, { 'content-type': 'text/plain' })
      response.end('failed')
      return
    }
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(`<!doctype html><html><body>
      <h1>Instrumentation fixture</h1>
      <script>
        console.warn('fixture warning');
        console.error('fixture console error');
        fetch('/api/failure');
        setTimeout(() => { throw new Error('fixture page error'); }, 0);
      </script>
    </body></html>`)
  })

  const baseUrl = await listen(server)
  context.after(() => close(server))
  const websiteUrl = parseWebsiteUrl(baseUrl)
  const session = await BrowserSession.open({
    startUrl: websiteUrl,
    navigationPolicy: createNavigationPolicy(websiteUrl),
  })

  try {
    await new Promise((resolve) => setTimeout(resolve, 200))
    const kinds = session.facts.all().map((fact) => fact.kind)
    assert.ok(kinds.includes('pageerror'))
    assert.ok(kinds.includes('console'))
    assert.ok(session.facts.all().some((fact) => fact.kind === 'http' && fact.status === 500))
    assert.ok(session.facts.all().some((fact) => fact.kind === 'console' && fact.level === 'warning'))
  } finally {
    await session.close()
  }
})

test('observe truncation flags reflect content beyond configured caps', async (context) => {
  const longText = 'a'.repeat(8_100)
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(`<!doctype html><html><body>${longText}</body></html>`)
  })
  const baseUrl = await listen(server)
  context.after(() => close(server))
  const startUrl = parseWebsiteUrl(baseUrl)
  const session = await BrowserSession.open({
    startUrl,
    navigationPolicy: createNavigationPolicy(startUrl),
  })
  try {
    const observation = JSON.parse(await session.observe()) as { truncated: { visibleText: boolean } }
    assert.equal(observation.truncated.visibleText, true)
  } finally {
    await session.close()
  }
})

test('observe can wait for delayed SPA content before taking its snapshot', async (context) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(`<!doctype html><html><body>
      <main id="app">Loading...</main>
      <script>setTimeout(() => { document.querySelector('#app').textContent = 'Dynamically loaded content'; }, 300)</script>
    </body></html>`)
  })
  const baseUrl = await listen(server)
  context.after(() => close(server))
  const startUrl = parseWebsiteUrl(baseUrl)
  const session = await BrowserSession.open({
    startUrl,
    navigationPolicy: createNavigationPolicy(startUrl),
  })
  try {
    const immediate = JSON.parse(await session.observe()) as { visibleText: string }
    assert.match(immediate.visibleText, /Loading/)
    const afterWait = JSON.parse(await session.observe(500)) as { visibleText: string }
    assert.match(afterWait.visibleText, /Dynamically loaded content/)
  } finally {
    await session.close()
  }
})

test('a later dialog fact does not rewrite the preceding action result', async (context) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(`<!doctype html><html><body>
      <button>Open dialog</button>
      <script>
        document.querySelector('button').addEventListener('click', () => {
          setTimeout(() => alert('fixture dialog'), 50);
        });
      </script>
    </body></html>`)
  })
  const baseUrl = await listen(server)
  context.after(() => close(server))
  const startUrl = parseWebsiteUrl(baseUrl)
  const session = await BrowserSession.open({
    startUrl,
    navigationPolicy: createNavigationPolicy(startUrl),
  })
  try {
    await session.execute({ type: 'click', target: { role: 'button', name: 'Open dialog', exact: true } })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const observation = JSON.parse(await session.observe()) as {
      actionStatus: { ok: boolean } | undefined
      facts: { counts: { dialog: number } }
    }
    assert.equal(observation.actionStatus?.ok, true)
    assert.equal(observation.facts.counts.dialog, 1)
  } finally {
    await session.close()
  }
})