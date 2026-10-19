/**
 * check-core-dist-gate.mjs 纯函数单测（MF-2）：
 * stripComments / parseExportBlocks / collectBundleClosure / extractSrcExportNames
 * 是发布门禁的文本解析核心，边界（嵌套块注释、字符串内 //、空/畸形 export 块）出错
 * 会误拦/漏放发布门禁——零覆盖的 433 行解析逻辑必须机器锁定。
 * 补充：reportExportDrift / gateTwo 单测（gateTwo 经 coreDir 注入落 tmpdir fixture），
 * 作为复杂度重构（cognitive > 15 三函数）的行为安全网。
 * 补充（MF-1-6）：门③ workflows/ 手写声明对双向对账（extractCjsModuleExportsKeys /
 * extractDctsRuntimeExportNames / gateWorkflowsDeclarationPairs）——tmpdir fixture
 * 红绿自检 + 真实仓声明对 live 只读断言（CI「Test - scripts guards」即实防线）。
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  stripComments,
  parseExportBlocks,
  collectBundleClosure,
  extractSrcExportNames,
  reportExportDrift,
  gateTwo,
  extractCjsModuleExportsKeys,
  extractDctsRuntimeExportNames,
  gateWorkflowsDeclarationPairs,
  findModuleLevelMutableState,
} from '../check-core-dist-gate.mjs'

/** tmpdir fixture 目录工厂：files 为 rel 路径 → 内容 映射，调用方 finally rmSync 清理 */
function makeFixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'core-dist-gate-fx-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  return dir
}

/** 捕获并静音 console 输出（ok() 走 log / fail() 走 error），返回捕获的行数组 */
function withCapturedConsole(fn) {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    fn()
    return { logs: logSpy.mock.calls.flat(), errors: errSpy.mock.calls.flat() }
  } finally {
    logSpy.mockRestore()
    errSpy.mockRestore()
  }
}

describe('stripComments', () => {
  it('行注释剥离、换行保留', () => {
    expect(stripComments('a // trailing\nb')).toBe('a \nb')
  })
  it('块注释剥离到首个 */（JS 语义块注释不嵌套，内层 /* 是普通字符）', () => {
    expect(stripComments('a /* outer /* inner */ b */ c')).toBe('a  b */ c')
  })
  it('字符串字面量内的 // 与 /* 不当注释剥离', () => {
    expect(stripComments(`const u = "http://x" // real`)).toBe('const u = "http://x" ')
    expect(stripComments(`const s = 'a/*b'`)).toBe(`const s = 'a/*b'`)
  })
  it('转义引号不结束字符串状态', () => {
    expect(stripComments(`const s = "a\\"//b"; // c`)).toBe(`const s = "a\\"//b"; `)
  })
  it('未封口块注释越过后安全结束（fail-closed 倾向，不抛）', () => {
    expect(stripComments('a /* never closed')).toBe('a ')
  })
  it('空输入返回空串', () => {
    expect(stripComments('')).toBe('')
  })
  it('未封口字符串保留到 EOF（其中 // 不当注释剥离）', () => {
    expect(stripComments('const s = "a // x')).toBe('const s = "a // x')
  })
  it('字符串末尾孤立转义不抛且原样保留', () => {
    expect(stripComments('x = "a\\')).toBe('x = "a\\')
  })
  it('模板串字面量整段保留（${} 内无引号形态）', () => {
    expect(stripComments('const t = `a ${b} c` // x')).toBe('const t = `a ${b} c` ')
  })
  it('正则字面量内的转义斜杠不触发注释剥离', () => {
    expect(stripComments('const re = /a\\/b/; // c')).toBe('const re = /a\\/b/; ')
  })
  it('块注释结束后字符串状态正常进入', () => {
    expect(stripComments('/* c */ "s//t"')).toBe(' "s//t"')
  })
})

describe('parseExportBlocks', () => {
  it('多行块 + type 前缀 + as 重命名 + 空项', () => {
    const problems = []
    const names = parseExportBlocks(
      'export {\n  foo,\n  type Bar,\n  baz as qux,\n  ,\n  default as def,\n}',
      problems,
      't',
    )
    expect([...names].sort()).toEqual(['Bar', 'def', 'foo', 'qux'])
    expect(problems).toEqual([])
  })
  it('未封口花括号 fail-closed 记 problems', () => {
    const problems = []
    const names = parseExportBlocks('export { a, b', problems, 't')
    expect([...names]).toEqual([])
    expect(problems.length).toBe(1)
    expect(problems[0]).toContain('花括号未封口')
  })
  it('无法解析的导出项记 problems（不静默漏符号）', () => {
    const problems = []
    parseExportBlocks('export { a.b }', problems, 't')
    expect(problems.some((p) => p.includes('a.b'))).toBe(true)
  })
  it('无 export 块文本返回空集且零 problems', () => {
    const problems = []
    const names = parseExportBlocks('const a = 1\nfunction f() {}', problems, 't')
    expect([...names]).toEqual([])
    expect(problems).toEqual([])
  })
  it('空块 export {} 返回空集且零 problems', () => {
    const problems = []
    const names = parseExportBlocks('export {}', problems, 't')
    expect([...names]).toEqual([])
    expect(problems).toEqual([])
  })
  it('type X as Y 剥 type 前缀后按重命名符号收集', () => {
    const problems = []
    const names = parseExportBlocks('export { type T as U }', problems, 't')
    expect([...names]).toEqual(['U'])
    expect(problems).toEqual([])
  })
  it('a as default 重命名收集为 default', () => {
    const problems = []
    const names = parseExportBlocks('export { a as default }', problems, 't')
    expect([...names]).toEqual(['default'])
    expect(problems).toEqual([])
  })
  it('多个 export 块合并收集', () => {
    const problems = []
    const names = parseExportBlocks('export { a }\nconst x = 1\nexport { b, c }', problems, 't')
    expect([...names].sort()).toEqual(['a', 'b', 'c'])
    expect(problems).toEqual([])
  })
  it('export type { ... } 块形态与普通块同等解析（显式类型重导出）', () => {
    const problems = []
    const names = parseExportBlocks('export type { A, B as C } from "./x"', problems, 't')
    expect([...names].sort()).toEqual(['A', 'C'])
    expect(problems).toEqual([])
  })
  it('fail-closed 消息带 where 定位前缀', () => {
    const problems = []
    parseExportBlocks('export { a-b }', problems, './sub src')
    expect(problems[0].startsWith('./sub src:')).toBe(true)
  })
})

describe('collectBundleClosure', () => {
  it('沿相对 import 递归展开 + module 标记从原文提取（注释里的路径不命中）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'core-dist-gate-'))
    try {
      const chunkDir = join(dir, 'chunk')
      mkdirSync(chunkDir)
      writeFileSync(
        join(dir, 'entry.js'),
        [
          '// src/a.ts',
          `import "./chunk/c.js"`,
          `const x = require("./b.cjs")`,
        ].join('\n'),
      )
      writeFileSync(join(dir, 'b.cjs'), '// src/b.ts\nmodule.exports = 1')
      writeFileSync(
        join(chunkDir, 'c.js'),
        [
          '// 注释里写 // src/fake.ts 不算 marker（不在行首整段形态）',
          '// src/c.ts',
          'export {}',
        ].join('\n'),
      )
      const markers = collectBundleClosure(join(dir, 'entry.js'))
      expect(markers.has('src/a.ts')).toBe(true)
      expect(markers.has('src/b.ts')).toBe(true)
      expect(markers.has('src/c.ts')).toBe(true)
      expect(markers.has('src/fake.ts')).toBe(false)
      expect(markers.has('src/c.ts')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('动态 import() 说明符入队展开', () => {
    const dir = makeFixture({
      'entry.js': '// src/a.ts\nawait import("./d.js")',
      'd.js': '// src/d.ts\nexport {}',
    })
    try {
      expect(collectBundleClosure(join(dir, 'entry.js')).has('src/d.ts')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('循环依赖不死循环（seen 保护）且双方 marker 均收集', () => {
    const dir = makeFixture({
      'a.js': '// src/a.ts\nimport { b } from "./b.js"\nexport const a = 1',
      'b.js': '// src/b.ts\nimport { a } from "./a.js"\nexport const b = 1',
    })
    try {
      const markers = collectBundleClosure(join(dir, 'a.js'))
      expect(markers.has('src/a.ts')).toBe(true)
      expect(markers.has('src/b.ts')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('指向不存在文件的相对说明符安全忽略', () => {
    const dir = makeFixture({ 'entry.js': '// src/a.ts\nimport "./missing.js"' })
    try {
      expect(collectBundleClosure(join(dir, 'entry.js')).has('src/a.ts')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('注释里的相对 import 说明符不入队（依赖提取在 stripComments 之后）', () => {
    const dir = makeFixture({
      'entry.js': '// src/a.ts\n// import "./commented.js"\nexport {}',
      'commented.js': '// src/commented.ts\nexport {}',
    })
    try {
      const markers = collectBundleClosure(join(dir, 'entry.js'))
      expect(markers.has('src/a.ts')).toBe(true)
      expect(markers.has('src/commented.ts')).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('无依赖单文件闭包只含自身 marker', () => {
    const dir = makeFixture({ 'entry.js': '// src/only.ts\nexport const x = 1' })
    try {
      expect([...collectBundleClosure(join(dir, 'entry.js'))]).toEqual(['src/only.ts'])
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('extractSrcExportNames', () => {
  it('声明形态 + export 块 + default + export * as；裸 export * fail-closed', () => {
    const src = [
      'export const A = 1',
      'export declare async function B(): void',
      'export type T = number',
      'export interface I {}',
      'export { C as D }',
      'export default class E {}',
      'export * as NS from "./x"',
    ].join('\n')
    const { names, problems } = extractSrcExportNames(src, 't')
    expect([...names].sort()).toEqual(['A', 'B', 'D', 'I', 'NS', 'T', 'default'])
    expect(problems).toEqual([])
  })
  it('export type { ... } from 显式类型重导出块入集（engine-discovery-scan 实际形态，防门②假阳性复发）', () => {
    const { names, problems } = extractSrcExportNames(
      'export type { DiscoveredEngine, PackageInspection } from "./engine-inspect-package.ts"\nexport const A = 1\n',
      't',
    )
    expect([...names].sort()).toEqual(['A', 'DiscoveredEngine', 'PackageInspection'])
    expect(problems).toEqual([])
  })
  it('裸 export * from 记 problems（重导出清单无法文本枚举）', () => {
    const { problems } = extractSrcExportNames('export * from "./x"', 't')
    expect(problems.some((p) => p.includes('export * from'))).toBe(true)
  })
})

describe('findModuleLevelMutableState（门① 启发式 + 只读容器豁免）', () => {
  const runOn = (content) => {
    const dir = makeFixture({ 'mod.ts': content })
    try {
      return findModuleLevelMutableState(join(dir, 'mod.ts'))
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  }

  it('顶层 let 与 const new Map/Set 均命中可变信号', () => {
    const signals = runOn(['let warned = false;', 'const cache = new Map<string, string>();'].join('\n'))
    expect(signals.map((s) => s.signal)).toEqual([
      '模块顶层 let/var 声明（可变绑定）',
      '模块级 new Map/Set（可变容器）',
    ])
  })

  it('顶层类型注解 ReadonlySet/ReadonlyMap/Readonly<Set> 豁免（类型级只读契约）', () => {
    const signals = runOn(
      [
        'export const A: ReadonlySet<string> = new Set(["x"]);',
        'const B: ReadonlyMap<string, number> = new Map([["k", 1]]);',
        'const C: Readonly<Set<string>> = new Set(["y"]);',
      ].join('\n'),
    )
    expect(signals).toEqual([])
  })

  it('容器值只读而容器本身可变（Record 值为 ReadonlySet）不豁免', () => {
    const signals = runOn('const byKind: Record<string, ReadonlySet<string>> = new Map();\n')
    expect(signals).toHaveLength(1)
    expect(signals[0].signal).toBe('模块级 new Map/Set（可变容器）')
  })

  it('函数体内声明（缩进）不命中（列 0 锚定）', () => {
    expect(runOn('function f() {\n  const local = new Set([1]);\n}\n')).toEqual([])
  })
})

describe('reportExportDrift', () => {
  const sub = { key: './sub' }
  const DCTS_REL = './dist/sub.d.cts'
  const DTS_REL = './dist/sub.d.ts'
  const face = (names) => ({ names: new Set(names), problems: [] })

  it('四向零漂移输出 ok 行（含符号数与产物文件名）', () => {
    const { logs, errors } = withCapturedConsole(() =>
      reportExportDrift(sub, DCTS_REL, DTS_REL, face(['A', 'T']), face(['A', 'T']), face(['A', 'T'])),
    )
    expect(logs.join('\n')).toContain('./sub: src 2 符号 ↔ sub.d.cts 2 / sub.d.ts 2，双向零漂移')
    expect(errors).toEqual([])
  })
  it('仅 src 有 dcts 缺 → fail 差集 + 排查提示', () => {
    const { logs, errors } = withCapturedConsole(() =>
      reportExportDrift(sub, DCTS_REL, DTS_REL, face(['A', 'T']), face(['A']), face(['A', 'T'])),
    )
    expect(errors.join('\n')).toContain('./sub: 仅 src 有、./dist/sub.d.cts 缺: T')
    expect(errors.join('\n')).toContain('排查：tsup dts 配置漂移')
    expect(logs).toEqual([])
  })
  it('仅 dist dts 有 src 缺 → fail 差集', () => {
    const { errors } = withCapturedConsole(() =>
      reportExportDrift(sub, DCTS_REL, DTS_REL, face(['A']), face(['A']), face(['A', 'X'])),
    )
    expect(errors.join('\n')).toContain('./sub: 仅 ./dist/sub.d.ts 有、src 缺: X')
  })
  it('dcts 双向组合漂移均逐行输出', () => {
    const { errors } = withCapturedConsole(() =>
      reportExportDrift(sub, DCTS_REL, DTS_REL, face(['A', 'T']), face(['A', 'X']), face(['A', 'T'])),
    )
    const out = errors.join('\n')
    expect(out).toContain('仅 src 有、./dist/sub.d.cts 缺: T')
    expect(out).toContain('仅 ./dist/sub.d.cts 有、src 缺: X')
  })
  it('dts 缺失方向输出 dts 文件名', () => {
    const { errors } = withCapturedConsole(() =>
      reportExportDrift(sub, DCTS_REL, DTS_REL, face(['A']), face(['A']), face([])),
    )
    expect(errors.join('\n')).toContain('仅 src 有、./dist/sub.d.ts 缺: A')
  })
})

describe('gateTwo', () => {
  const SUB = { key: './sub', srcRel: './src/sub.ts' }
  const pkgWithTypes = (types) => ({ exports: { './sub': { require: { types } } } })
  const PKG = pkgWithTypes('./dist/sub.d.cts')
  const SRC = 'export const A = 1\nexport type T = number\nexport { B as C }\n'
  const DCTS_FULL = 'declare const A: number\nexport { A, type T, C }\n'
  const noSubentries = () => []

  it('零漂移全链路通过（src/dcts/dts 符号一致 → ok）', () => {
    const dir = makeFixture({ 'src/sub.ts': SRC, 'dist/sub.d.cts': DCTS_FULL, 'dist/sub.d.ts': DCTS_FULL })
    try {
      const { logs, errors } = withCapturedConsole(() => gateTwo(PKG, [SUB], dir))
      expect(logs.join('\n')).toContain('./sub: src 3 符号 ↔ sub.d.cts 3 / sub.d.ts 3，双向零漂移')
      expect(errors).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('空子入口时门②空转提示', () => {
    const { logs, errors } = withCapturedConsole(() => gateTwo(PKG, noSubentries(), '/nonexistent'))
    expect(logs.join('\n')).toContain('门②空转')
    expect(errors).toEqual([])
  })
  it('src 入口缺失 → fail 且跳过该子入口', () => {
    const dir = makeFixture({ 'dist/sub.d.cts': DCTS_FULL, 'dist/sub.d.ts': DCTS_FULL })
    try {
      const { errors } = withCapturedConsole(() => gateTwo(PKG, [SUB], dir))
      expect(errors.join('\n')).toContain("./sub: src 入口缺失 ./src/sub.ts——exports 与 src 目录漂移")
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('exports require.types 缺失 → fail（D4 契约漂移）', () => {
    const dir = makeFixture({ 'src/sub.ts': SRC })
    try {
      const { errors } = withCapturedConsole(() =>
        gateTwo(pkgWithTypes(undefined), [SUB], dir),
      )
      expect(errors.join('\n')).toContain('./sub: exports require.types 缺失或非 .d.cts')
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('require.types 非 .d.cts 后缀 → fail', () => {
    const dir = makeFixture({ 'src/sub.ts': SRC })
    try {
      const { errors } = withCapturedConsole(() => gateTwo(pkgWithTypes('./dist/sub.d.ts'), [SUB], dir))
      expect(errors.join('\n')).toContain('./sub: exports require.types 缺失或非 .d.cts')
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('.d.cts 产物缺失 → fail（tsup 未产出）', () => {
    const dir = makeFixture({ 'src/sub.ts': SRC, 'dist/sub.d.ts': DCTS_FULL })
    try {
      const { errors } = withCapturedConsole(() => gateTwo(PKG, [SUB], dir))
      expect(errors.join('\n')).toContain("./sub: dist 声明产物缺失 ./dist/sub.d.cts")
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('.d.ts 产物缺失 → fail（import 条件消费方断裂）', () => {
    const dir = makeFixture({ 'src/sub.ts': SRC, 'dist/sub.d.cts': DCTS_FULL })
    try {
      const { errors } = withCapturedConsole(() => gateTwo(PKG, [SUB], dir))
      expect(errors.join('\n')).toContain("./sub: dist 声明产物缺失 ./dist/sub.d.ts")
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('导出清单漂移 → fail 差集（串联 reportExportDrift）', () => {
    const dir = makeFixture({ 'src/sub.ts': SRC, 'dist/sub.d.cts': 'export { A }\n', 'dist/sub.d.ts': DCTS_FULL })
    try {
      const { errors } = withCapturedConsole(() => gateTwo(PKG, [SUB], dir))
      expect(errors.join('\n')).toContain('./sub: 仅 src 有、./dist/sub.d.cts 缺: C, T')
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('符号提取 problems 非空（src 裸 export * from）→ fail 且不比对', () => {
    const dir = makeFixture({
      'src/sub.ts': 'export * from "./x"\n',
      'dist/sub.d.cts': DCTS_FULL,
      'dist/sub.d.ts': DCTS_FULL,
    })
    try {
      const { errors } = withCapturedConsole(() => gateTwo(PKG, [SUB], dir))
      expect(errors.join('\n')).toContain('./sub src: src 出现裸 export * from')
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

// ---------- 门③：workflows/ 手写声明对双向对账（MF-1-6） ----------

describe('extractCjsModuleExportsKeys', () => {
  it('短手法 + 标识符字符串键 + 块内注释剥离 + 多行块', () => {
    const src = [
      'const A = 1',
      '// 头注释',
      'module.exports = {',
      '  A,',
      '  // 块内行注释',
      "  'keyName': A,",
      '  B,',
      '};',
    ].join('\n')
    const { names, problems } = extractCjsModuleExportsKeys(src, 't.cjs')
    expect([...names].sort()).toEqual(['A', 'B', 'keyName'])
    expect(problems).toEqual([])
  })
  it('嵌套字面量值保持单一导出项（深度感知切分，键正确提取不碎成假键）', () => {
    const { names, problems } = extractCjsModuleExportsKeys('module.exports = { a, b: { c: 1, d: 2 } }', 't.cjs')
    expect([...names].sort()).toEqual(['a', 'b'])
    expect(problems).toEqual([])
  })
  it('无法解析的导出项（计算键 / 展开）记 problems（fail-closed 不静默漏）', () => {
    for (const bad of ['[k]: v', '...rest', "'key-name': v"]) {
      const { problems } = extractCjsModuleExportsKeys(`module.exports = { a, ${bad} }`, 't.cjs')
      expect(problems.length).toBe(1)
      expect(problems[0]).toContain('无法解析的导出项')
    }
  })
  it('缺 module.exports 块 → problem', () => {
    const { names, problems } = extractCjsModuleExportsKeys('const a = 1', 't.cjs')
    expect([...names]).toEqual([])
    expect(problems.length).toBe(1)
    expect(problems[0]).toContain('未找到 module.exports')
  })
  it('块外补充导出（module.exports.x = / exports.x =）→ problem（单一导出块义务）', () => {
    for (const extra of ['module.exports.x = 1', 'exports.y = 2']) {
      const { problems } = extractCjsModuleExportsKeys(`module.exports = { a }\n${extra}`, 't.cjs')
      expect(problems.length).toBe(1)
      expect(problems[0]).toContain('块外补充导出')
    }
  })
})

describe('extractDctsRuntimeExportNames', () => {
  it('declare function/const 收集；type/interface 不入集（无运行时对应物）', () => {
    const src = [
      'export type FailFn = (msg: string) => void;',
      'export interface ScoreEntry { x: number }',
      'export declare function parseBatches(a: unknown): string[];',
      'export declare function planReviewerOrder<T extends { name: string }>(items: T[]): T[];',
      'export declare const TARGET_TYPES: string[];',
      'export declare const REVIEWER_BATCH: number;',
    ].join('\n')
    const { names, problems } = extractDctsRuntimeExportNames(src, 't.d.cts')
    expect([...names].sort()).toEqual(['REVIEWER_BATCH', 'TARGET_TYPES', 'parseBatches', 'planReviewerOrder'])
    expect(problems).toEqual([])
  })
  it('export { } 块形态与 export default 记 problems（declare 形态外 fail-closed）', () => {
    const { names, problems } = extractDctsRuntimeExportNames(
      'export declare function a(): void;\nexport { b };\nexport default c;',
      't.d.cts',
    )
    expect([...names]).toEqual(['a'])
    expect(problems.length).toBe(2)
    expect(problems.some((p) => p.includes('export { } 块形态'))).toBe(true)
    expect(problems.some((p) => p.includes('export default'))).toBe(true)
  })
})

describe('gateWorkflowsDeclarationPairs', () => {
  /** 空转提示期望（无声明对可查时门③不红） */
  const expectIdle = ({ logs, errors }) => {
    expect(logs.join('\n')).toContain('门③空转')
    expect(errors).toEqual([])
  }
  /** 豁免登记 fixture：SLOW_POOL 允许不在 d.cts 声明 */
  const ALLOWED = new Map([['review-fix-loop-utils.cjs', new Set(['SLOW_POOL'])]])
  const CJS_GREEN = [
    'module.exports = {',
    '  A,',
    '  inheritCarryoverFields,',
    '  dormantRevivalTitle,',
    '  SLOW_POOL,',
    '};',
  ].join('\n')
  const DCTS_GREEN = [
    'export type FailFn = (msg: string) => void;',
    'export declare function A(): void;',
    'export declare function inheritCarryoverFields(t: unknown, e: unknown): boolean;',
    'export declare function dormantRevivalTitle(d: unknown, e: unknown): string | undefined;',
  ].join('\n')

  it('对称声明对（含豁免登记的未声明导出 + 本次修复符号正向在场）→ ok 双向零漂移', () => {
    const dir = makeFixture({ 'workflows/review-fix-loop-utils.cjs': CJS_GREEN, 'workflows/review-fix-loop-utils.d.cts': DCTS_GREEN })
    try {
      const { logs, errors } = withCapturedConsole(() => gateWorkflowsDeclarationPairs(join(dir, 'workflows'), ALLOWED))
      expect(errors).toEqual([])
      expect(logs.join('\n')).toContain('cjs 4 导出 / d.cts 3 声明（豁免登记 1），双向零漂移')
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('陈旧声明方向（d.cts 声明、cjs 已无）→ fail，豁免不可豁免此方向', () => {
    const dir = makeFixture({
      'workflows/pair.cjs': 'module.exports = { A }',
      'workflows/pair.d.cts': 'export declare function A(): void;\nexport declare function Stale(): void;',
    })
    try {
      const { errors } = withCapturedConsole(() => gateWorkflowsDeclarationPairs(join(dir, 'workflows'), ALLOWED))
      expect(errors.join('\n')).toContain('仅 d.cts 声明、cjs module.exports 已无（陈旧声明')
      expect(errors.join('\n')).toContain('Stale')
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('未声明方向在豁免登记外 → fail 且提示补声明或登记', () => {
    const dir = makeFixture({
      'workflows/pair.cjs': 'module.exports = { A, NewThing }',
      'workflows/pair.d.cts': 'export declare function A(): void;',
    })
    try {
      const { errors } = withCapturedConsole(() => gateWorkflowsDeclarationPairs(join(dir, 'workflows'), ALLOWED))
      expect(errors.join('\n')).toContain('仅 cjs 导出、d.cts 未声明且未登记豁免: NewThing')
      expect(errors.join('\n')).toContain('WORKFLOWS_UNDECLARED_ALLOWED')
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('未声明方向命中豁免登记 → 放行（登记键 = 相对 workflows/ 路径）', () => {
    const dir = makeFixture({
      'workflows/_shared/deep.cjs': 'module.exports = { A, SLOW_POOL }',
      'workflows/_shared/deep.d.cts': 'export declare function A(): void;',
    })
    try {
      const allowed = new Map([['_shared/deep.cjs', new Set(['SLOW_POOL'])]])
      const { logs, errors } = withCapturedConsole(() => gateWorkflowsDeclarationPairs(join(dir, 'workflows'), allowed))
      expect(errors).toEqual([])
      expect(logs.join('\n')).toContain('双向零漂移')
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('无同名 .d.cts 的 .cjs 不设义务；全部无对 → 空转', () => {
    const dir = makeFixture({ 'workflows/lonely.cjs': 'module.exports = { A }' })
    try {
      expectIdle(withCapturedConsole(() => gateWorkflowsDeclarationPairs(join(dir, 'workflows'), ALLOWED)))
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('workflows 目录不存在 → 空转（不抛）', () => {
    expectIdle(withCapturedConsole(() => gateWorkflowsDeclarationPairs('/nonexistent-workflows-g3', ALLOWED)))
  })
  it('解析 problems（块外补充导出）优先 fail 且不比对差集', () => {
    const dir = makeFixture({
      'workflows/pair.cjs': 'module.exports = { A }\nmodule.exports.B = 1',
      'workflows/pair.d.cts': 'export declare function A(): void;',
    })
    try {
      const { errors } = withCapturedConsole(() => gateWorkflowsDeclarationPairs(join(dir, 'workflows'), ALLOWED))
      expect(errors.join('\n')).toContain('块外补充导出')
      expect(errors.join('\n')).not.toContain('双向零漂移')
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('真实仓 workflows 声明对 live 只读断言（MF-1-6 门③ 实防线）', () => {
  it('packages/subagent-core/workflows 手写声明对经默认豁免登记双向零漂移', () => {
    const workflowsDir = fileURLToPath(new URL('../../packages/subagent-core/workflows', import.meta.url))
    const { logs, errors } = withCapturedConsole(() => gateWorkflowsDeclarationPairs(workflowsDir))
    expect(errors).toEqual([])
    expect(logs.join('\n')).toContain('review-fix-loop-utils.cjs')
    expect(logs.join('\n')).toContain('双向零漂移')
  })
})
