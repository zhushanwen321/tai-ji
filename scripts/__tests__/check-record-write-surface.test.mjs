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
 *   - R3 命中：白名单外 workflow-record entry 写（字面量 + 常量双形态）
 *   - R4 命中：白名单外 toSubagentRecordEntry 调用（v1 快照投影构造器）
 *   - R5 命中：workflow-record 写点窗口内 v:1 / snapshot 载荷形态；
 *     豁免：窗口内注释行提及触发词
 *   - R6 命中：entry 载荷 eventLog:/displayItems: 死字节字段写形态；
 *     豁免：窗口内注释行提及触发词
 *   - R7 命中：双写者外 appendFile × `.events` 直写（单行 + prettier 拆行）；
 *     豁免：注释行字面量与非 .events 目标
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
  APPEND_FILE_CALL_RE,
  EVENTS_PATH_LITERAL_RE,
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
  it('WRITE_FN_RE 命中八名真实导出（含 .alive 写/删两名 + U2 轮收口写面 + bound 物化写面）', () => {
    for (const name of ['writeFinalizedState', 'writeCancelledState', 'writeSettledState', 'writeManifest', 'materializeBoundRecordManifest', 'saveIndex', 'writeAliveMarker', 'removeAliveMarker']) {
      expect(WRITE_FN_RE.test(`${name}(f)`)).toBe(true)
    }
    expect(WRITE_FN_RE.test('writeStateMarker(f)')).toBe(false) // v1 假绿教训：模块私有名不命中
    expect(WRITE_FN_RE.test('materializeManifest(f)')).toBe(false) // 近名不命中：名单须精确到真实导出名
  })

  it('RECORD_ENTRY_WRITE_RE 双向同行形态命中，读面不命中', () => {
    expect(RECORD_ENTRY_WRITE_RE.test('pi.appendEntry({ customType: "subagent-record", data })')).toBe(true)
    expect(RECORD_ENTRY_WRITE_RE.test(`data.customType === 'subagent-record' && onAppendEntry()`)).toBe(false)
  })

  it('R7 两段原语：APPEND_FILE_CALL_RE 锚调用行（含 Sync），EVENTS_PATH_LITERAL_RE 锚引号内 .events', () => {
    expect(APPEND_FILE_CALL_RE.test('appendFileSync(line)')).toBe(true)
    expect(APPEND_FILE_CALL_RE.test('await appendFile(fh, line)')).toBe(true)
    expect(APPEND_FILE_CALL_RE.test('import { appendFileSync } from "node:fs"')).toBe(false)
    expect(EVENTS_PATH_LITERAL_RE.test('join(dir, id + ".events")')).toBe(true)
    expect(EVENTS_PATH_LITERAL_RE.test("appendFileSync(path, line)")).toBe(false)
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

// ── R3：workflow-record entry 写面白名单（三写点宿主外违规）──────────

describe('scanRecordWriteSurface R3', () => {
  it('白名单外宿主 appendEntry + customType "workflow-record" → 违规', () => {
    const root = makeFixture({
      'pkg/src/other/emitter.ts': 'export function emit(pi: unknown, data: unknown) {\n  pi.appendEntry({ customType: "workflow-record", data });\n}',
    })
    const violations = scanRecordWriteSurface([join(root, 'pkg', 'src')])
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('[R3]')
  })

  it('常量形态 WORKFLOW_RECORD_CUSTOM_TYPE 窗口内同现（拆行）→ 违规', () => {
    const root = makeFixture({
      'pkg/src/other/emitter.ts': [
        'import { WORKFLOW_RECORD_CUSTOM_TYPE } from "...";',
        'export function emit(pi: unknown, data: unknown) {',
        '  pi.appendEntry({',
        '    customType: WORKFLOW_RECORD_CUSTOM_TYPE,',
        '    data });',
        '}',
      ].join('\n'),
    })
    const violations = scanRecordWriteSurface([join(root, 'pkg', 'src')])
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('[R3]')
  })
})

// ── R4：v1 快照投影构造器白名单（定义 + v1 兼容层外违规）────────────

describe('scanRecordWriteSurface R4', () => {
  it('白名单外 toSubagentRecordEntry 调用 → 违规（import 行无括号不命中）', () => {
    const root = makeFixture({
      'pkg/src/other/snapshot.ts': [
        'import { toSubagentRecordEntry } from "...";',
        'export const entry = toSubagentRecordEntry(rec);',
      ].join('\n'),
    })
    const violations = scanRecordWriteSurface([join(root, 'pkg', 'src')])
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('[R4]')
  })
})

// ── R5：workflow-record v1 快照载荷形态（全域拒绝，含窗口形态）────────

describe('scanRecordWriteSurface R5', () => {
  it('写点窗口内 v:1 / snapshot 载荷形态 → R5 红（R3 同报）', () => {
    const root = makeFixture({
      'pkg/src/other/wf-v1.ts': [
        'export function emit(pi: unknown) {',
        '  pi.appendEntry({ customType: "workflow-record",',
        '    data: { v: 1, snapshot: snap } });',
        '}',
      ].join('\n'),
    })
    const violations = scanRecordWriteSurface([join(root, 'pkg', 'src')])
    const tags = violations.map((v) => v.match(/\[R\d\]/)?.[0])
    expect(tags).toContain('[R3]')
    expect(tags).toContain('[R5]')
  })

  it('窗口内注释行提及 snapshot 触发词不构成 R5 违规', () => {
    const root = makeFixture({
      'pkg/src/other/noted.ts': [
        'export function emit(pi: unknown, data: unknown) {',
        '  pi.appendEntry({ customType: "workflow-record", data });',
        '  // v1 snapshot 直传已停写',
        '}',
      ].join('\n'),
    })
    const violations = scanRecordWriteSurface([join(root, 'pkg', 'src')])
    // tmpdir 路径非三写点宿主 → R3 照红；snapshot 在注释行，R5 不红
    expect(violations.map((v) => v.match(/\[R\d\]/)?.[0])).toEqual(['[R3]'])
  })
})

// ── R6：entry 载荷死字节字段（eventLog:/displayItems:，全域拒绝）──────

describe('scanRecordWriteSurface R6', () => {
  it('写点窗口内 eventLog: 字段写形态 → R6 红（R2 同报）', () => {
    const root = makeFixture({
      'pkg/src/other/dead-bytes.ts': [
        'export function emit(pi: unknown, data: unknown) {',
        '  pi.appendEntry({ customType: "subagent-record",',
        '    data: { ...data, eventLog: [], displayItems: [] } });',
        '}',
      ].join('\n'),
    })
    const violations = scanRecordWriteSurface([join(root, 'pkg', 'src')])
    const tags = violations.map((v) => v.match(/\[R\d\]/)?.[0])
    expect(tags).toContain('[R2]')
    expect(tags).toContain('[R6]')
  })

  it('窗口内注释行提及 eventLog: 触发词不构成 R6 违规', () => {
    const root = makeFixture({
      'pkg/src/other/noted.ts': [
        'export function emit(pi: unknown, data: unknown) {',
        '  pi.appendEntry({ customType: "subagent-record", data });',
        '  // 注意勿写 eventLog: 与 displayItems: 字段',
        '}',
      ].join('\n'),
    })
    const violations = scanRecordWriteSurface([join(root, 'pkg', 'src')])
    // eventLog: 在注释行，R6 不红（R2 照红——store 外写点本身仍拦）
    expect(violations.map((v) => v.match(/\[R\d\]/)?.[0])).toEqual(['[R2]'])
  })
})

// ── R7：事件文件直写（.events 路径字面量，双写者外违规）──────────────

describe('scanRecordWriteSurface R7', () => {
  it('单行 appendFileSync × `.events` 字面量 → 违规', () => {
    const root = makeFixture({
      'pkg/src/other/evil.ts': 'appendFileSync(join(dir, id + ".events"), line);\n',
    })
    const violations = scanRecordWriteSurface([join(root, 'pkg', 'src')])
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('[R7]')
  })

  it('prettier 拆行形态（.events 字面量在调用行之后）→ 违规', () => {
    const root = makeFixture({
      'pkg/src/other/evil-multiline.ts': [
        'appendFileSync(',
        '  join(dir, id + ".events"),',
        '  line,',
        ');',
      ].join('\n'),
    })
    const violations = scanRecordWriteSurface([join(root, 'pkg', 'src')])
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('[R7]')
  })

  it('注释行的 .events 字面量与非 .events 目标不命中', () => {
    const root = makeFixture({
      'pkg/src/other/benign.ts': [
        '// appendFileSync(join(dir, id + ".events"), line);',
        'appendFileSync(join(dir, "other.log"), line);',
      ].join('\n'),
    })
    expect(scanRecordWriteSurface([join(root, 'pkg', 'src')])).toEqual([])
  })
})
