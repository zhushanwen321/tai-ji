/**
 * plugin-esm-loader.cjs 测试（拆分层，判据与处置通道见 docs/TEST-STRATEGY.md「新写测试判据」节）。
 *
 * 默认组（本文件主体）= loader 本体的 in-process 单测：用 node:vm 装载 loader 源码、
 * 把 self-register 的 `register` 打成桩（不在 vitest 进程注册 ESM hook——原 TC7 注释
 * 登记的污染约束），随后对 initialize / resolve hook 的拦截决策逐条断言。被测逻辑 =
 * 黑名单 / 路径边界 / scheme 封堵 / 非插件代码放行，全是纯决策函数；nextResolve 是
 * Node 原生 resolver 的替身（隔离外部依赖，决策本身不被 mock）。
 *
 * 门控组（文件尾部，TAIJI_TEST_INTEGRATION）= 真实 fork + --import 注入 + 真实 ESM
 * import 的端到端冒烟一条：Node 真调 hook、PERMISSION_DENIED 真冒泡成 import 失败。
 * 这属「代码 + OS 组合行为」，没有完成信号可等，本地默认跳过、CI 或按改动范围触发。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/plugin-service/__tests__/plugin-esm-loader.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fork, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { INTEGRATION_TESTS_ENABLED, INTEGRATION_TESTS_SKIP_REASON } from '../../../../../../test-guard/integration-gate.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LOADER_PATH = join(__dirname, '..', 'plugin-esm-loader.cjs')
const FIXTURE_PATH = join(__dirname, 'fixtures', 'esm-loader-fixture.cjs')

/** 门控组真 fork 冒烟的内部超时（fork + --import + 真实 import 链的 CI 负载余量）。 */
const TIMEOUT_MS = 15_000

const nodeRequire = createRequire(import.meta.url)
/** 黑名单 SSOT（loader 与 plugin-sandbox.ts 共消费同一份，此处经真实 require 读取）。 */
const BLOCKED_BUILTINS = (
  nodeRequire(join(__dirname, '..', 'plugin-blocked-builtins.cjs')) as { BLOCKED_BUILTINS: string[] }
).BLOCKED_BUILTINS

// ── in-process 装载 loader 本体 ────────────────────────────────────

type LoaderNextResolve = (
  specifier: string,
  context: { parentURL?: string },
) => Promise<{ url: string }>

interface LoaderHooks { // oe-exempt:20261024:framework:测试内契约类型——单实现常态
  initialize(): void
  resolve(
    specifier: string,
    context: { parentURL?: string },
    nextResolve: LoaderNextResolve,
  ): Promise<{ url: string }>
}

/** CJS 模块工厂签名（vm.compileFunction 的返回值按调用形状定型，避免落到 Function/any）。 */
type CjsModuleFactory = (
  module: { exports: unknown },
  exports: unknown,
  require: (id: string) => unknown,
  filename: string,
  dirname: string,
) => void

/**
 * 装载 loader 源码并返回其 hooks（initialize / resolve）。
 *
 * node:vm + 桩 require：`register` 打成 no-op——直接 require 本模块会在 vitest 进程
 * 注册 ESM hook（self-register 污染 vitest 的 ESM loader）；其余 require
 * （node:url / node:path / node:fs / 黑名单 SSOT / fs-guard）走真实实现，loader 源码
 * 零改动执行（provider-plugin-access D3：fs-guard 为能力放行与只读代理的真实现，
 * 同目录真实文件，无副作用直至 configure）。
 */
function loadLoaderHooks(): LoaderHooks {
  const src = readFileSync(LOADER_PATH, 'utf-8')
  const stubRequire = (id: string): unknown => {
    switch (id) {
      case 'node:module':
        return { register: () => ({}) }
      case 'node:url':
        return { pathToFileURL, fileURLToPath }
      case 'node:path':
        return nodeRequire('node:path')
      case 'node:fs':
        return { realpathSync }
      case './plugin-blocked-builtins.cjs':
        // 基线 + computeBlockedBuiltins 都来自真实 .cjs（D3 后 loader initialize 依赖
        // 放行计算函数；黑名单数据语义 = 真实基线，与本文件顶部真实 require 读取一致）
        return nodeRequire(join(__dirname, '..', 'plugin-blocked-builtins.cjs'))
      case './plugin-fs-guard.cjs':
        return nodeRequire(join(__dirname, '..', 'plugin-fs-guard.cjs'))
      default:
        throw new Error(`plugin-esm-loader.cjs 出现未预期的 require('${id}')（依赖面变化须同步本桩）`)
    }
  }
  const moduleObj: { exports: unknown } = { exports: undefined }
  const factory = vm.compileFunction(
    src,
    ['module', 'exports', 'require', '__filename', '__dirname'],
    { filename: LOADER_PATH },
  ) as unknown as CjsModuleFactory
  factory(moduleObj, moduleObj.exports, stubRequire, LOADER_PATH, dirname(LOADER_PATH))
  const hooks = moduleObj.exports as { initialize?: unknown; resolve?: unknown }
  if (typeof hooks.initialize !== 'function' || typeof hooks.resolve !== 'function') {
    throw new Error('plugin-esm-loader.cjs 未导出 initialize/resolve hooks（先赋值后 self-register 契约被破坏）')
  }
  return moduleObj.exports as unknown as LoaderHooks
}

interface RejectedError {
  code?: string
  message: string
}

/** 捕获 resolve 的拒绝原因（带 code 字段的 Error）；未拒绝即失败。 */
async function rejectReason(run: () => Promise<unknown>): Promise<RejectedError> {
  try {
    await run()
  } catch (e: unknown) {
    const err = e as { code?: unknown; message?: unknown }
    return {
      code: typeof err.code === 'string' ? err.code : undefined,
      message: String(err.message),
    }
  }
  throw new Error('expected resolve to reject, but it resolved')
}

describe('plugin-esm-loader 拦截逻辑（in-process：loader 本体）', () => {
  let pluginDir: string
  let loader: LoaderHooks
  let outsideUrl: string

  /** 插件目录内文件的 file URL（initialize 已把 sandboxDir 规范化到 realpath，两侧同源）。 */
  function insideUrl(name: string): string {
    return pathToFileURL(join(pluginDir, name)).href
  }

  /** Node 原生 resolver 替身：按预定 url 返回（被测物是 hook 决策，不是 Node 的解析）。 */
  function nextResolveTo(url: string): LoaderNextResolve {
    return async () => ({ url })
  }

  /** 计数型 resolver 替身（断言某分支是否真的走了 nextResolve）。 */
  function countingNextResolve(url: string): { next: LoaderNextResolve; calls: () => number } {
    let calls = 0
    return {
      next: async () => {
        calls++
        return { url }
      },
      calls: () => calls,
    }
  }

  beforeEach(() => {
    // realpath：macOS tmpdir 是 /var → /private/var symlink，initialize 内部会规范化，
    // 测试侧不同源则 isInsideSandbox 的 startsWith 恒失配
    pluginDir = realpathSync(mkdtempSync(join(tmpdir(), 'esm-loader-unit-')))
    outsideUrl = pathToFileURL(join(dirname(pluginDir), 'outside.mjs')).href
    loader = loadLoaderHooks()
    process.env.TAIJI_PLUGIN_SANDBOX_DIR = pluginDir
    loader.initialize()
  })

  afterEach(() => {
    delete process.env.TAIJI_PLUGIN_SANDBOX_DIR
    rmSync(pluginDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('initialize: env 缺失 → fail-closed throw（沙箱进程启动即失败，显式暴露 wiring 配置问题）', () => {
    delete process.env.TAIJI_PLUGIN_SANDBOX_DIR
    expect(() => loadLoaderHooks().initialize()).toThrow(/TAIJI_PLUGIN_SANDBOX_DIR/)
  })

  it('TC1: node: 前缀黑名单内置被拦截（逐条遍历 SSOT 黑名单 → PERMISSION_DENIED，且不触达 resolver）', async () => {
    for (const name of BLOCKED_BUILTINS) {
      const specifier = `node:${name}`
      const counter = countingNextResolve(specifier)
      const err = await rejectReason(() => loader.resolve(specifier, { parentURL: insideUrl('a.mjs') }, counter.next))
      expect(err.code, specifier).toBe('PERMISSION_DENIED')
      expect(err.message, specifier).toContain(`import('${specifier}') is blocked`)
      // 黑名单先于解析短路：被拦的 import 根本不应走到 Node resolver
      expect(counter.calls(), specifier).toBe(0)
    }
  })

  it('TC5: 裸内置名被拦截（无 node: 前缀，ESM 中 "fs" 等形态）', async () => {
    for (const name of ['fs', 'child_process', 'worker_threads', 'module']) {
      const err = await rejectReason(() => loader.resolve(name, { parentURL: insideUrl('a.mjs') }, nextResolveTo(name)))
      expect(err.code, name).toBe('PERMISSION_DENIED')
      expect(err.message, name).toContain(`import('${name}') is blocked`)
    }
  })

  it('TC2: 安全内置模块放行（node:path / node:util 过黑名单后按 node: scheme 解析结果放行）', async () => {
    for (const specifier of ['node:path', 'node:util']) {
      const result = await loader.resolve(specifier, { parentURL: insideUrl('a.mjs') }, nextResolveTo(specifier))
      expect(result.url).toBe(specifier)
    }
  })

  it('TC3: 相对路径出界被拦截（解析结果不在 pluginDir 内 → PERMISSION_DENIED）', async () => {
    const err = await rejectReason(() =>
      loader.resolve('../outside.mjs', { parentURL: insideUrl('a.mjs') }, nextResolveTo(outsideUrl)),
    )
    expect(err.code).toBe('PERMISSION_DENIED')
    expect(err.message).toContain("import('../outside.mjs') resolves outside plugin directory")
  })

  it('TC4: pluginDir 内相对 import 放行', async () => {
    const target = insideUrl('good.mjs')
    const result = await loader.resolve('./good.mjs', { parentURL: insideUrl('a.mjs') }, nextResolveTo(target))
    expect(result.url).toBe(target)
  })

  it('TC4b: pluginDir 内绝对路径 import 放行（路径类分支的绝对形态）', async () => {
    const target = insideUrl('abs.mjs')
    const result = await loader.resolve(join(pluginDir, 'abs.mjs'), { parentURL: insideUrl('a.mjs') }, nextResolveTo(target))
    expect(result.url).toBe(target)
  })

  it('TC9: 非 file:// 非 npm 裸名的 scheme 一律拦截（data: / blob: / http: 逃逸向量，MF-1）', async () => {
    const specifiers = [
      'data:text/javascript,export const x=1',
      'blob:https://example.com/uuid',
      'http://evil.example.com/mod.mjs',
    ]
    for (const specifier of specifiers) {
      const err = await rejectReason(() => loader.resolve(specifier, { parentURL: insideUrl('a.mjs') }, nextResolveTo(specifier)))
      expect(err.code, specifier).toBe('PERMISSION_DENIED')
      expect(err.message, specifier).toContain('blocked scheme')
    }
  })

  it('S1-W3: 裸 npm 名解析出界被拦截（node_modules 向上遍历命中沙箱外副本）', async () => {
    const err = await rejectReason(() =>
      loader.resolve('evil-dep', { parentURL: insideUrl('a.mjs') }, nextResolveTo(outsideUrl)),
    )
    expect(err.code).toBe('PERMISSION_DENIED')
    expect(err.message).toContain('resolves outside plugin directory')
  })

  it('S1-W3 正例: 裸 npm 名解析落在 pluginDir 内放行', async () => {
    const target = insideUrl('node_modules/dep/index.js')
    const result = await loader.resolve('dep', { parentURL: insideUrl('a.mjs') }, nextResolveTo(target))
    expect(result.url).toBe(target)
  })

  it('非插件代码一律放行（parentURL 在沙箱外：bootstrap / loader 自身不经拦截）', async () => {
    const counter = countingNextResolve('node:fs')
    const result = await loader.resolve('node:fs', { parentURL: outsideUrl }, counter.next)
    expect(result.url).toBe('node:fs')
    expect(counter.calls()).toBe(1)
  })
})

describe('plugin-esm-loader 源文件结构（打包验证的源层检查）', () => {
  it('TC7: hooks 导出 + self-register + realpath 规范化', () => {
    // 对应 TC7（打包验证的源文件层检查）：hooks 先赋值后 self-register 是
    // resolve 生效的前提，realpath 规范化修复 macOS /var→/private/var 失配。
    // 不 require 该模块（self-register 会污染 vitest 的 ESM loader），读源断言。
    // provider-plugin-access D3：导出面含 load hook（fs 只读代理 sentinel 短路）。
    const src = readFileSync(LOADER_PATH, 'utf-8')
    expect(src).toContain('module.exports = { initialize, resolve, load }')
    expect(src).toContain('register(pathToFileURL(__filename).href)')
    expect(src).toContain('realpathSync')
  })
})

// ── 门控组：真实 fork + --import + 真实 ESM import 的端到端冒烟 ──────
// 「代码 + OS 组合行为」（Node 真调 hook、错误真冒泡成 import 失败）无完成信号可等，
// 本地默认跳过；拦截决策本身已由上方 in-process 组逐条覆盖。

interface ImportResult {
  label: string
  ok: boolean
  error?: string
}

/** 收集 fork 子进程的 results 消息（含超时保护） */
function collectResults(child: ChildProcess): Promise<ImportResult[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('fixture did not respond in time'))
    }, TIMEOUT_MS)
    child.on('message', (msg: unknown) => {
      const m = msg as { type?: string; results?: ImportResult[] }
      if (m?.type === 'results') {
        clearTimeout(timer)
        resolve(m.results ?? [])
      }
    })
    child.on('exit', (code: number | null) => {
      if (code !== 0) {
        clearTimeout(timer)
        reject(new Error(`fixture exited with code ${code}`))
      }
    })
    child.on('error', (err: Error) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

function spawnFixture(env: Record<string, string | undefined>): ChildProcess {
  return fork(FIXTURE_PATH, [], {
    execArgv: ['--import', LOADER_PATH],
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
}

async function runImports(
  env: Record<string, string | undefined>,
  items: Array<{ label: string; url: string }>,
): Promise<ImportResult[]> {
  const child = spawnFixture(env)
  const resultsPromise = collectResults(child)
  child.send({ type: 'run', items })
  return resultsPromise
}

describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
  `plugin-esm-loader 端到端冒烟（真实 fork + --import + 真实 ESM import）${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ''}`,
  () => {
    let pluginDir = ''

    afterEach(() => {
      if (pluginDir) rmSync(pluginDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('TC1-e2e: 真实 ESM import node:fs 被 loader 拦截（PERMISSION_DENIED 冒泡为 import 失败）', async () => {
      pluginDir = mkdtempSync(join(tmpdir(), 'esm-loader-plugin-'))
      // 插件测试文件（pluginDir 内）：内部 import 触发 loader 拦截
      writeFileSync(join(pluginDir, 'bad-builtin.mjs'), "import 'node:fs'\n")
      const results = await runImports({ TAIJI_PLUGIN_SANDBOX_DIR: pluginDir }, [
        { label: 'bad-builtin', url: pathToFileURL(join(pluginDir, 'bad-builtin.mjs')).href },
      ])
      expect(results[0].ok).toBe(false)
      expect(results[0].error).toContain('PERMISSION_DENIED')
    }, TIMEOUT_MS)
  },
)
