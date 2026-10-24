/**
 * check-session-hidden-surface.mjs 单测（会话架构四层分离 W5，设计 §3.3.7 / §3.3.8 /
 * §5-W5 判据第 2 层）：
 * hidden 双形态 pattern（含可选声明形态）+ surface 三形态 pattern 的扫描/剥离/判定逻辑
 * 机器锁定。fixture 全部落 tmpdir（rootDir 注入 collectHits / findViolations），
 * 不依赖真实仓库状态——按 check-publish-surface.test.mjs 惯例。
 *
 * 覆盖（对样本树跑出预期红/绿）：
 * - 注释剥离（块/行/Vue 模板）与测试文件/__tests__ 排除不计命中；
 * - hidden 三形态（对象键/属性访问/可选声明）未登记即红、登记即绿；
 * - surface 三形态（属性访问/对象键/标识符）未登记即红；
 * - 读取点清单（READ_POINTS，usage 三值词表）/ 载体文件（WRITE_SIDE_FILES）/
 *   同名排除（SAME_NAME_EXCLUDE）/ buildSessionSummary 透传行排除的判定；
 * - import 行（含多行 import）不计命中。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  codeLines,
  collectHits,
  findViolations,
  HIDDEN_ALLOWLIST,
  SURFACE_READ_POINTS,
  SURFACE_WRITE_SIDE_FILES,
  SURFACE_SAME_NAME_EXCLUDE,
  SURFACE_PASSTHROUGH_EXCLUDE,
} from '../check-session-hidden-surface.mjs'

const roots = []
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** tmpdir 仓库根 fixture 工厂：files 为 rel 路径 → 内容映射（自动建父目录）。 */
function makeRepo(files) {
  const root = mkdtempSync(join(tmpdir(), 'hidden-surface-fx-'))
  roots.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }
  return root
}

/** 样本树上采集 + 判定，返回 `file:line` 违规清单。 */
function violationsOf(root) {
  return findViolations(collectHits(root)).map((v) => `${v.file}:${v.line}`)
}

describe('codeLines：注释逐行剥离（行号保持原文件行号）', () => {
  it('块注释跨行延续、行注释截断、Vue 模板注释剔除', () => {
    const lines = codeLines([
      'const a = 1',
      '/* hidden: true',
      '   surface: btw */',
      'const b = 2 // surface: btw',
      '<!-- surface: btw -->',
      'const c = 3',
    ].join('\n'))
    expect(lines).toHaveLength(6)
    expect(lines[1]).toBe('')
    expect(lines[2]).toBe('')
    expect(lines[3]).toBe('const b = 2 ')
    expect(lines[4]).toBe('')
    expect(lines[5]).toBe('const c = 3')
  })
})

describe('collectHits：scope 与排除', () => {
  it('只扫 packages/<pkg>/src；__tests__ / *.test.* / 注释行 / import 行不计命中', () => {
    const root = makeRepo({
      'packages/demo/src/keep.ts': 'export const a = { hidden: true }\nexport const b = (s: { surface?: string }) => s.surface\n',
      'packages/demo/src/__tests__/skip.ts': 'export const hidden: boolean = true\n',
      'packages/demo/src/skip.test.ts': 'export const hidden: boolean = true\n',
      'packages/demo/src/commented.ts': '/**\n * hidden: true\n */\n// surface: btw\n',
      'packages/demo/src/imports.ts': "import { isBtwSession } from '@taiji/core'\nimport {\n  a,\n  isBtwSession as x,\n} from 'mod'\nexport const ok = 1\n",
      'apps/other/src/out-of-scope.ts': 'export const hidden: boolean = true\n',
    })
    const hits = collectHits(root)
    const keys = hits.map((h) => `${h.file}:${h.line}`)
    expect(keys).toEqual([
      'packages/demo/src/keep.ts:1',
      'packages/demo/src/keep.ts:2',
    ])
  })
})

describe('hidden 检查：双形态 pattern + ALLOWLIST', () => {
  it('对象键 / 属性访问 / 可选声明三形态未登记命中即红', () => {
    const root = makeRepo({
      'packages/demo/src/red.ts': [
        'export const a = { hidden: true }',
        'export const b = (s: { hidden?: boolean }) => s.hidden === true',
        'export const c = (o: { hidden?: boolean }) => o.hidden',
      ].join('\n'),
    })
    expect(violationsOf(root)).toEqual([
      'packages/demo/src/red.ts:1',
      'packages/demo/src/red.ts:2',
      'packages/demo/src/red.ts:3',
    ])
  })

  it('ALLOWLIST 登记行（真实清单首条）不红', () => {
    const key = [...HIDDEN_ALLOWLIST.keys()][0]
    const file = key.split(':').slice(0, -1).join(':')
    const line = Number(key.split(':').at(-1))
    const root = makeRepo({
      'packages/demo/src/ok.ts': 'export const a = { hidden: true }\n',
    })
    // 用真实清单键直接验证判定函数（文件路径换成 fixture 路径不影响 ALLOWLIST 命中判定语义）
    const v = findViolations([{ kind: 'hidden', file, line, text: 'hidden: true' }])
    expect(v).toEqual([])
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
})

describe('surface 检查：三形态 pattern + 清单判定', () => {
  it('属性访问 / 对象键 / 标识符三形态未登记命中即红', () => {
    const root = makeRepo({
      'packages/demo/src/red.ts': [
        'export const a = (s: { surface?: string }) => s.surface',
        "export const b = { surface: 'btw' }",
        'export const c = surfaceBySessionId',
      ].join('\n'),
    })
    expect(violationsOf(root)).toEqual([
      'packages/demo/src/red.ts:1',
      'packages/demo/src/red.ts:2',
      'packages/demo/src/red.ts:3',
    ])
  })

  it('登记即绿：READ_POINTS（usage 三值）/ WRITE_SIDE_FILES / SAME_NAME_EXCLUDE / PASSTHROUGH_EXCLUDE', () => {
    const readKey = [...SURFACE_READ_POINTS.keys()][0]
    const readFile = readKey.split(':').slice(0, -1).join(':')
    const readLine = Number(readKey.split(':').at(-1))
    const passKey = [...SURFACE_PASSTHROUGH_EXCLUDE][0]
    const passFile = passKey.split(':').slice(0, -1).join(':')
    const passLine = Number(passKey.split(':').at(-1))
    const v = findViolations([
      { kind: 'surface', file: readFile, line: readLine, text: '.surface === 1' },
      { kind: 'surface', file: [...SURFACE_WRITE_SIDE_FILES][0], line: 1, text: "surface: 'btw'" },
      { kind: 'surface', file: [...SURFACE_SAME_NAME_EXCLUDE.keys()][0], line: 1, text: "surface: 'x'" },
      { kind: 'surface', file: passFile, line: passLine, text: 'surface: s.surface' },
    ])
    expect(v).toEqual([])
  })

  it('usage 词表三值齐全（nav-filter / workspace-history / suppression）', () => {
    const usages = new Set(SURFACE_READ_POINTS.values())
    expect([...usages].sort()).toEqual(['nav-filter', 'suppression', 'workspace-history'])
    expect(SURFACE_READ_POINTS.size).toBeGreaterThanOrEqual(7)
  })
})
