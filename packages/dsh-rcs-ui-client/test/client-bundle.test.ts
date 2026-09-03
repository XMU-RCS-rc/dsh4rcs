import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const bundlePath = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const hasBundle = existsSync(bundlePath)
const bundle = hasBundle ? readFileSync(bundlePath, 'utf8') : ''
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

describe.skipIf(!hasBundle)('RCS browser UI bundle', () => {
  it('registers an additive sidebar action without replacing host UI', () => {
    expect(bundle).toContain('sidebar.footer.action')
    expect(bundle).toContain('rcs-team-brand')
    expect(bundle).not.toContain('name: "sidebar"')
  })

  it('exports package.json so dsh can discover the browser half', () => {
    expect(manifest.exports['./package.json']).toBe('./package.json')
    expect(manifest.dsh.client.platform).toBe('web')
  })

  it('embeds the supplied emblem so installed packages need no filesystem URL', () => {
    expect(bundle).toContain('data:image/png;base64,')
    expect(bundle).toContain('xmu-rcs-emblem-128')
    expect(Buffer.byteLength(bundle)).toBeLessThan(60_000)
  })

  it('keeps the brand entry accessible and links to the team repository', () => {
    expect(bundle).toContain('"aria-label"')
    expect(bundle).toContain('"data-rcs-team-brand"')
    expect(bundle).toContain('https://github.com/XMU-RCS-rc/dsh4rcs')
  })
})
