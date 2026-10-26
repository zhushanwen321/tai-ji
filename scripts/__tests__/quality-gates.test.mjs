/**
 * quality-gates.mjs 单测：聚合编排 / base 口径两侧参数 / 实体缺失报错路径 / 盲区判定。
 *
 * 子进程命令全部走依赖注入的 fake（不真跑 typecheck / coverage-gate.py / metrics-gate.py
 * 等重型命令）；coverage.json 与 metrics.json 以内存对象注入（judgeNoLcov 的 readHead
 * 同样注入，不写盘读盘）。
 */
import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, realpathSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import {
  parseGateArgs,
  resolveBase,
  buildCoverageCommand,
  buildMetricsCommand,
  buildTypecheckSteps,
  buildGateEnv,
  hasExecutableLines,
  judgeNoLcov,
  runGates,
  gateLockPath,
  acquireGateLock,
  captureProcessStartTime,
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

/** 组装带计数 stub 的 deps 跑 runGates（两个 exitCode 2 用例共用，消除重复块）；
 *  返回 { exitCode, result, calls }——calls 用于断言「一门都没跑」。 */
async function runGatesCounting(overrides = {}) {
  const calls = { exec: 0, py: 0 }
  const deps = makeDeps({
    exec: () => { calls.exec += 1; return { status: 0, stdout: '', stderr: '' } },
    runPython: () => { calls.py += 1; return { status: 0, stdout: '', stderr: '' } },
    ...overrides,
  })
  const { exitCode, result } = await runGates(deps, { side: 'pr-cr-fix', base: null })
  return { exitCode, result, calls }
}

/** 组装全绿 deps（可逐项覆盖）；readJson / readReviewJson 返回最小 coverage/metrics 产物形态。
 *  reviewDir=null = 新产物目录不可用，readReviewJson 与 readJson 同走旧 `.review/` 回退语义。 */
function makeDeps(overrides = {}) {
  const jsonStub = (rel) =>
    rel.endsWith('coverage.json')
      ? { verdict: 'pass', packages: {} }
      : rel.endsWith('metrics.json')
        ? { verdict: 'pass', warn: [], targets: { high_crap: [] } }
        : null
  return {
    root: '/fake-root',
    reviewDir: null,
    git: fakeGit({ 'merge-base github/main HEAD': 'abc123def\n', 'merge-base main HEAD': 'abc123def\n' }),
    exec: okExec(),
    runPython: okRunPython(),
    exists: () => true,
    readHead: () => null,
    readJson: jsonStub,
    readReviewJson: jsonStub,
    // worktree 级互斥锁：单测注入直通（真锁走 acquireGateLock 单测覆盖）
    acquireGateLock: () => () => {},
    ...overrides,
  }
}

describe('parseGateArgs', () => {
  it('默认 side = pr-cr-fix（only=null 全跑）', () => {
    expect(parseGateArgs([])).toEqual({ side: 'pr-cr-fix', base: null, json: false, only: null })
  })
  it('--only 组过滤：合法列表解析、未知组与缺值 fail-fast', () => {
    expect(parseGateArgs(['--only', 'typecheck,test']).only).toEqual(['typecheck', 'test'])
    expect(parseGateArgs(['--only', 'typecheck, test']).only).toEqual(['typecheck', 'test'])
    expect(() => parseGateArgs(['--only', 'bogus'])).toThrow('--only')
    expect(() => parseGateArgs(['--only'])).toThrow('--only')
  })
  it('--only 纯分隔符（, / ,, / 空白）解析为空组列表 → 报用法错误（防零门执行的「无检查即绿」）', () => {
    expect(() => parseGateArgs(['--only', ','])).toThrow('至少需要一个有效组名')
    expect(() => parseGateArgs(['--only', ',,'])).toThrow('至少需要一个有效组名')
    expect(() => parseGateArgs(['--only', ' , '])).toThrow('至少需要一个有效组名')
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

describe('子进程命令构建（py 参数侧锚点）', () => {
  it('coverage-gate 命令透传 --base', () => {
    expect(buildCoverageCommand('.agents/skills/pr-cr-fix/scripts/coverage-gate.py', 'main')).toEqual([
      'python3',
      '.agents/skills/pr-cr-fix/scripts/coverage-gate.py',
      '--base',
      'main',
    ])
  })
  it('metrics-gate 命令透传 --base（dev-merge 侧 hash 与 pr-cr-fix 侧 main 走同构的参数侧）', () => {
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
  it('全绿 → exitCode 0，全部 gate PASS（typecheck×4 + coverage/blindspot/metrics + 快速守卫族×4）', async () => {
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
      'test-suite:taste-lint',
      'test-suite:resources-plugins',
      'test-suite:builtin-ext-bundle',
      'test-suite:scripts-guards',
    ])
    expect(result.gates.every((g) => g.status === 'PASS')).toBe(true)
  })
  it('--only typecheck,test → 只跑指定门组；py 实体缺失不再 fail-fast、base 不解析（merge 阶段 1 调用形态）', async () => {
    const deps = makeDeps({ exists: () => false }) // py 实体全缺
    const { exitCode, result } = await runGates(deps, { side: 'pr-cr-fix', base: null, only: ['typecheck', 'test'] })
    expect(exitCode).toBe(0)
    expect(result.verdict).toBe('pass')
    expect(result.base).toBeNull()
    expect(result.gates.map((g) => g.name)).toEqual([
      'typecheck:extensions',
      'typecheck:runtime',
      'typecheck:renderer',
      'typecheck:mobile-renderer',
      'test-suite:taste-lint',
      'test-suite:resources-plugins',
      'test-suite:builtin-ext-bundle',
      'test-suite:scripts-guards',
    ])
  })

  it('--only 含 coverage 时 py 实体缺失保持 fail-fast（exit 2，不白跑）', async () => {
    const deps = makeDeps({ exists: () => false })
    const { exitCode, result } = await runGates(deps, { side: 'pr-cr-fix', base: null, only: ['typecheck', 'coverage'] })
    expect(exitCode).toBe(2)
    expect(result.verdict).toBe('error')
    expect(result.gates).toEqual([])
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
  it('typecheck spawn 失败（命令不在 PATH，status null + error）→ FAIL 且 detail 含命令名与恢复动作（非哑 FAIL）', async () => {
    const deps = makeDeps({
      exec: () => ({ status: null, stdout: '', stderr: '', error: new Error('spawn npx ENOENT') }),
    })
    const { result } = await runGates(deps, { side: 'pr-cr-fix', base: null })
    const ext = result.gates.find((g) => g.name === 'typecheck:extensions')
    expect(ext.status).toBe('FAIL')
    expect(ext.detail).toContain('npx')
    expect(ext.detail).toContain('PATH')
    expect(ext.detail).toContain('spawn npx ENOENT')
  })
  it('py 实体缺失 → exitCode 2，错误指明缺失路径与恢复通道，且不跑任何门', async () => {
    const { exitCode, result, calls } = await runGatesCounting({ exists: (rel) => !rel.includes('metrics-gate.py') })
    expect(exitCode).toBe(2)
    expect(result.error.missing[0]).toContain('.agents/skills/pr-cr-fix/scripts/metrics-gate.py')
    expect(result.error.message).toContain('refs/skills-snapshot')
    expect(calls.exec).toBe(0)
    expect(calls.py).toBe(0)
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
  it('互斥锁获取失败 → exitCode 2 环境错误（含恢复动作），且一门都不跑', async () => {
    const { exitCode, result, calls } = await runGatesCounting({
      acquireGateLock: () => {
        throw new Error('等待 quality-gates 互斥锁超时（20 分钟）：/tmp/x.lock 被进程 123 持有且未释放')
      },
    })
    expect(exitCode).toBe(2)
    expect(result.error.message).toContain('互斥锁获取失败')
    expect(result.error.recover).toContain('quality-gates')
    expect(calls.exec).toBe(0)
    expect(calls.py).toBe(0)
  })
  it('门禁 FAIL 路径跑完后互斥锁必释放（finally 语义，不泄漏给下一轮）', async () => {
    let released = 0
    const deps = makeDeps({
      acquireGateLock: () => () => { released += 1 },
      exec: (cmd, args, cwd) =>
        cwd === 'packages/renderer' ? { status: 2, stdout: '', stderr: 'error TS2304: x' } : { status: 0, stdout: '', stderr: '' },
    })
    const { exitCode } = await runGates(deps, { side: 'pr-cr-fix', base: null })
    expect(exitCode).toBe(1)
    expect(released).toBe(1)
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
  it('.vue 文件保守不排除（template 渲染行为范围）', () => {
    const files = { 'packages/foo/src/Panel.vue': '<template>\n  <div>hi</div>\n</template>\n' }
    expect(judgeNoLcov(report(Object.keys(files)), (f) => files[f]).violations).toHaveLength(1)
  })
  it('非 OK 包（SKIP/FAIL）不进盲区判定范围', () => {
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

describe('buildGateEnv：门禁子进程 PATH 自举', () => {
  it('存在的候选目录（PNPM_HOME）追加到现有 PATH 尾部，原 PATH 顺序保持、其余 env 透传', () => {
    const pnpmHome = mkdtempSync(join(tmpdir(), 'quality-gates-env-'))
    try {
      const env = buildGateEnv({ PATH: '/usr/bin:/bin', PNPM_HOME: pnpmHome, MY_FLAG: '1' })
      expect(env.PATH.split(delimiter).slice(0, 2)).toEqual(['/usr/bin', '/bin'])
      expect(env.PATH.split(delimiter)).toContain(pnpmHome)
      expect(env.MY_FLAG).toBe('1')
    } finally {
      rmSync(pnpmHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('PATH 已含的目录不重复追加', () => {
    const pnpmHome = mkdtempSync(join(tmpdir(), 'quality-gates-env-'))
    try {
      const env = buildGateEnv({ PATH: `/usr/bin${delimiter}${pnpmHome}`, PNPM_HOME: pnpmHome })
      expect(env.PATH.split(delimiter).filter((d) => d === pnpmHome)).toHaveLength(1)
    } finally {
      rmSync(pnpmHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('不存在的候选目录不追加', () => {
    const env = buildGateEnv({ PATH: '/usr/bin', PNPM_HOME: join(tmpdir(), 'quality-gates-nonexistent-xyz') })
    expect(env.PATH.split(delimiter)).not.toContain(join(tmpdir(), 'quality-gates-nonexistent-xyz'))
  })
  it('真实环境：运行中 node 的真实 bin 目录（symlink 解析后）必在自举后的 PATH 中', () => {
    const nodeRealBinDir = dirname(realpathSync(process.execPath))
    expect(buildGateEnv().PATH.split(delimiter)).toContain(nodeRealBinDir)
  })
})

describe('gateLockPath：worktree 级互斥锁路径', () => {
  it('同 root 确定性同路径；不同 root 不同桶；落 tmpdir 不污染工作区', () => {
    const a = gateLockPath('/repo/a')
    expect(gateLockPath('/repo/a')).toBe(a)
    expect(gateLockPath('/repo/b')).not.toBe(a)
    expect(dirname(a)).toBe(tmpdir())
    expect(a.endsWith('.lock')).toBe(true)
  })
})

describe('acquireGateLock：互斥获取 / 幂等释放 / 无主偷锁三通道 / 超时', () => {
  /** 每个用例一个独立临时目录（锁文件落盘，跑完即清） */
  function withLockDir(fn) {
    const dir = mkdtempSync(join(tmpdir(), 'quality-gates-lock-'))
    try {
      fn(join(dir, 'g.lock'))
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  }

  /** 无主锁用例共用：写锁内容 → 短超时 acquire（无主偷锁接管）→ 断言本进程持锁 → release。 */
  function stealAssertRelease(lockPath, content) {
    writeFileSync(lockPath, content)
    const release = acquireGateLock(lockPath, { timeoutMs: 1000, pollMs: 10 })
    expect(JSON.parse(readFileSync(lockPath, 'utf-8')).pid).toBe(process.pid)
    release()
  }

  it('空闲时获取成功（link 原子建锁：内容含本进程 pid + 启动时间、结构上不为空），release 幂等且删除锁文件、可再次获取', () => {
    withLockDir((lockPath) => {
      const release = acquireGateLock(lockPath)
      expect(existsSync(lockPath)).toBe(true)
      const info = JSON.parse(readFileSync(lockPath, 'utf-8'))
      expect(info.pid).toBe(process.pid)
      // 启动时间身份因子在 linux/darwin 必非空（平台不支持才为 null）
      if (process.platform === 'linux' || process.platform === 'darwin') {
        expect(typeof info.started).toBe('string')
      }
      release()
      release() // 幂等：二次释放不抛、不动已删除的锁
      expect(existsSync(lockPath)).toBe(false)
      const release2 = acquireGateLock(lockPath)
      release2()
    })
  })

  it('持锁进程已退出（新格式 JSON / 旧格式纯 pid）→ 按 pid 存活判定确定性偷锁，不等时间窗', () => {
    withLockDir((lockPath) => {
      const dead = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' })
      stealAssertRelease(lockPath, JSON.stringify({ pid: dead.pid, started: 'linux:0' }))
      // 旧格式（纯 pid 数字，过渡期兼容）→ started 缺失降级纯 pid 存活语义，死 pid 同样偷
      stealAssertRelease(lockPath, String(dead.pid))
    })
  })

  it('pid 复用（pid 存活但启动时间与锁内记录不符）→ 判非原持锁方偷锁', () => {
    withLockDir((lockPath) => {
      // 本进程 pid + 伪造启动时间 = 复用形态（pid 活、身份不符）
      stealAssertRelease(lockPath, JSON.stringify({ pid: process.pid, started: 'linux:1740000000' }))
    })
  })

  it('空锁文件（旧实现「建文件→写 pid」两步间崩溃残留）→ 立即判无主偷锁', () => {
    withLockDir((lockPath) => {
      stealAssertRelease(lockPath, '')
    })
  })

  it('持锁方存活且身份成立（本进程 pid + 真实启动时间）→ 不偷，超时抛错，信息含锁路径与持锁 pid（可操作）', () => {
    withLockDir((lockPath) => {
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started: captureProcessStartTime(process.pid) }))
      let err = null
      try {
        acquireGateLock(lockPath, { timeoutMs: 60, pollMs: 10 })
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toContain('互斥锁超时')
      expect(err.message).toContain(lockPath)
      expect(err.message).toContain(String(process.pid))
    })
  })

  it('持锁方在等待期间释放 → 等待方获取成功（串行化语义，非偷锁路径）', () => {
    withLockDir((lockPath) => {
      writeFileSync(lockPath, String(process.pid)) // 活锁（本进程，旧格式内容）
      // 子进程 80ms 后删锁：父进程阻塞在锁等待循环里，由子进程触发释放
      const child = spawn(process.execPath, ['-e', `setTimeout(() => require('node:fs').unlinkSync(${JSON.stringify(lockPath)}), 80)`], { stdio: 'ignore' })
      const release = acquireGateLock(lockPath, { timeoutMs: 5000, pollMs: 10 })
      child.unref()
      release()
      expect(existsSync(lockPath)).toBe(false)
    })
  })
})

describe('gate 5 test-suite：快速守卫测试族（SUITES 单一登记的执行面）', () => {
  it('buildSuiteSteps：devGate 族展开为 needs + args（命令与 SUITES.cmd 一致）', async () => {
    const m = await import('../quality-gates.mjs')
    const steps = m.buildSuiteSteps()
    expect(steps.map((s) => s.name)).toEqual([
      'test-suite:taste-lint',
      'test-suite:resources-plugins',
      'test-suite:builtin-ext-bundle',
      'test-suite:scripts-guards',
    ])
    const bundle = steps.find((s) => s.name === 'test-suite:builtin-ext-bundle')
    expect(bundle.needs).toEqual([['bash', 'scripts/prepare-builtin-extensions.sh']])
    expect(bundle.args[0]).toBe('pnpm')
    expect(bundle.args).toContain('scripts/__tests__/builtin-ext-bundle.test.mjs')
  })

  it('全部命令 exit 0 → 每族 PASS，needs 先于本体执行', async () => {
    const m = await import('../quality-gates.mjs')
    const calls = []
    const deps = {
      exec: (cmd, args) => {
        calls.push([cmd, ...args].join(' '))
        return { status: 0, stdout: '', stderr: '' }
      },
    }
    const gates = []
    m.runTestSuiteGate(deps, gates)
    expect(gates.every((g) => g.status === 'PASS')).toBe(true)
    expect(gates).toHaveLength(4)
    // builtin-ext-bundle：prepare 前置先跑，vitest 本体后跑
    const prepIdx = calls.findIndex((c) => c.includes('prepare-builtin-extensions.sh'))
    const vitIdx = calls.findIndex((c) => c.includes('builtin-ext-bundle.test.mjs'))
    expect(prepIdx).toBeGreaterThanOrEqual(0)
    expect(vitIdx).toBeGreaterThan(prepIdx)
  })

  it('前置失败 → 该族 FAIL 且不跑本体；本体失败 → FAIL 带 detail', async () => {
    const m = await import('../quality-gates.mjs')
    const deps = {
      exec: (cmd, args) => {
        const joined = [cmd, ...args].join(' ')
        if (joined.includes('prepare-builtin-extensions.sh')) return { status: 1, stdout: '', stderr: 'staged 残留' }
        if (joined.includes('test:taste-lint')) return { status: 1, stdout: '', stderr: 'rule case failed' }
        return { status: 0, stdout: '', stderr: '' }
      },
    }
    const gates = []
    m.runTestSuiteGate(deps, gates)
    const byName = Object.fromEntries(gates.map((g) => [g.name, g]))
    expect(byName['test-suite:builtin-ext-bundle'].status).toBe('FAIL')
    expect(byName['test-suite:builtin-ext-bundle'].detail).toContain('prepare-builtin-extensions.sh')
    expect(byName['test-suite:taste-lint'].status).toBe('FAIL')
    expect(byName['test-suite:taste-lint'].detail).toContain('rule case failed')
    expect(byName['test-suite:scripts-guards'].status).toBe('PASS')
  })

  it('spawn 失败（status null + error）→ FAIL 且 detail 含命令名与恢复动作（非哑 FAIL，同 typecheck 门实发形态）', async () => {
    const m = await import('../quality-gates.mjs')
    const deps = {
      exec: (cmd) => (cmd === 'pnpm' ? { status: null, stdout: '', stderr: '', error: new Error('spawn pnpm ENOENT') } : { status: 0, stdout: '', stderr: '' }),
    }
    const gates = []
    m.runTestSuiteGate(deps, gates)
    const tl = gates.find((g) => g.name === 'test-suite:taste-lint')
    expect(tl.status).toBe('FAIL')
    expect(tl.detail).toContain('pnpm')
    expect(tl.detail).toContain('PATH')
    expect(tl.detail).toContain('spawn pnpm ENOENT')
  })
})
