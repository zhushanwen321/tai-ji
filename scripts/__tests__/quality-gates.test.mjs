/**
 * quality-gates.mjs 单测：聚合编排 / base 口径两侧参数 / 实体缺失报错路径 / 盲区判定。
 *
 * 子进程命令全部走依赖注入的 fake（不真跑 typecheck / coverage-gate.py / metrics-gate.py
 * 等重型命令）；coverage.json 与 metrics.json 以内存对象注入（judgeNoLcov 的 readHead
 * 同样注入，不写盘读盘）。
 */
import { describe, it, expect } from 'vitest'
import {
  parseGateArgs,
  resolveBase,
  buildCoverageCommand,
  buildMetricsCommand,
  buildTypecheckSteps,
  hasExecutableLines,
  judgeNoLcov,
  runGates,
} from '../quality-gates.mjs'

/** 可编程 fake git：args.join 前缀匹配返回 stdout，未命中抛错（对齐 execFileSync 语义） */
function fakeGit(routes) {
  return (args) => {
    const key = args.join(' ')
    for (const [prefix, out] of Object.entries(routes)) {
      if (key.startsWith(prefix)) return out
    }
    throw new Error(`fake git: no route for ${key}`)
  }
}

function okExec() {
  return () => ({ status: 0, stdout: '', stderr: '' })
}

function okRunPython() {
  return () => ({ status: 0, stdout: 'Gate ok', stderr: '' })
}

/** 组装全绿 deps（可逐项覆盖）；readJson 返回最小 coverage/metrics 产物形态 */
function makeDeps(overrides = {}) {
  return {
    root: '/fake-root',
    git: fakeGit({ 'merge-base github/main HEAD': 'abc123def\n', 'merge-base main HEAD': 'abc123def\n' }),
    exec: okExec(),
    runPython: okRunPython(),
    exists: () => true,
    readHead: () => null,
    readJson: (rel) =>
      rel.endsWith('coverage.json')
        ? { verdict: 'pass', packages: {} }
        : rel.endsWith('metrics.json')
          ? { verdict: 'pass', warn: [], targets: { high_crap: [] } }
          : null,
    ...overrides,
  }
}

describe('parseGateArgs', () => {
  it('默认 side = pr-cr-fix', () => {
    expect(parseGateArgs([])).toEqual({ side: 'pr-cr-fix', base: null, json: false })
  })
  it('接受 --side dev-merge 与 --base', () => {
    expect(parseGateArgs(['--side', 'dev-merge', '--base', 'dev-0.10.4', '--json']).side).toBe('dev-merge')
    expect(parseGateArgs(['--base', 'v9']).base).toBe('v9')
  })
  it('非法 side 与未知参数 fail-fast（exit 2 语义）', () => {
    expect(() => parseGateArgs(['--side', 'bogus'])).toThrow('--side')
    expect(() => parseGateArgs(['--wat'])).toThrow('未知参数')
  })
})

describe('resolveBase：base 口径两侧差异（有意保留，参数化承载）', () => {
  it('pr-cr-fix 侧 = main（累积）', () => {
    expect(resolveBase({ side: 'pr-cr-fix', explicitBase: null }, fakeGit({}))).toEqual({
      base: 'main',
      source: 'pr-cr-fix-cumulative',
    })
  })
  it('dev-merge 侧 = merge-base github/main HEAD（分支增量，取 commit hash）', () => {
    const git = fakeGit({ 'merge-base github/main HEAD': 'c0ffee0\n' })
    expect(resolveBase({ side: 'dev-merge', explicitBase: null }, git)).toEqual({
      base: 'c0ffee0',
      source: 'dev-merge-incremental(github/main)',
    })
  })
  it('显式 --base 对两侧均覆盖', () => {
    expect(resolveBase({ side: 'pr-cr-fix', explicitBase: 'x' }, fakeGit({})).source).toBe('explicit')
    expect(resolveBase({ side: 'dev-merge', explicitBase: 'x' }, fakeGit({})).base).toBe('x')
  })
  it('dev-merge 侧 github/main 缺失时 fallback main', () => {
    const git = (args) => {
      if (args.join(' ').includes('github/main')) throw new Error('no ref')
      return 'f00ba12\n'
    }
    expect(resolveBase({ side: 'dev-merge', explicitBase: null }, git).base).toBe('f00ba12')
  })
  it('两侧 ref 均不可解析 → 报错含恢复指引（不静默回退 main 口径）', () => {
    const git = () => {
      throw new Error('no ref')
    }
    expect(() => resolveBase({ side: 'dev-merge', explicitBase: null }, git)).toThrow('--base')
  })
})

describe('子进程命令构建（py 参数面锚点）', () => {
  it('coverage-gate 命令透传 --base', () => {
    expect(buildCoverageCommand('.agents/skills/pr-cr-fix/scripts/coverage-gate.py', 'main')).toEqual([
      'python3',
      '.agents/skills/pr-cr-fix/scripts/coverage-gate.py',
      '--base',
      'main',
    ])
  })
  it('metrics-gate 命令透传 --base（dev-merge 侧 hash 与 pr-cr-fix 侧 main 走同构参数面）', () => {
    expect(buildMetricsCommand('.agents/skills/pr-cr-fix/scripts/metrics-gate.py', 'c0ffee0')).toEqual([
      'python3',
      '.agents/skills/pr-cr-fix/scripts/metrics-gate.py',
      '--base',
      'c0ffee0',
    ])
  })
  it('typecheck 四处：命令与 cwd 与 pr-pre-merge.sh 同款（mobile-renderer 为 renderer 同构消费包）', () => {
    const steps = buildTypecheckSteps()
    expect(steps.map((s) => s.name)).toEqual([
      'typecheck:extensions',
      'typecheck:runtime',
      'typecheck:renderer',
      'typecheck:mobile-renderer',
    ])
    expect(steps[0]).toMatchObject({ cmd: 'npx', args: ['tsc', '--noEmit'], cwd: 'extensions' })
    expect(steps[1]).toMatchObject({ cmd: 'pnpm', cwd: 'packages/runtime' })
    expect(steps[2]).toMatchObject({ cmd: 'pnpm', cwd: 'packages/renderer' })
    expect(steps[3]).toMatchObject({ cmd: 'pnpm', cwd: 'packages/mobile-renderer' })
  })
})

describe('runGates 聚合编排（fake 子进程，不真跑重型命令）', () => {
  it('全绿 → exitCode 0，六个 gate 全 PASS', async () => {
    const { exitCode, result } = await runGates(makeDeps(), { side: 'pr-cr-fix', base: null })
    expect(exitCode).toBe(0)
    expect(result.verdict).toBe('pass')
    expect(result.gates.map((g) => g.name)).toEqual([
      'typecheck:extensions',
      'typecheck:runtime',
      'typecheck:renderer',
      'typecheck:mobile-renderer',
      'coverage-gate',
      'coverage-blindspot',
      'metrics-gate',
    ])
    expect(result.gates.every((g) => g.status === 'PASS')).toBe(true)
  })
  it('typecheck 一处 FAIL → exitCode 1，其余门照跑', async () => {
    const deps = makeDeps({
      exec: (cmd, args, cwd) => {
        if (cwd === 'packages/renderer') return { status: 2, stdout: '', stderr: 'error TS2304: x' }
        return { status: 0, stdout: '', stderr: '' }
      },
    })
    const { exitCode, result } = await runGates(deps, { side: 'pr-cr-fix', base: null })
    expect(exitCode).toBe(1)
    expect(result.verdict).toBe('fail')
    const renderer = result.gates.find((g) => g.name === 'typecheck:renderer')
    expect(renderer.status).toBe('FAIL')
    expect(renderer.detail).toContain('TS2304')
  })
  it('py 实体缺失 → exitCode 2，错误指明缺失路径与恢复通道，且不跑任何门', async () => {
    let execCalls = 0
    let pyCalls = 0
    const deps = makeDeps({
      exists: (rel) => !rel.includes('metrics-gate.py'),
      exec: () => { execCalls += 1; return { status: 0, stdout: '', stderr: '' } },
      runPython: () => { pyCalls += 1; return { status: 0, stdout: '', stderr: '' } },
    })
    const { exitCode, result } = await runGates(deps, { side: 'pr-cr-fix', base: null })
    expect(exitCode).toBe(2)
    expect(result.error.missing[0]).toContain('.agents/skills/pr-cr-fix/scripts/metrics-gate.py')
    expect(result.error.message).toContain('refs/skills-snapshot')
    expect(execCalls).toBe(0)
    expect(pyCalls).toBe(0)
  })
  it('coverage-gate.py 工具错误（exit 2）→ exitCode 2 带明细', async () => {
    const deps = makeDeps({ runPython: () => ({ status: 2, stdout: '', stderr: 'git 异常' }) })
    const { exitCode, result } = await runGates(deps, { side: 'pr-cr-fix', base: null })
    expect(exitCode).toBe(2)
    expect(result.error.detail).toContain('git 异常')
  })
  it('metrics-gate.py FAIL（exit 1）→ exitCode 1', async () => {
    const deps = makeDeps({
      runPython: (args) =>
        args[1].includes('coverage-gate.py')
          ? { status: 0, stdout: '', stderr: '' }
          : { status: 1, stdout: 'FAIL [complexity] x', stderr: '' },
    })
    const { exitCode } = await runGates(deps, { side: 'pr-cr-fix', base: null })
    expect(exitCode).toBe(1)
  })
})

describe('judgeNoLcov：机器盲区判定（决策 4 判定边界）', () => {
  const report = (files) => ({
    verdict: 'pass',
    packages: {
      'packages/foo': { status: 'OK', files_without_lcov: files },
    },
  })

  it('含可执行行且无豁免 → FAIL 面，reason 带恢复动作', () => {
    const files = { 'packages/foo/src/new-logic.ts': 'export function calc(a) {\n  return a * 2;\n}\n' }
    const { violations, exempt } = judgeNoLcov(report(Object.keys(files)), (f) => files[f])
    expect(violations).toHaveLength(1)
    expect(violations[0].file).toBe('packages/foo/src/new-logic.ts')
    expect(violations[0].fix).toContain('coverage-file-gate-exempt')
    expect(exempt).toHaveLength(0)
  })
  it('豁免通道（文件头 coverage-file-gate-exempt）→ 出 FAIL 面、登记 exempt（可见不静默）', () => {
    const files = {
      'packages/foo/src/composition-root.ts':
        '// coverage-file-gate-exempt: 组合根装配接线，单测结构性不可达\nexport const wiring = build();\n',
    }
    const { violations, exempt } = judgeNoLcov(report(Object.keys(files)), (f) => files[f])
    expect(violations).toHaveLength(0)
    expect(exempt).toHaveLength(1)
    expect(exempt[0].reason).toContain('组合根')
  })
  it('纯 interface/type 文件整文件排除（无可执行分支不 FAIL）', () => {
    const files = {
      'packages/foo/src/types.ts':
        'import type { Base } from "./base";\n\ntype Foo = Base & {\n  a: string;\n  b: number;\n};\n\ntype Bar = Array<{ c: boolean }>;\n',
    }
    expect(judgeNoLcov(report(Object.keys(files)), (f) => files[f]).violations).toHaveLength(0)
  })
  it('纯常量字面量声明文件排除；常量值带函数调用 → FAIL 面', () => {
    const files = {
      'packages/foo/src/consts.ts': 'const LIMITS = {\n  max: 10,\n  min: 1,\n} as const;\n',
      'packages/foo/src/eager.ts': 'export const config = buildConfig();\n',
    }
    const { violations } = judgeNoLcov(report(Object.keys(files)), (f) => files[f])
    expect(violations.map((v) => v.file)).toEqual(['packages/foo/src/eager.ts'])
  })
  it('纯导出聚合 barrel 排除；bare side-effect import 视为可执行', () => {
    const files = {
      'packages/foo/src/index.ts': "export * from './a';\nexport { b } from './b';\nexport type { C } from './c';\n",
      'packages/foo/src/polyfill.ts': "import './shim';\n",
    }
    const { violations } = judgeNoLcov(report(Object.keys(files)), (f) => files[f])
    expect(violations.map((v) => v.file)).toEqual(['packages/foo/src/polyfill.ts'])
  })
  it('.vue 文件保守不排除（template 渲染行为面）', () => {
    const files = { 'packages/foo/src/Panel.vue': '<template>\n  <div>hi</div>\n</template>\n' }
    expect(judgeNoLcov(report(Object.keys(files)), (f) => files[f]).violations).toHaveLength(1)
  })
  it('非 OK 包（SKIP/FAIL）不进盲区判定面', () => {
    const reportSkip = { packages: { 'packages/foo': { status: 'SKIP', files_without_lcov: ['packages/foo/src/x.ts'] } } }
    expect(judgeNoLcov(reportSkip, () => 'export const a = 1;\n').violations).toHaveLength(0)
  })
})

describe('hasExecutableLines：可执行行口径单元矩阵', () => {
  it('空文件 / 纯注释 → false', () => {
    expect(hasExecutableLines('', 'a.ts')).toBe(false)
    expect(hasExecutableLines('// only comment\n/* block\nstill */\n', 'a.ts')).toBe(false)
  })
  it('字符串字面量内的 // 与括号不参与判定', () => {
    expect(hasExecutableLines("const URL_DOC = 'https://x.y/a(1)';\n", 'a.ts')).toBe(false)
  })
  it('function / class / enum / 控制流 → true（保守）', () => {
    expect(hasExecutableLines('export function f() {}\n', 'a.ts')).toBe(true)
    expect(hasExecutableLines('export class C {}\n', 'a.ts')).toBe(true)
    expect(hasExecutableLines('export enum E { A }\n', 'a.ts')).toBe(true)
  })
})
