/**
 * readBindingSidecar 读侧分流测试（code-harden RT-3#3）。
 *
 * 覆盖：
 * - ENOENT（sidecar 不存在）→ undefined 且零日志（「从未绑定」正常态保持安静）；
 * - JSON parse 拒绝（损坏）→ undefined + warn（路径+原因）+ quarantineCorruptFile 隔离
 *  （原文件被 rename 为 .corrupt-<ts> 取证副本）；
 * - 守卫不过（合法 JSON 字段形状不符）→ undefined + warn 一次，不隔离；
 * - 读失败（非 ENOENT，chmod 000）→ undefined + warn；
 * - warn-once：同路径第二次降级不再重复出声。
 *
 * 测试框架：vitest。运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/session-binding-sidecar-io.test.ts
 */
import { describe, it, expect, vi, type MockInstance, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBindingSidecar, _resetSidecarWarnDedupForTest } from '../session-binding-sidecar-io.js'

let dir: string
let warnSpy: MockInstance<typeof console.warn>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sidecar-io-rt3-3-'))
  _resetSidecarWarnDedupForTest()
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

const decode = (b: unknown): string | undefined => {
  const rec = b as Record<string, unknown> | undefined
  return rec && typeof rec.presetId === 'string' ? rec.presetId : undefined
}

describe('readBindingSidecar · RT-3#3 读侧分流', () => {
  it('ENOENT（不存在）→ undefined 且零 warn', () => {
    const p = join(dir, 'nonexistent.jsonl.preset.json')
    expect(readBindingSidecar(p, decode)).toBeUndefined()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('JSON 损坏 → undefined + warn（路径+原因）+ 隔离为 .corrupt- 副本', () => {
    const p = join(dir, 's1.jsonl.preset.json')
    writeFileSync(p, '{not-valid-json', 'utf-8')

    expect(readBindingSidecar(p, decode)).toBeUndefined()

    const warns = warnSpy.mock.calls.map(c => String(c[0]))
    expect(warns.some(m => m.includes('sidecar JSON corrupt') && m.includes(p))).toBe(true)

    // 原文件被 rename 隔离：原位消失，同目录出现 .corrupt-<ts> 取证副本
    expect(existsSync(p)).toBe(false)
    const quarantined = readdirSync(dir).filter(n => n.startsWith('s1.jsonl.preset.json.corrupt-'))
    expect(quarantined).toHaveLength(1)
    // 隔离后再读 = ENOENT 路径，安静
    expect(readBindingSidecar(p, decode)).toBeUndefined()
  })

  it('守卫不过（presetId 非字符串）→ undefined + warn 一次，不隔离', () => {
    const p = join(dir, 's2.jsonl.preset.json')
    writeFileSync(p, JSON.stringify({ presetId: 123 }), 'utf-8')

    expect(readBindingSidecar(p, decode)).toBeUndefined()
    expect(warnSpy.mock.calls.filter(c => String(c[0]).includes('shape rejected')).length).toBe(1)
    // 守卫不过不隔离：原文件保留（旧形态可被未来版本解读）
    expect(existsSync(p)).toBe(true)

    // warn-once：第二次读同一路径不再重复出声
    expect(readBindingSidecar(p, decode)).toBeUndefined()
    expect(warnSpy.mock.calls.filter(c => String(c[0]).includes('shape rejected')).length).toBe(1)
  })

  it('读失败（非 ENOENT：EACCES）→ undefined + warn（路径+原因）', () => {
    const p = join(dir, 's3.jsonl.preset.json')
    writeFileSync(p, JSON.stringify({ presetId: 'builtin:full' }), 'utf-8')
    chmodSync(p, 0o000)

    try {
      expect(readBindingSidecar(p, decode)).toBeUndefined()
      const warns = warnSpy.mock.calls.map(c => String(c[0]))
      expect(warns.some(m => m.includes('sidecar read failed') && m.includes(p))).toBe(true)
    } finally {
      chmodSync(p, 0o644)
    }
  })

  it('正常 sidecar → 解码值，零 warn（正向对照）', () => {
    const p = join(dir, 's4.jsonl.preset.json')
    writeFileSync(p, JSON.stringify({ presetId: 'builtin:full', version: 1 }), 'utf-8')
    expect(readBindingSidecar(p, decode)).toBe('builtin:full')
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
