import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isLeakedPackage, cleanLeakedPackages, setSettingsPath } from '../infra/pi/pi-provider-store.js'

// 测试用临时 settings.json 目录
let tmpDir: string
let settingsPath: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'clean-leaked-'))
  settingsPath = join(tmpDir, 'settings.json')
  setSettingsPath(settingsPath)
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

// 辅助：写 settings.json
function writeSettings(packages: string[] | undefined): void {
  writeFileSync(settingsPath, JSON.stringify({ packages }))
}

// 辅助：读 settings.json packages
function readSettingsPackages(): string[] | undefined {
  try {
    return (JSON.parse(readFileSync(settingsPath, 'utf-8'))).packages
  } catch {
    return undefined
  }
}

// 说明：isLeakedPackage 相对 getPiAgentDir()（<dataDir>/agent）解析。
// pi 全局目录 = getPiGlobalAgentDir() = resolve(getDataDir(), '..', '.pi', 'agent')
//（dataDir 的兄弟 .pi/agent），故需 ../../（向上 2 层到 dataDir 父目录，再下 .pi/agent）。
describe('isLeakedPackage', () => {
  it('TC1: 合法路径不误杀', () => {
    expect(isLeakedPackage('npm:@zhushanwen/pi-todo')).toBe(false)
    expect(isLeakedPackage('extensions/subagents-workflow')).toBe(false)
    expect(isLeakedPackage('./local-ext')).toBe(false)
  })

  it('TC2: 泄漏路径正确识别', () => {
    expect(isLeakedPackage('../../.pi/agent/extensions/universal/pending-notifications')).toBe(true)
    expect(isLeakedPackage('../../.pi/agent/extensions/universal/goal')).toBe(true)
  })

  it('TC3: 指向非 pi 全局的相对路径不误杀', () => {
    expect(isLeakedPackage('../../some-other-dir/ext')).toBe(false)
    expect(isLeakedPackage('../sibling-project/ext')).toBe(false)
  })
})

describe('cleanLeakedPackages', () => {
  it('TC4: 有泄漏时删除并返回 removed', () => {
    writeSettings(['npm:@a/b', '../../.pi/agent/extensions/x', 'extensions/y', '../../.pi/agent/extensions/z'])
    const result = cleanLeakedPackages()
    expect(result.removed).toEqual(['../../.pi/agent/extensions/x', '../../.pi/agent/extensions/z'])
    expect(readSettingsPackages()).toEqual(['npm:@a/b', 'extensions/y'])
  })

  it('TC5: 无泄漏时幂等不触发写', () => {
    writeSettings(['npm:@a/b', 'extensions/c'])
    const result = cleanLeakedPackages()
    expect(result.removed).toEqual([])
    expect(readSettingsPackages()).toEqual(['npm:@a/b', 'extensions/c'])
  })

  it('TC6: 空/undefined packages 无副作用', () => {
    writeSettings([])
    expect(cleanLeakedPackages().removed).toEqual([])
    writeSettings(undefined)
    expect(cleanLeakedPackages().removed).toEqual([])
  })
})
