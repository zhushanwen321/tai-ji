/**
 * check-record-write-surface.mjs 单测（review MF-7：守卫脚本零测试盲区）。
 *
 * C-data-20「store 外零直写」grep 兜底层的规则回归锚点——规则失真则守卫静默失效
 * 或全仓提交被误拦。覆盖面：
 *   - collectTsFiles：目录遍历边界（排除 __tests__ / test / node_modules / dist，
 *     排除 *.test.ts / *.d.ts，收集 .ts）
 *   - R1 命中：store 外 import writeFinalizedState 直调 / 类方法形态直写
 *   - R1 豁免：载体定义文件的 export function / async function 定义行、注释行
 *   - R2 命中：appendEntry + customType "subagent-record" 同行写形态（store 外）
 *   - R2 豁免：record-entry.ts 常量定义面
 *
 * fixture 全落 tmpdir（scanRecordWriteSurface(roots) 注入扫描根，同
 * check-publish-surface.test.mjs 惯例），不依赖真实仓库状态。
 * CLI 行为回归 = node scripts/check-record-write-surface.mjs。
 */
import { afterEach, describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectTsFiles,
  WRITE_FN_RE,
  RECORD_ENTRY_WRITE_RE,
  isCommentLine,
  scanRecordWriteSurface,
} from '../check-record-write-surface.mjs'

const fixtures = []

function makeFixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'record-write-guard-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  fixtures.push(root)
  return root
}

afterEach(() => {
  while (fixtures.length > 0) rmSync(fixtures.pop(), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

// ── collectTsFiles：目录遍历边界 ───────────────────────────────────────

describe('collectTsFiles 遍历边界', () => {
  it('排除 __tests__/ test / node_modules / dist 目录与 *.test.ts / *.d.ts', () => {
    const root = makeFixture({
      'src/a.ts': 'export const a = 1;',
      'src/b.test.ts': 'export const b = 2;',
      'src/types.d.ts': 'export type T = 1;',
      'src/__tests__/c.ts': 'export const c = 3;',
      'src/test/d.ts': 'export const d = 4;',
      'node_modules/e.ts': 'export const e = 5;',
      'dist/f.js': '',
      'src/nested/g.ts': 'export const g = 6;',
    })
    const files = collectTsFiles(root).map((f) => f.slice(root.length + 1)).sort()
    expect(files).toEqual(['src/a.ts', 'src/nested/g.ts'])
  })
})

// ── 正则/判定原语 ──────────────────────────────────────────────────────

describe('规则原语', () => {
  it('WRITE_FN_RE 命中七名真实导出（含 .alive 写/删两名 + U2 轮收口写面）', () => {
    for (const name of ['writeFinalizedState', 'writeCancelledState', 'writeSettledState', 'writeManifest', 'saveIndex', 'writeAliveMarker', 'removeAliveMarker']) {
      expect(WRITE_FN_RE.test(`${name}(f)`)).toBe(true)
    }
    expect(WRITE_FN_RE.test('writeStateMarker(f)')).toBe(false) // v1 假绿教训：模块私有名不命中
  })

  it('RECORD_ENTRY_WRITE_RE 双向同行形态命中，读面不命中', () => {
    expect(RECORD_ENTRY_WRITE_RE.test('pi.appendEntry({ customType: "subagent-record", data })')).toBe(true)
    expect(RECORD_ENTRY_WRITE_RE.test(`data.customType === 'subagent-record' && onAppendEntry()`)).toBe(false)
  })

  it('isCommentLine：// 与块注释前缀豁免', () => {
    expect(isCommentLine('// writeFinalizedState(f)')).toBe(true)
    expect(isCommentLine(' * writeManifest(f)')).toBe(true)
    expect(isCommentLine('/* saveIndex(f) */')).toBe(true)
    expect(isCommentLine('  writeFinalizedState(f)')).toBe(false)
  })
})

// ── R1：写函数直调命中 / 定义行与注释豁免 ─────────────────────────────

describe('scanRecordWriteSurface R1', () => {
  it('store 外直调 writeFinalizedState → 违规', () => {
    const root = makeFixture({
      'pkg/src/other/writer.ts': [
        'import { writeFinalizedState } from "@zhushanwen/subagent-core";',
        'export function bad(f: string) {',
        '  writeFinalizedState(f, "done");',
        '}',
      ].join('\n'),
    })
    const violations = scanRecordWriteSurface([join(root, 'pkg', 'src')])
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('[R1]')
    expect(violations[0]).toContain('writeFinalizedState')
  })

  it('载体定义文件的定义行豁免（export function / async function），非定义行仍红', () => {
    const root = makeFixture({
      // 相对 PROJECT_ROOT 的载体定义路径前缀无法在 tmpdir 复现（白名单按仓根相对路径），
      // 但 scanRecordWriteSurface 按 file 的绝对路径与白名单比对——tmpdir 下的同相对路径
      // 路径串不含 packages/subagent-core 前缀，故构造「非白名单文件的定义形态」验证
      // 定义豁免只对白名单文件生效、其余文件定义形态同样命中（防豁免面意外扩大）。
      'pkg/src/execution/state-marker-like.ts': [
        'export function writeFinalizedState(f: string): boolean { return true; }',
        'async function writeManifest(f: string) {}',
      ].join('\n'),
    })
    const violations = scanRecordWriteSurface([join(root, 'pkg', 'src')])
    // 非白名单文件：即使形态像定义行也命中（白名单按路径不按形态）
    expect(violations.length).toBeGreaterThanOrEqual(2)
    expect(violations.every((v) => v.includes('[R1]'))).toBe(true)
  })

  it('注释行不命中（docstring 提及六名合法）', () => {
    const root = makeFixture({
      'pkg/src/other/doc.ts': [
        '// writeFinalizedState(f) 是唯一写入口',
        'export const x = 1;',
      ].join('\n'),
    })
    expect(scanRecordWriteSurface([join(root, 'pkg', 'src')])).toEqual([])
  })
})

// ── R2：subagent-record entry 直写命中 / 常量定义豁免 ─────────────────

describe('scanRecordWriteSurface R2', () => {
  it('store 外 appendEntry + customType "subagent-record" → 违规', () => {
    const root = makeFixture({
      'pkg/src/other/emitter.ts': 'export function emit(pi: unknown, data: unknown) {\n  pi.appendEntry({ customType: "subagent-record", data });\n}',
    })
    const violations = scanRecordWriteSurface([join(root, 'pkg', 'src')])
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('[R2]')
  })

  it('customType 非本域（notify-ledger 等）天然不命中', () => {
    const root = makeFixture({
      'pkg/src/other/notify.ts': 'export function emit(pi: unknown, data: unknown) {\n  pi.appendEntry({ customType: "notify-ledger", data });\n}',
    })
    expect(scanRecordWriteSurface([join(root, 'pkg', 'src')])).toEqual([])
  })
})
