/**
 * check-subagent-service-boundary.mjs 单测（review MF-6：守卫脚本零测试盲区）。
 *
 * 覆盖面：
 *   - parseImport：合法形态（named / type named / default / namespace / re-export）、
 *     噪声行（null）、as 重命名取原名
 *   - logicalImportLines：跨行 named import 合并为单逻辑行（漏检盲区锚点）
 *   - resolveServiceTarget / isShellTarget：目录注入 fixture 下的命中与放行
 *   - extractPublicSurface：fixture class 导出面抽取（private 排除 / constructor 排除 /
 *     大括号平衡截断）
 *   - checkSupportShellImports / checkSupportFileImports：台账放行 / 未登记命中两分支
 *   - checkAggregateGetterCalls：命中（非 public 成员）与放行（public 成员）两分支
 *   - detectCycles：gray back-edge 环命中（a→b→a 路径文本）与 diamond 零误报
 *
 * fixture 全落 tmpdir（目录注入直测函数，同 check-publish-surface.test.mjs 惯例），
 * afterEach 统一清理。CLI 行为回归 = node scripts/check-subagent-service-boundary.mjs。
 */
import { afterEach, describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseImport,
  logicalImportLines,
  resolveServiceTarget,
  isShellTarget,
  extractPublicSurface,
  extractAggregateGetters,
  checkSupportShellImports,
  checkSupportFileImports,
  checkAggregateGetterCalls,
  detectCycles,
} from '../check-subagent-service-boundary.mjs'

// ── parseImport：形态矩阵 ──────────────────────────────────────────────

describe('parseImport 形态矩阵', () => {
  it('named import（值）解析出符号与目标', () => {
    expect(parseImport('import { A, B } from "./x.ts";')).toEqual({
      symbols: [{ name: 'A', typeOnly: false }, { name: 'B', typeOnly: false }],
      target: './x.ts',
    })
  })

  it('块级 type import 全部 typeOnly', () => {
    expect(parseImport('import type { ResolvedIdentity } from "./record-access.ts";')).toEqual({
      symbols: [{ name: 'ResolvedIdentity', typeOnly: true }],
      target: './record-access.ts',
    })
  })

  it('行内 type 修饰符逐符号判定', () => {
    const parsed = parseImport('import { A, type B } from "./x.ts";')
    expect(parsed.symbols).toEqual([
      { name: 'A', typeOnly: false },
      { name: 'B', typeOnly: true },
    ])
  })

  it('default / namespace / 裸星 import 归一为 "*" 值符号', () => {
    expect(parseImport('import X from "./x.ts";')?.symbols).toEqual([{ name: '*', typeOnly: false }])
    expect(parseImport('import * as ns from "./x.ts";')?.symbols).toEqual([{ name: '*', typeOnly: false }])
    expect(parseImport('import * from "./x.ts";')?.symbols).toEqual([{ name: '*', typeOnly: false }])
  })

  it('re-export 与 import 同构（P3-3 通道）', () => {
    expect(parseImport('export { A } from "./x.ts";')?.symbols).toEqual([{ name: 'A', typeOnly: false }])
  })

  it('as 重命名取原名（别名丢弃）', () => {
    expect(parseImport('import { A as Alias } from "./x.ts";')?.symbols).toEqual([{ name: 'A', typeOnly: false }])
  })

  it('噪声行返回 null（非 import/export-from 语句）', () => {
    expect(parseImport('const x = 1;')).toBeNull()
    expect(parseImport('// import { A } from "./x.ts";')).toBeNull()
    expect(parseImport('foo("import { A } from \\"./x.ts\\"")')).toBeNull()
  })
})

// ── logicalImportLines：跨行合并（漏检盲区锚点） ────────────────────────

describe('logicalImportLines 跨行 named import 合并', () => {
  it('多行 import 块合并为单逻辑行（否则整块漏检）', () => {
    const src = ['import {', '  A,', '  B,', '} from "./x.ts";', 'const y = 2;'].join('\n')
    const lines = [...logicalImportLines(src)]
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('A,')
    expect(lines[0]).toContain('} from "./x.ts";')
  })

  it('单行 import 原样透传', () => {
    const lines = [...logicalImportLines('import { A } from "./x.ts";\nconst y = 2;')]
    expect(lines).toEqual(['import { A } from "./x.ts";', 'const y = 2;'])
  })
})

// ── 目录解析（tmpdir fixture 注入） ────────────────────────────────────

const fixtures = []

/** tmpdir fixture 树：execution/subagent-service.ts 壳 + service/ 三文件。 */
function makeFixtureTree() {
  const root = mkdtempSync(join(tmpdir(), 'boundary-guard-'))
  const execDir = join(root, 'execution')
  const serviceDir = join(execDir, 'service')
  mkdirSync(serviceDir, { recursive: true })
  writeFileSync(join(execDir, 'subagent-service.ts'), 'export class SubagentService {}\n')
  writeFileSync(join(serviceDir, 'record-access.ts'), 'export interface ResolvedIdentity {}\n')
  writeFileSync(join(serviceDir, 'service-bootstrap.ts'), 'export const boot = 1;\n')
  writeFileSync(join(serviceDir, 'service-constants.ts'), 'export const K = 1;\n')
  fixtures.push(root)
  return { root, execDir, serviceDir }
}

afterEach(() => {
  while (fixtures.length > 0) rmSync(fixtures.pop(), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('resolveServiceTarget / isShellTarget（fixture 注入）', () => {
  it('service 内相对路径命中兄弟文件名', () => {
    const { serviceDir } = makeFixtureTree()
    expect(resolveServiceTarget(join(serviceDir, 'run-orchestration.ts'), './record-access.ts', serviceDir)).toBe('record-access.ts')
  })

  it('包名 import（非相对）返回 null', () => {
    const { serviceDir } = makeFixtureTree()
    expect(resolveServiceTarget(join(serviceDir, 'a.ts'), '@zhushanwen/subagent-core', serviceDir)).toBeNull()
  })

  it('service 外目录返回 null', () => {
    const { root, serviceDir } = makeFixtureTree()
    expect(resolveServiceTarget(join(serviceDir, 'a.ts'), '../outside.ts', serviceDir)).toBeNull()
    expect(resolveServiceTarget(join(serviceDir, 'a.ts'), join(root, 'other.ts'), serviceDir)).toBeNull()
  })

  it('isShellTarget：壳文件命中 / 其他相对路径放行', () => {
    const { execDir, serviceDir } = makeFixtureTree()
    expect(isShellTarget(join(serviceDir, 'a.ts'), '../subagent-service.ts', execDir)).toBe(true)
    expect(isShellTarget(join(serviceDir, 'a.ts'), './record-access.ts', execDir)).toBe(false)
    expect(isShellTarget(join(serviceDir, 'a.ts'), 'node:fs', execDir)).toBe(false)
  })
})

// ── extractPublicSurface：导出面抽取 ───────────────────────────────────

describe('extractPublicSurface 导出面抽取', () => {
  it('非 private 成员入面，private/constructor 排除', () => {
    const src = [
      'export class RecordAccess {',
      '  private readonly deps: Deps;',
      '  constructor(deps: Deps) {}',
      '  lookupRecordAnyState(id: string): void {}',
      '  get ready(): boolean { return true }',
      '}',
    ].join('\n')
    const extracted = extractPublicSurface(src)
    expect(extracted?.className).toBe('RecordAccess')
    expect(extracted?.surface.has('lookupRecordAnyState')).toBe(true)
    expect(extracted?.surface.has('ready')).toBe(true)
    expect(extracted?.surface.has('constructor')).toBe(false)
    expect(extracted?.surface.has('deps')).toBe(false)
  })

  it('class 体外的成员不入面（大括号平衡截断）', () => {
    const src = [
      'interface Hidden { method(): void }',
      'export class A {',
      '  run(): void {}',
      '}',
      'const literal = { notAMember: true };',
    ].join('\n')
    const extracted = extractPublicSurface(src)
    expect(extracted?.className).toBe('A')
    expect(extracted?.surface.has('run')).toBe(true)
    expect(extracted?.surface.has('notAMember')).toBe(false)
    expect(extracted?.surface.has('method')).toBe(false)
  })

  it('无 export class 返回 null', () => {
    expect(extractPublicSurface('export function f() {}')).toBeNull()
  })
})

// ── 支撑文件方向门：台账放行 / 未登记命中 ─────────────────────────────

describe('checkSupportShellImports 台账放行 / 未登记命中', () => {
  it('SUPPORT_SHELL_EDGES 登记边（bootstrap→SubagentService 构造依赖）放行', () => {
    const { execDir, serviceDir } = makeFixtureTree()
    const parsed = parseImport('import { SubagentService } from "../subagent-service.ts";')
    expect(checkSupportShellImports('service-bootstrap.ts', parsed, { execDir, serviceDir })).toEqual([])
  })

  it('台账外支撑→壳值 import 命中违规', () => {
    const { execDir, serviceDir } = makeFixtureTree()
    const parsed = parseImport('import { SubagentService } from "../subagent-service.ts";')
    const violations = checkSupportShellImports('service-constants.ts', parsed, { execDir, serviceDir })
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('[支撑→壳·未登记]')
  })
})

describe('checkSupportFileImports 命中与放行', () => {
  it('登记壳边放行 + type import 兄弟聚合放行入图', () => {
    const { execDir, serviceDir } = makeFixtureTree()
    const src = [
      'import { SubagentService } from "../subagent-service.ts";',
      'import type { ResolvedIdentity } from "./record-access.ts";',
      'export const boot = (s: SubagentService, i?: ResolvedIdentity) => 0;',
    ].join('\n')
    const edges = new Map()
    const violations = []
    checkSupportFileImports('service-bootstrap.ts', src, edges, violations, { serviceDir, execDir })
    expect(violations).toHaveLength(0)
    expect(edges.get('service-bootstrap.ts').has('record-access.ts')).toBe(true)
  })

  it('未登记壳边（constants→壳）命中违规', () => {
    const { execDir, serviceDir } = makeFixtureTree()
    const src = 'import { SubagentService } from "../subagent-service.ts";\nexport const K = 1;'
    const violations = []
    checkSupportFileImports('service-constants.ts', src, new Map(), violations, { serviceDir, execDir })
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('[支撑→壳·未登记]')
  })
})

// ── 跨聚合私有访问门：命中与放行 ─────────────────────────────────────

describe('checkAggregateGetterCalls 命中与放行', () => {
  const classNames = new Set(['RecordAccess'])
  const surfaces = new Map([['RecordAccess', new Set(['lookupRecordAnyState'])]])

  it('deps getter 直调非 public 成员 → 命中违规', () => {
    const src = [
      'interface Deps { readonly getQueries: () => RecordAccess; }',
      'run() { this.deps.getQueries().internalOnly(); }',
    ].join('\n')
    const violations = []
    checkAggregateGetterCalls('a.ts', src, surfaces, classNames, violations)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('[跨聚合私有访问]')
    expect(violations[0]).toContain('internalOnly')
  })

  it('deps getter 直调 public 成员 → 放行', () => {
    const src = [
      'interface Deps { readonly getQueries: () => RecordAccess; }',
      'run() { this.deps.getQueries().lookupRecordAnyState("x"); }',
    ].join('\n')
    const violations = []
    checkAggregateGetterCalls('a.ts', src, surfaces, classNames, violations)
    expect(violations).toHaveLength(0)
  })

  it('extractAggregateGetters：getter 返回类型须在聚合 class 名集合内', () => {
    const getters = extractAggregateGetters(
      'interface Deps { readonly getQueries: () => RecordAccess; readonly getOther: () => Unknown; }',
      classNames,
    )
    expect(getters.get('getQueries')).toBe('RecordAccess')
    expect(getters.has('getOther')).toBe(false)
  })
})

// ── detectCycles：三色 DFS 环检测（守卫「单向无环」结论唯一来源） ────────

describe('detectCycles 环检测', () => {
  it('gray back-edge（a→b→a）命中，返回环路径文本', () => {
    const edges = new Map([
      ['a', ['b']],
      ['b', ['a']],
    ])
    expect(detectCycles(edges)).toEqual(['a -> b -> a'])
  })

  it('diamond 边（a→b, a→c, b→d, c→d）无环零误报', () => {
    const edges = new Map([
      ['a', ['b', 'c']],
      ['b', ['d']],
      ['c', ['d']],
      ['d', []],
    ])
    expect(detectCycles(edges)).toEqual([])
  })
})
