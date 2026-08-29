import { describe, it, expect } from 'vitest'
import { SERVICE_NAME, resolveBase, isEnabled } from '../src/client.js'

// Website-shaped: `resolveService` reads `.config` and `.basePath` only.
const site = (config, basePath = '') => ({ config, basePath })

describe('the api service', () => {
  it('owns exactly one name', () => {
    expect(SERVICE_NAME).toBe('api')
  })

  it('is absent on a site that declares no backend — the ordinary state', () => {
    expect(resolveBase(site({}))).toBeNull()
    expect(isEnabled(site({}))).toBe(false)
  })

  it("reads the host's declaration, joined to the site base", () => {
    const s = site({ services: { api: { endpoint: '/_uw' } } }, '/docs')
    expect(resolveBase(s)).toBe('/docs/_uw')
    expect(isEnabled(s)).toBe(true)
  })

  it("lets the site's own declaration win, and passes an absolute URL through", () => {
    const s = site({ api: 'https://api.example.com', services: { api: { endpoint: '/_uw' } } })
    expect(resolveBase(s)).toBe('https://api.example.com')
  })

  it('is absent when the host answered and offered no address', () => {
    // A services block is the host's statement of what it offers; a name
    // missing from it is a decline, not "no host" (core/src/services.js).
    expect(isEnabled(site({ services: { submit: { endpoint: '/forms' } } }))).toBe(false)
    expect(isEnabled(site({ services: { api: {} } }))).toBe(false)
  })
})
