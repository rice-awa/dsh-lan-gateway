import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface Manifest {
  engines?: Record<string, string>
  peerDependencies?: Record<string, string>
}

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as Manifest

const SUPPORTED_LINES = ['^0.2.0-rc.1', '^0.2.1-rc.1'] as const

// dsh 0.2.0 skips a bundle whose peer ranges reject the runtime, and dsh 0.2.1
// may consult engines.dsh instead. Both fields must name both lines.
describe('dsh compatibility declaration', () => {
  it.each(SUPPORTED_LINES)('engines.dsh admits %s', (range) => {
    expect(manifest.engines?.dsh).toContain(range)
  })

  it.each(['@deepseek-ai/dsh-settings', '@deepseek-ai/dsh-tools'])(
    '%s peer admits both 0.2.x lines',
    (name) => {
      const range = manifest.peerDependencies?.[name] ?? ''
      for (const supported of SUPPORTED_LINES) expect(range).toContain(supported)
    },
  )

  it('does not readmit the retired 0.1.7 line', () => {
    expect(manifest.engines?.dsh).not.toContain('0.1.7')
    for (const range of Object.values(manifest.peerDependencies ?? {})) {
      expect(range).not.toContain('0.1.7')
    }
  })
})
