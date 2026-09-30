import assert from 'node:assert/strict'
import test from 'node:test'
import { createNavigationPolicy, parseWebsiteUrl, resolveAllowedNavigation, UrlPolicyError } from '../src/policy/url-policy.js'

test('website URLs accept http(s) and preserve the supplied path', () => {
  const url = parseWebsiteUrl('https://example.test/app?mode=demo')
  assert.equal(url.href, 'https://example.test/app?mode=demo')
  assert.throws(() => parseWebsiteUrl('javascript:alert(1)'), UrlPolicyError)
  assert.throws(() => parseWebsiteUrl('https://user:secret@example.test'), UrlPolicyError)
})

test('navigation permits same-origin paths and exact origins named in the brief', () => {
  const startUrl = parseWebsiteUrl('https://example.test/app')
  const policy = createNavigationPolicy(startUrl, 'Complete checkout at https://payments.test/checkout')
  assert.equal(resolveAllowedNavigation('/account', startUrl.href, policy).href, 'https://example.test/account')
  assert.equal(
    resolveAllowedNavigation('https://payments.test/checkout', startUrl.href, policy).origin,
    'https://payments.test',
  )
  assert.throws(() => resolveAllowedNavigation('https://unknown.test', startUrl.href, policy), UrlPolicyError)
})

test('navigation rejects subdomains even if mentioned in the brief', () => {
  const startUrl = parseWebsiteUrl('https://example.test')
  const policy = createNavigationPolicy(startUrl, 'Visit https://shop.example.test')
  assert.throws(() => resolveAllowedNavigation('https://shop.example.test', startUrl.href, policy), /subdomains/)
})