import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { BrowserOperationError, BrowserSession } from '../src/browser/session.js'
import { RunBudget } from '../src/policy/run-budget.js'
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
    budget: new RunBudget(),
    sensitiveValues: ['demo-pass'],
  })

  try {
    const before = await session.observe()
    assert.match(before, /Demo shop/)
    assert.match(before, /Add to cart/)
    assert.equal(before.includes('demo-pass'), false)

    const operation = { type: 'click', target: { role: 'button', name: 'Add to cart', exact: true } } as const
    await session.execute(operation)
    const after = await session.observe()
    assert.match(after, /Cart has one item/)
  } finally {
    await session.close()
  }
})

test('Chromium blocks navigation to an origin not named in the brief', async (context) => {
  let externalRequests = 0
  const externalServer = createServer((_request, response) => {
    externalRequests += 1
    response.end('should not be reached')
  })
  const externalUrl = await listen(externalServer)
  context.after(() => close(externalServer))

  const siteServer = createServer((request, response) => {
    if (request.url === '/redirect') {
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
    budget: new RunBudget(),
  })

  try {
    const navigationResult = await session.execute({ type: 'navigate', url: '/redirect' }).catch((error: unknown) => error)
    assert.equal(externalRequests, 0)
    assert.ok(navigationResult instanceof BrowserOperationError)
  } finally {
    await session.close()
  }
})