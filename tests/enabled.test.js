import { describe, it, expect } from 'vitest'
import { SERVICE_NAME, resolveBase, isBackendEnabled } from '../src/client.js'
import * as client from '../src/client.js'
import * as entry from '../src/index.js'

// Website-shaped: `resolveService` reads `.config` and `.basePath` only.
const site = (config, basePath = '') => ({ config, basePath })

describe('the backend service', () => {
  it('owns exactly one name', () => {
    expect(SERVICE_NAME).toBe('backend')
  })

  it('is absent on a site that declares no backend — the ordinary state', () => {
    expect(resolveBase(site({}))).toBeNull()
    expect(isBackendEnabled(site({}))).toBe(false)
  })

  it("reads the host's declaration, joined to the site base", () => {
    const s = site({ services: { backend: { endpoint: '/_uw' } } }, '/docs')
    expect(resolveBase(s)).toBe('/docs/_uw')
    expect(isBackendEnabled(s)).toBe(true)
  })

  it("uses the site's own declaration where the host offers no backend service, and passes an absolute URL through", () => {
    const s = site({ backend: 'https://api.example.com', services: { submit: { endpoint: '/forms' } } })
    expect(resolveBase(s)).toBe('https://api.example.com')
  })

  it("prefers the host's backend service over the site's own declaration", () => {
    // Reversed 2026-09-10: where the host offers the service, its address wins.
    const s = site({ backend: 'https://api.example.com', services: { backend: { endpoint: '/_uw' } } })
    expect(resolveBase(s)).toContain('/_uw')
    expect(resolveBase(s)).not.toContain('api.example.com')
  })

  it('is absent when the host answered and offered no address', () => {
    // A services block is the host's statement of what it offers; a name
    // missing from it is a decline, not "no host" (core/src/services.js).
    expect(isBackendEnabled(site({ services: { submit: { endpoint: '/forms' } } }))).toBe(false)
    expect(isBackendEnabled(site({ services: { backend: {} } }))).toBe(false)
  })

  // ⛔ THE RENAME THIS PINS (2026-10-07): the service was `api`. A host offering
  // only the old name offers nothing this package reads — and the old predicate is
  // gone, so a foundation still importing it fails at its build, not on a page.
  it('reads nothing under the old name, and exports no predicate by it', () => {
    expect(resolveBase(site({ services: { api: { endpoint: '/_api' } } }))).toBeNull()
    expect(resolveBase(site({ api: '/_api' }))).toBeNull()
    expect('isApiEnabled' in client).toBe(false)
    expect('isApiEnabled' in entry).toBe(false)
    expect(typeof entry.isBackendEnabled).toBe('function')
  })
})

describe('the no-argument form', () => {
  // ⛔ THE TRAP THIS PINS. For one commit the website was REQUIRED while every
  // doc and template showed the no-argument call — so the documented call resolved
  // `undefined` and returned false forever, drawing no sign-in UI on a site that
  // had a backend. Silent, and identical to a site with none.
  it('reads the ACTIVE website when called with no argument', () => {
    const site = { config: { backend: '/_api' }, basePath: '' }
    const previous = globalThis.uniweb
    globalThis.uniweb = { activeWebsite: site }
    try {
      expect(isBackendEnabled()).toBe(true)
      expect(isBackendEnabled()).toBe(isBackendEnabled(site))
    } finally {
      globalThis.uniweb = previous
    }
  })

  it('is false, not a throw, before the runtime has initialized', () => {
    const previous = globalThis.uniweb
    globalThis.uniweb = undefined
    try {
      expect(isBackendEnabled()).toBe(false)
    } finally {
      globalThis.uniweb = previous
    }
  })
})
