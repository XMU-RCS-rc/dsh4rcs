import { describe, expect, it, vi } from 'vitest'

import { installRcsTheme, rcsThemeTokens } from '../src/theme.js'

type Scheme = 'light' | 'dark'

function token(name: string) {
  const modes = rcsThemeTokens[name]
  if (!modes) throw new Error(`missing RCS theme token: ${name}`)
  return modes
}

function luminance(hex: string): number {
  const channels = hex.slice(1).match(/../g)?.map((value) => Number.parseInt(value, 16) / 255)
  if (!channels || channels.length !== 3) throw new Error(`expected six-digit hex color, got ${hex}`)
  const linear = channels.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  )
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
}

function contrast(left: string, right: string): number {
  const a = luminance(left)
  const b = luminance(right)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

describe('RCS page-wide theme', () => {
  it('supplies a light and dark value for every override', () => {
    for (const modes of Object.values(rcsThemeTokens)) {
      expect(typeof modes.light).toBe('string')
      expect(typeof modes.dark).toBe('string')
      expect(modes.light.length).toBeGreaterThan(0)
      expect(modes.dark.length).toBeGreaterThan(0)
    }
  })

  it('keeps ordinary text readable on the main page surfaces', () => {
    const labels = [
      '--dsw-alias-label-primary',
      '--dsw-alias-label-secondary',
      '--dsw-alias-label-tertiary',
      '--dsw-alias-label-caption',
    ] as const
    const surfaces = [
      '--dsw-alias-bg-base',
      '--dsw-alias-bg-layer-1',
      '--dsw-alias-bg-layer-2',
      '--dsw-alias-bg-layer-3',
      '--dsw-specific-input-major',
      '--dsw-specific-menu',
      '--dsw-specific-sidebar-fill',
    ] as const

    for (const scheme of ['light', 'dark'] as Scheme[]) {
      for (const label of labels) {
        for (const surface of surfaces) {
          expect(contrast(token(label)[scheme], token(surface)[scheme])).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })

  it('keeps inverse text readable on buttons, tooltips, and toasts', () => {
    for (const scheme of ['light', 'dark'] as Scheme[]) {
      expect(contrast(
        token('--dsw-alias-label-primary-foreground')[scheme],
        token('--dsw-alias-button-primary-fill')[scheme],
      )).toBeGreaterThanOrEqual(4.5)
      expect(contrast('#ffffff', token('--dsw-alias-tooltip-bg')[scheme])).toBeGreaterThanOrEqual(4.5)
      expect(contrast('#ffffff', token('--dsw-alias-toast-bg')[scheme])).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('leaves semantic error, success, and warning colors to the host', () => {
    expect(rcsThemeTokens).not.toHaveProperty('--dsw-alias-state-error-primary')
    expect(rcsThemeTokens).not.toHaveProperty('--dsw-alias-state-success-primary')
    expect(rcsThemeTokens).not.toHaveProperty('--dsw-alias-state-warn-primary')
  })

  it('binds the theme disposer to the plugin lifecycle', () => {
    const dispose = vi.fn()
    const overrideTokens = vi.fn(() => dispose)
    let cleanup: (() => void) | undefined
    const effect = vi.fn((setup: () => () => void) => {
      cleanup = setup()
    })

    installRcsTheme({ effect, theme: { overrideTokens } })

    expect(overrideTokens).toHaveBeenCalledWith('rcs-blue-white', rcsThemeTokens)
    expect(effect).toHaveBeenCalledOnce()
    cleanup?.()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
