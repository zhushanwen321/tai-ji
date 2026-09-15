import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// 从实际 package.json 读取版本（tsup bundle 后 fs.readFileSync 向上查找）
const PROJECT_ROOT = resolve(__dirname, '..')
const PKG_VERSION = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'package.json'), 'utf-8')).version

const { checkPluginCompatibility } = await import('../src/services/plugin-service/plugin-version-checker.js')

describe('checkPluginCompatibility', () => {
  it('returns compatible for wildcard "*"', () => {
    const result = checkPluginCompatibility('*')
    expect(result.compatible).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it('returns compatible for empty string', () => {
    const result = checkPluginCompatibility('')
    expect(result.compatible).toBe(true)
  })

  it('returns compatible when current version satisfies range', () => {
    const result = checkPluginCompatibility(`^${PKG_VERSION.replace(/\d+$/, '0')}`)
    expect(result.compatible).toBe(true)
  })

  it('returns incompatible for unsatisfied range', () => {
    const result = checkPluginCompatibility('^99.0.0')
    expect(result.compatible).toBe(false)
    expect(result.reason).toContain('Requires taiji')
    expect(result.reason).toContain('^99.0.0')
  })

  it('returns incompatible for invalid version range', () => {
    const result = checkPluginCompatibility('not-valid-range')
    expect(result.compatible).toBe(false)
    expect(result.reason).toContain('Invalid version range')
    expect(result.reason).toContain('not-valid-range')
  })

  it('returns compatible for exact current version', () => {
    const result = checkPluginCompatibility(PKG_VERSION)
    expect(result.compatible).toBe(true)
  })
})