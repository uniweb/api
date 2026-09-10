import { describe, it, expect } from 'vitest'
import { SERVICE_NAME, resolveBase, isApiEnabled } from '../src/client.js'

// Website-shaped: `resolveService` reads `.config` and `.basePath` only.
const site = (config, basePath = '') => ({ config, basePath })

describe('the api service', () => {
  it('owns exactly one name', () => {
    expect(SERVICE_NAME).toBe('api')
  })

  it('is absent on a site that declares no backend — the ordinary state', () => {
    expect(resolveBase(site({}))).toBeNull()
    expect(isApiEnabled(site({}))).toBe(false)
  })

  it("reads the host's declaration, joined to the site base", () => {
    const s = site({ services: { api: { endpoint: '/_uw' } } }, '/docs')
    expect(resolveBase(s)).toBe('/docs/_uw')
    expect(isApiEnabled(s)).toBe(true)
  })

  it("uses the site's own declaration where the host offers no api service, and passes an absolute URL through", () => {
    const s = site({ api: 'https://api.example.com', services: { submit: { endpoint: '/forms' } } })
    expect(resolveBase(s)).toBe('https://api.example.com')
  })

  it("prefers the host's api service over the site's own declaration", () => {
    // Reversed 2026-09-10: where the host offers the service, its address wins.
    const s = site({ api: 'https://api.example.com', services: { api: { endpoint: '/_uw' } } })
    expect(resolveBase(s)).toContain('/_uw')
    expect(resolveBase(s)).not.toContain('api.example.com')
  })

  it('is absent when the host answered and offered no address', () => {
    // A services block is the host's statement of what it offers; a name
    // missing from it is a decline, not "no host" (core/src/services.js).
    expect(isApiEnabled(site({ services: { submit: { endpoint: '/forms' } } }))).toBe(false)
    expect(isApiEnabled(site({ services: { api: {} } }))).toBe(false)
  })
})

describe('the no-argument form', () => {
  // ⛔ THE TRAP THIS PINS. For one commit the website was REQUIRED while every
  // doc and template showed `isApiEnabled()` — so the documented call resolved
  // `undefined` and returned false forever, drawing no sign-in UI on a site that
  // had a backend. Silent, and identical to a site with none.
  it('reads the ACTIVE website when called with no argument', () => {
    const site = { config: { api: '/_api' }, basePath: '' }
    const previous = globalThis.uniweb
    globalThis.uniweb = { activeWebsite: site }
    try {
      expect(isApiEnabled()).toBe(true)
      expect(isApiEnabled()).toBe(isApiEnabled(site))
    } finally {
      globalThis.uniweb = previous
    }
  })

  it('is false, not a throw, before the runtime has initialized', () => {
    const previous = globalThis.uniweb
    globalThis.uniweb = undefined
    try {
      expect(isApiEnabled()).toBe(false)
    } finally {
      globalThis.uniweb = previous
    }
  })
})
