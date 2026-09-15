/**
 * scanner-base 纯函数单测 — 钉住 inferSourceType / expandHome 的边界行为。
 *
 * 覆盖（report round7 must-fix #2）：
 * - inferSourceType：注释点名的误判场景（.taijiator / .claude-old / .pi-backup）
 *   必须落回 'custom'，不得误判为 pi/claude。
 * - .taiji 变体（-dev / -v2）仍识别为 'pi'。
 * - expandHome：`~` 前缀展开、无 `~` 原样返回、空串边界。
 *
 * 这两个是含分支/正则的纯函数，无 IO，测试成本极低。
 *
 * 运行：pnpm --filter @taiji/runtime run test -- test/scanner-base.test.ts
 */
import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { inferSourceType, expandHome } from '../src/services/scanners/scanner-base.js'

describe('inferSourceType', () => {
  it('识别 .taiji 为 pi', () => {
    expect(inferSourceType('/home/u/.taiji/agents')).toBe('pi')
    expect(inferSourceType(join(homedir(), '.taiji'))).toBe('pi')
  })

  it('识别 .taiji 变体（-dev / -v2）为 pi', () => {
    expect(inferSourceType('/home/u/.taiji-dev/agents')).toBe('pi')
    expect(inferSourceType('/home/u/.taiji-v2/skills')).toBe('pi')
  })

  it('不把 .taijiator 误判为 pi（注释点名的回归风险）', () => {
    // startWith('.taiji') 会误命中，必须用 === / startsWith('.taiji-') 精确匹配
    expect(inferSourceType('/home/u/.taijiator/foo')).toBe('custom')
    expect(inferSourceType('/home/u/.taijis')).toBe('custom')
  })

  it('识别 .pi / .claude / .agents', () => {
    expect(inferSourceType('/home/u/.pi/agents')).toBe('pi')
    expect(inferSourceType('/home/u/.claude/agents')).toBe('claude')
    expect(inferSourceType('/home/u/.agents/skills')).toBe('agents')
  })

  it('不把 .pi-backup / .claude-old 误判（后缀变体）', () => {
    expect(inferSourceType('/home/u/.pi-backup/agents')).toBe('custom')
    expect(inferSourceType('/home/u/.claude-old/agents')).toBe('custom')
    expect(inferSourceType('/home/u/.agents-backup')).toBe('custom')
  })

  it('未知路径与自定义目录落回 custom', () => {
    expect(inferSourceType('/home/u/my-tools/agents')).toBe('custom')
    expect(inferSourceType('/opt/custom-skills')).toBe('custom')
  })

  it('空串落回 custom（不抛）', () => {
    expect(inferSourceType('')).toBe('custom')
  })

  it('Windows 风格反斜杠路径也能按段切分', () => {
    expect(inferSourceType('C:\\Users\\foo\\.claude\\agents')).toBe('claude')
    expect(inferSourceType('C:\\Users\\foo\\.taiji-dev\\agents')).toBe('pi')
  })
})

describe('expandHome', () => {
  it('把 ~/ 前缀展开到 homedir', () => {
    expect(expandHome('~/foo/bar')).toBe(join(homedir(), 'foo/bar'))
  })

  it('单独 ~ 展开为 homedir', () => {
    expect(expandHome('~')).toBe(homedir())
  })

  it('无 ~ 前缀原样返回', () => {
    expect(expandHome('/abs/path')).toBe('/abs/path')
    expect(expandHome('relative/path')).toBe('relative/path')
  })

  it('空串原样返回（不抛）', () => {
    expect(expandHome('')).toBe('')
  })
})
