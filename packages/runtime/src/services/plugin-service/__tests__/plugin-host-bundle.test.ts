import { INTEGRATION_TESTS_ENABLED, INTEGRATION_TESTS_SKIP_REASON } from '../../../../../../test-guard/integration-gate.ts';
import { PendingTracker } from '../../../utils/async/pending-tracker.js';
import type { CommandRegistration } from '../api/commands-api.js';
import { executeCommand } from '../api/commands-executor.js';
import { HOOK_ANOMALY_WARN_EVERY, HookPipeline } from '../hook-pipeline.js';
import { buildPluginCapabilityForkEnv } from '../plugin-fs-guard.js';
import { buildPluginHostChildEnv } from '../plugin-host-process.js';
import type { PluginHost } from '../plugin-host.js';
import type { PluginRpcServer } from '../plugin-rpc-server.js';
import { PluginService } from '../plugin-service.js';
import type { ToolEntry, HookEntry, HookContext, HookType, PluginDescriptor } from '../plugin-types.js';
import { WORKER_STDERR_MAX_BYTES, createWorkerStderrCollector } from '../worker-stderr-collector.js';
import { PluginCapabilityConstants, resolveAllowedModules } from '@taiji/shared/plugin-capability-map';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/services/plugin-service/__tests__/plugin-esm-loader.test.ts
// ======================================================================

import type { CommandExecutorDeps } from '../api/commands-executor.js';
import type { HookPipelineDeps } from '../hook-pipeline.js';
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

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-esm-loader', () => {
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
});

// ======================================================================
// ← src/services/plugin-service/__tests__/plugin-host-process.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-host-process', () => {
// ════════════════ 来源: build-plugin-host-child-env.test.ts ════════════════
describe('build-plugin-host-child-env', () => {
  /**
   * buildPluginHostChildEnv 出站接线单测（U4-B6，docs/architecture/env-propagation-boundary.md §5-U4/D6）。
   *
   * 覆盖验收断言点：{...process.env} 全量拷贝拓扑不动——除 deny 两键与既有
   * ELECTRON_RUN_AS_NODE=1 注入外，输出键集合与输入完全一致（含非白名单任意键）；
   * 不 mutate 输入对象（R1）。纯函数 DI 注入污染记录，不读写真实 process.env（R3）。
   *
   * 运行：cd packages/runtime && npx vitest run src/services/plugin-service/__tests__/build-plugin-host-child-env.test.ts
   */

  /** 混合形态父 env：正常键 + 非白名单任意键 + deny 两键 + undefined 值。 */
  function createPollutedParentEnv(): NodeJS.ProcessEnv {
    return {
      PATH: '/usr/bin:/bin',
      HOME: '/Users/tester',
      // trusted/sandbox 插件兼容性依赖全量拷贝：非白名单键也必须跟随（D6）
      SOME_PLUGIN_CUSTOM_VAR: 'keep-me',
      TAIJI_AGENT_PACKAGED: '1',
      TAIJI_RUNTIME_TOKEN: 'secret-token',
      EMPTY_VALUED: '',
    }
  }

  describe('buildPluginHostChildEnv（U4/D6 只做增量叠加）', () => {
    it('拷贝拓扑不变：除 deny 两键外键集合一致；ELECTRON_RUN_AS_NODE=1 注入', () => {
      const parent = createPollutedParentEnv()
      const out = buildPluginHostChildEnv(parent)

      expect(out.TAIJI_AGENT_PACKAGED).toBeUndefined()
      expect(out.TAIJI_RUNTIME_TOKEN).toBeUndefined()
      // 拷贝拓扑断言：输出 = 输入 − deny 两键 + ELECTRON_RUN_AS_NODE
      const expectedKeys = new Set([
        ...Object.keys(parent).filter((k) => k !== 'TAIJI_AGENT_PACKAGED' && k !== 'TAIJI_RUNTIME_TOKEN'),
        'ELECTRON_RUN_AS_NODE',
      ])
      expect(new Set(Object.keys(out))).toEqual(expectedKeys)

      expect(out.ELECTRON_RUN_AS_NODE).toBe('1')
      expect(out.SOME_PLUGIN_CUSTOM_VAR).toBe('keep-me')
      expect(out.EMPTY_VALUED).toBe('')
    })

    it('deny 键剔除 + 沙箱变量可后续注入（caller 现行赋值路径不被阻断）', () => {
      const out = buildPluginHostChildEnv(createPollutedParentEnv())
      // caller 在返回值上继续赋值 sandbox 目录（createProcess 现行代码形状），类型上必须可行
      out.TAIJI_PLUGIN_SANDBOX_DIR = '/plugins/foo'
      expect(out.TAIJI_PLUGIN_SANDBOX_DIR).toBe('/plugins/foo')
    })

    it('不 mutate 父 env 对象（R1：副本上删，绝不改写输入）', () => {
      const parent = createPollutedParentEnv()
      const snapshot = { ...parent }

      buildPluginHostChildEnv(parent)

      expect(parent).toEqual(snapshot)
    })
  })
});
// ════════════════ 来源: plugin-esm-loader.test.ts ════════════════
describe('plugin-esm-loader', () => {
  /**
   * plugin-esm-loader 能力放行测试（provider-plugin-access D3 / P-perm，任务书 u-capability）。
   *
   * 分层（对齐 src/services/plugin-service/__tests__/plugin-esm-loader.test.ts 的拆分纪律）：
   * - 默认组（本文件主体）= in-process：vm 装载 loader 真源断言放行决策（黑名单过滤 /
   *   fs sentinel 改写 / 永久封禁免疫 / env 解码 fail-closed）；直测 plugin-fs-guard.cjs
   *   的只读导出子集代理与 readPaths 路径检查（含符号链接绕过）；宿主侧 fork env 编码
   *   （buildPluginCapabilityForkEnv / buildPluginHostChildEnv）。
   * - 门控组（TAIJI_TEST_INTEGRATION）= 真实 fork + 真实 loader + 真实 fs 的 P-perm 四
   *   fixture 实测：声明内读成功 / 声明外读拒（含符号链接）/ os.homedir 免声明可用 /
   *   五类写操作变体全拒。断言本质 = loader hook + fs 代理在真实子进程链路下的组合行为，
   *   无进程内完成信号可等，本地默认跳过（e2e-map 规则按 on-diff 触发）。
   *
   * fixture 源文件在 test/plugin-perm-fixtures/（模板），测试复制到 mkdtemp 的 pluginDir
   * 内执行——parentURL 必须在 sandbox 内才触发 loader 拦截；写删目标全部 mkdtempSync 自建自删，
   * 不触碰真实数据目录（HOME 注入 tmp 假家目录，readPaths 家目录相对语义同步被测）。
   *
   * 运行：cd packages/runtime && npx vitest run test/plugin-esm-loader.test.ts
   */

  const __dirname = dirname(fileURLToPath(import.meta.url))
  const LOADER_PATH = join(__dirname, '../plugin-esm-loader.cjs')
  const GUARD_PATH = join(__dirname, '../plugin-fs-guard.cjs')
  const PERM_FIXTURES_DIR = join(__dirname, '../../../../test/plugin-perm-fixtures')
  const TIMEOUT_MS = 15_000

  const nodeRequire = createRequire(import.meta.url)
  const fsGuard = nodeRequire(GUARD_PATH) as {
    ENV_ALLOWED_MODULES_KEY: string
    ENV_READ_PATHS_KEY: string
    configure(options: { readPaths?: unknown }): void
    inlineReadBases(): string[]
    proxyExportNames(target: string): string[]
    buildProxyModuleSource(target: string): string
    buildProxyObject(target: string, realFs: typeof import('node:fs')): Record<string, unknown>
    parseStringArrayEnv(raw: unknown): string[]
  }

  /** network.http 的放行模块集（D3 表；词表漂移由 sandbox-escape SSOT 对账断言抓住） */
  const NETWORK_HTTP_MODULES = ['http', 'https', 'net', 'dns', 'tls']
  const FS_READ_MODULES = ['fs', 'fs/promises']

  // ── in-process：装载 loader 本体（vm + 桩 require，register 打桩防 ESM hook 污染）──

  type LoaderNextResolve = (
    specifier: string,
    context: { parentURL?: string },
  ) => Promise<{ url: string }>

  interface LoaderLoadResult { // oe-exempt:20261024:framework:测试内契约类型——loader 行为探针单实现常态
    format?: string
    source?: string
    shortCircuit?: boolean
    url?: string
  }

  interface LoaderHooks { // oe-exempt:20261024:framework:测试内契约类型——loader 行为探针单实现常态
    initialize(): void
    resolve(
      specifier: string,
      context: { parentURL?: string },
      nextResolve: LoaderNextResolve,
    ): Promise<{ url: string; shortCircuit?: boolean }>
    load(url: string, context: Record<string, unknown>, nextLoad: () => Promise<LoaderLoadResult>): Promise<LoaderLoadResult>
  }

  type CjsModuleFactory = (
    module: { exports: unknown },
    exports: unknown,
    require: (id: string) => unknown,
    filename: string,
    dirname: string,
  ) => void

  /**
   * 装载 loader 源码并返回其 hooks（initialize / resolve / load）。
   * register 打成 no-op（不在 vitest 进程注册 ESM hook）；blocked-builtins 与
   * fs-guard 走同目录真实 require（被测物包含它们的真实数据/行为）。
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
          return nodeRequire(join(__dirname, '../plugin-blocked-builtins.cjs'))
        case './plugin-fs-guard.cjs':
          return fsGuard
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
    const hooks = moduleObj.exports as Record<string, unknown>
    if (
      typeof hooks.initialize !== 'function' ||
      typeof hooks.resolve !== 'function' ||
      typeof hooks.load !== 'function'
    ) {
      throw new Error('plugin-esm-loader.cjs 未导出 initialize/resolve/load hooks（先赋值后 self-register 契约被破坏）')
    }
    return moduleObj.exports as unknown as LoaderHooks
  }

  async function rejectReason(run: () => Promise<unknown>): Promise<{ code?: string; message: string }> {
    try {
      await run()
    } catch (e: unknown) {
      const err = e as { code?: unknown; message?: unknown }
      return { code: typeof err.code === 'string' ? err.code : undefined, message: String(err.message) }
    }
    throw new Error('expected resolve to reject, but it resolved')
  }

  describe('plugin-esm-loader 能力放行决策（in-process：loader 本体，D3）', () => {
    let pluginDir = ''
    let loader: LoaderHooks

    const insideUrl = (name: string): string => pathToFileURL(join(pluginDir, name)).href
    const nextResolveTo = (url: string): LoaderNextResolve => async () => ({ url })
    const countingNextResolve = (url: string): { next: LoaderNextResolve; calls: () => number } => {
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
      pluginDir = realpathSync(mkdtempSync(join(tmpdir(), 'esm-loader-perm-')))
      loader = loadLoaderHooks()
      process.env.TAIJI_PLUGIN_SANDBOX_DIR = pluginDir
    })

    afterEach(() => {
      delete process.env.TAIJI_PLUGIN_SANDBOX_DIR
      delete process.env.TAIJI_PLUGIN_ALLOWED_MODULES
      delete process.env.TAIJI_PLUGIN_READ_PATHS
      rmSync(pluginDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    function initializeWith(allowed: string[], readPaths: string[] = []): void {
      process.env.TAIJI_PLUGIN_ALLOWED_MODULES = JSON.stringify(allowed)
      process.env.TAIJI_PLUGIN_READ_PATHS = JSON.stringify(readPaths)
      loader.initialize()
    }

    it('CAP1: 无放行清单（env 缺省）= 基线全拦——fs 与 http 都拒，向后兼容 fail-closed', async () => {
      loader.initialize()
      for (const specifier of ['node:fs', 'node:http', 'node:child_process']) {
        const err = await rejectReason(() => loader.resolve(specifier, { parentURL: insideUrl('a.mjs') }, nextResolveTo(specifier)))
        expect(err.code, specifier).toBe('PERMISSION_DENIED')
        expect(err.message, specifier).toContain(`import('${specifier}') is blocked`)
      }
    })

    it('CAP2: 放行 network.http 集——https 放行、node:vm 仍拒（永久封禁）、fs 未声明仍拒', async () => {
      initializeWith(NETWORK_HTTP_MODULES)
      const httpsResult = await loader.resolve('node:https', { parentURL: insideUrl('a.mjs') }, nextResolveTo('node:https'))
      expect(httpsResult.url).toBe('node:https')

      // 新增断言（设计 §4）：放行 network.http 后 import node:vm 仍被拒
      const counter = countingNextResolve('node:vm')
      const vmErr = await rejectReason(() => loader.resolve('node:vm', { parentURL: insideUrl('a.mjs') }, counter.next))
      expect(vmErr.code).toBe('PERMISSION_DENIED')
      expect(vmErr.message).toContain("import('node:vm') is blocked")
      // 黑名单先于解析短路
      expect(counter.calls()).toBe(0)

      const fsErr = await rejectReason(() => loader.resolve('node:fs', { parentURL: insideUrl('a.mjs') }, nextResolveTo('node:fs')))
      expect(fsErr.code).toBe('PERMISSION_DENIED')
    })

    it('CAP3: 放行 fs 系——resolve 改写为只读代理 sentinel（shortCircuit），promises 同面', async () => {
      initializeWith([...FS_READ_MODULES])
      for (const name of FS_READ_MODULES) {
        const result = await loader.resolve(name, { parentURL: insideUrl('a.mjs') }, nextResolveTo(name))
        expect(result.url, name).toBe(`taiji-readonly-fs:${name}`)
        expect(result.shortCircuit, name).toBe(true)
        // node: 前缀形态同面
        const prefixed = await loader.resolve(`node:${name}`, { parentURL: insideUrl('a.mjs') }, nextResolveTo(`node:${name}`))
        expect(prefixed.url, `node:${name}`).toBe(`taiji-readonly-fs:${name}`)
      }
    })

    it('CAP4: allowed 注入永久封禁名（vm）不生效——computeBlockedBuiltins 免疫在 loader 面成立', async () => {
      initializeWith(['vm', ...NETWORK_HTTP_MODULES])
      const vmErr = await rejectReason(() => loader.resolve('node:vm', { parentURL: insideUrl('a.mjs') }, nextResolveTo('node:vm')))
      expect(vmErr.code).toBe('PERMISSION_DENIED')
      // 同一 env 下 https 照常放行（免疫只针对封禁项，不误伤）
      const httpsResult = await loader.resolve('node:https', { parentURL: insideUrl('a.mjs') }, nextResolveTo('node:https'))
      expect(httpsResult.url).toBe('node:https')
    })

    it('CAP5: env 非法 JSON → 空放行（基线全拦，解码 fail-closed）', async () => {
      process.env.TAIJI_PLUGIN_SANDBOX_DIR = pluginDir
      process.env.TAIJI_PLUGIN_ALLOWED_MODULES = 'not-json{{'
      loader.initialize()
      const err = await rejectReason(() => loader.resolve('node:http', { parentURL: insideUrl('a.mjs') }, nextResolveTo('node:http')))
      expect(err.code).toBe('PERMISSION_DENIED')
    })

    it('CAP6: os 免声明可用（D3 移出基线）——无任何放行声明时 node:os 放行', async () => {
      loader.initialize()
      const result = await loader.resolve('node:os', { parentURL: insideUrl('a.mjs') }, nextResolveTo('node:os'))
      expect(result.url).toBe('node:os')
    })

    it('CAP7: load hook 对 sentinel 短路返回 ESM 代理模块源码；非 sentinel 透传', async () => {
      initializeWith([...FS_READ_MODULES])
      const noNext = (): Promise<LoaderLoadResult> => Promise.reject(new Error('should short-circuit before nextLoad'))

      const fsLoad = await loader.load('taiji-readonly-fs:fs', {}, noNext)
      expect(fsLoad.format).toBe('module')
      expect(fsLoad.shortCircuit).toBe(true)
      const fsSource = fsLoad.source ?? ''
      // 源码内 import 原生 fs 的 parentURL 是 sentinel URL（非 file://）→ loader 放行
      // → 原生 fs 经 ESM 通道到手（CJS _resolveFilename patch 不覆盖 ESM import）
      expect(fsSource).toContain("import realFs from 'node:fs'")
      // readPaths 白名单内联 + named export 显式声明
      expect(fsSource).toContain('const READ_BASES = ')
      expect(fsSource).toContain('export const readFile = m["readFile"]')
      // fs 面内嵌 promises 命名空间段
      expect(fsSource).toContain('m.promises = pm')

      const fspLoad = await loader.load('taiji-readonly-fs:fs/promises', {}, noNext)
      expect(fspLoad.format).toBe('module')
      expect(fspLoad.source).toContain('export const readFile = m["readFile"]')

      // 非 sentinel URL 透传 nextLoad（非插件代码的 node:fs 不经代理）
      let passthrough = false
      await loader.load('node:fs', {}, async () => {
        passthrough = true
        return { format: 'builtin' }
      })
      expect(passthrough).toBe(true)
    })
  })

  describe('plugin-fs-guard readPaths 归一与代理源码模板（in-process：.cjs 真源，D3）', () => {
    // 路径检查的归一在 hooks 线程执行（configure/inlineReadBases），代理行为在主线程
    // 执行的模板源码内——Node hooks 线程隔离（globalThis/process 传递失效，2026-10-24
    // 探针）决定了 in-process 只能断言归一产物与模板结构；代理行为面由门控组的真
    // fork P-perm fixture 覆盖。
    let homeDir = ''
    let prevHome = ''

    beforeEach(() => {
      // configure 经 os.homedir() 动态推导家目录——临时替换 HOME（测试文件级 worker 隔离，
      // 用例内同步恢复），readPaths 家目录相对语义同步被测
      homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'fs-guard-home-')))
      prevHome = process.env.HOME ?? ''
      process.env.HOME = homeDir
      mkdirSync(join(homeDir, 'data'), { recursive: true })
      writeFileSync(join(homeDir, 'data', 'in.txt'), 'inside-content')
      writeFileSync(join(homeDir, 'data', 'out.txt'), 'outside-content')
      symlinkSync(join(homeDir, 'data', 'out.txt'), join(homeDir, 'data', 'link.txt'))
    })

    afterEach(() => {
      process.env.HOME = prevHome
      rmSync(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('G1: configure 归一——存在路径 realpath；不存在路径祖先 fallback；readPath symlink 解析到目标 real', () => {
      fsGuard.configure({ readPaths: ['data/in.txt', 'data/missing-dir/late.txt', 'data/link.txt'] })
      const bases = fsGuard.inlineReadBases()
      // 存在路径：realpath 归一（macOS tmp symlink 已由 homeDir realpath 消除）
      expect(bases).toContain(join(homeDir, 'data', 'in.txt'))
      // 不存在路径：最近存在祖先（data）realpath + 余下段承接
      expect(bases).toContain(join(homeDir, 'data', 'missing-dir', 'late.txt'))
      // readPath 自身是 symlink：解析到目标真实位置（声明授权 = 其解析目标）
      expect(bases).toContain(join(homeDir, 'data', 'out.txt'))
      expect(bases).toHaveLength(3)
    })

    it('G2: 代理源码模板（fs 面）——import 原生 fs、白名单内联、named export 与名单逐键一致', () => {
      fsGuard.configure({ readPaths: ['data/in.txt'] })
      const source = fsGuard.buildProxyModuleSource('fs')
      // import 原生 fs（parentURL = sentinel URL → loader 放行 → ESM 通道到手）
      expect(source).toContain("import realFs from 'node:fs'")
      // 白名单以归一后的绝对路径字面量内联
      const inlineBases = JSON.parse(source.match(/const READ_BASES = (\[.*?\])/)?.[1] ?? '[]') as string[]
      expect(inlineBases).toEqual(fsGuard.inlineReadBases())
      // named export 与名单常量逐键一致（模板 export 行 ↔ proxyExportNames）
      const exportLines = [...source.matchAll(/^export const (\w+) = m\[/gm)].map((match) => match[1])
      expect(exportLines).toEqual(fsGuard.proxyExportNames('fs'))
      // fs 面内嵌 promises 命名空间段 + 写拒绝（显式 PERMISSION_DENIED 可诊断）
      expect(source).toContain('m.promises = pm')
      expect(source).toContain('is denied (readonly subset of fs.read-user-data)')
    })

    it('G3: 代理源码模板（fs/promises 面）——named export 与名单一致；FileHandle 写拒绝 Proxy 段', () => {
      fsGuard.configure({ readPaths: ['data/in.txt'] })
      const source = fsGuard.buildProxyModuleSource('fs/promises')
      const exportLines = [...source.matchAll(/^export const (\w+) = m\[/gm)].map((match) => match[1])
      expect(exportLines).toEqual(fsGuard.proxyExportNames('fs/promises'))
      expect(source).toContain('new Proxy(handle, {')
      expect(source).toContain('Sandbox: FileHandle.${prop} is denied')
      // promises 面不内嵌第二个 promises 段（自身即 promises 面）
      expect(source).not.toContain('m.promises = pm')
    })

    it('G4: parseStringArrayEnv——合法数组解码；非法 JSON / 非字符串数组 → 空（fail-closed）', () => {
      expect(fsGuard.parseStringArrayEnv('["a","b"]')).toEqual(['a', 'b'])
      expect(fsGuard.parseStringArrayEnv('not-json{{')).toEqual([])
      expect(fsGuard.parseStringArrayEnv('{"a":1}')).toEqual([])
      expect(fsGuard.parseStringArrayEnv(undefined)).toEqual([])
      expect(fsGuard.parseStringArrayEnv('')).toEqual([])
    })
  })

  describe('plugin-fs-guard buildProxyObject（in-process：CJS 只读代理对象，F1-24）', () => {
    // 与源码模板 describe 同款 HOME 注入：configure 经 os.homedir() 推导家目录，
    // buildProxyObject 的路径检查消费 inlineReadBases() 的 configure 后运行时状态
    //（initSandbox 同款约束：先 configure 再产出代理）。代理对象与被代理的真实 fs
    // 同进程（in-process 可直接行为断言，与「hooks 线程隔离只能断言模板结构」的
    // ESM 面不同——这里补上两份行为代码的正反例）。
    let homeDir = ''
    let prevHome = ''
    const realFs = nodeRequire('node:fs') as typeof import('node:fs')

    const denyCodeOf = (run: () => unknown): string => {
      try {
        run()
      } catch (e) {
        return (e as { code?: string }).code ?? 'NO_CODE'
      }
      return 'LEAKED'
    }

    beforeEach(() => {
      homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'fs-guard-proxy-home-')))
      prevHome = process.env.HOME ?? ''
      process.env.HOME = homeDir
      mkdirSync(join(homeDir, 'data'), { recursive: true })
      writeFileSync(join(homeDir, 'data', 'in.txt'), 'inside-content')
      writeFileSync(join(homeDir, 'data', 'out.txt'), 'outside-content')
    })

    afterEach(() => {
      process.env.HOME = prevHome
      rmSync(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('K1: 键集 === proxyExportNames(target)（fs 面 + 内嵌 promises 面逐键一致，防两份行为代码名单漂移）', () => {
      fsGuard.configure({ readPaths: [] })
      const proxy = fsGuard.buildProxyObject('fs', realFs)
      expect(Object.keys(proxy).sort()).toEqual([...fsGuard.proxyExportNames('fs')].sort())
      // fs 面内嵌 promises 命名空间键集 = fs/promises 面名单
      const promisesFace = proxy.promises as Record<string, unknown>
      expect(Object.keys(promisesFace).sort()).toEqual([...fsGuard.proxyExportNames('fs/promises')].sort())

      const promisesDirect = fsGuard.buildProxyObject('fs/promises', realFs)
      expect(Object.keys(promisesDirect).sort()).toEqual([...fsGuard.proxyExportNames('fs/promises')].sort())
    })

    it('K2: 读正反例——白名单内 readFileSync 成功；白名单外 PERMISSION_DENIED；写改 API 拒', () => {
      fsGuard.configure({ readPaths: ['data/in.txt'] })
      // 键集已由 K1 锁定 === proxyExportNames('fs')（即原生 fs 只读子集面），行为断言
      // 按原生 fs 签名收窄类型
      const proxy = fsGuard.buildProxyObject('fs', realFs) as typeof realFs
      const inside = join(homeDir, 'data', 'in.txt')
      const outside = join(homeDir, 'data', 'out.txt')

      expect(proxy.readFileSync(inside, 'utf-8')).toBe('inside-content')
      expect(denyCodeOf(() => proxy.readFileSync(outside, 'utf-8'))).toBe('PERMISSION_DENIED')
      expect(denyCodeOf(() => proxy.writeFileSync(inside, 'x'))).toBe('PERMISSION_DENIED')

      // constants / Stats 透传原生引用（instanceof 语义 = 同一构造器）
      expect(proxy.constants).toBe(realFs.constants)
      expect(proxy.Stats).toBe(realFs.Stats)
    })

    it('K3: open 只放读 flags——写 flags 拒；读 flags 打开后 fd 族读 API 可用', () => {
      fsGuard.configure({ readPaths: ['data/in.txt'] })
      const proxy = fsGuard.buildProxyObject('fs', realFs) as typeof realFs
      const inside = join(homeDir, 'data', 'in.txt')

      expect(denyCodeOf(() => proxy.openSync(inside, 'w'))).toBe('PERMISSION_DENIED')
      expect(denyCodeOf(() => proxy.openSync(inside, realFs.constants.O_WRONLY))).toBe('PERMISSION_DENIED')

      const fd = proxy.openSync(inside, 'r')
      const buf = Buffer.alloc('inside-content'.length)
      const bytes = proxy.readSync(fd, buf, 0, buf.length, 0)
      proxy.closeSync(fd)
      expect(bytes).toBe(buf.length)
      expect(buf.toString('utf-8')).toBe('inside-content')
    })

    it('K4: promises 面——白名单内 readFile 成功；writeFile 拒；FileHandle 写方法拒（读 flags 打开后）', async () => {
      fsGuard.configure({ readPaths: ['data/in.txt'] })
      const proxy = fsGuard.buildProxyObject('fs', realFs)
      const promisesFace = proxy.promises as Record<string, (...args: unknown[]) => Promise<unknown>>
      const inside = join(homeDir, 'data', 'in.txt')

      await expect(promisesFace.readFile(inside, 'utf-8')).resolves.toBe('inside-content')
      await expect(promisesFace.writeFile(inside, 'x')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })

      const handle = (await promisesFace.open(inside, 'r')) as import('node:fs').promises.FileHandle
      await expect(handle.write('x')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
      // 纵深名单：createWriteStream 只读 fd 上原生仅 EBADF，代理须显式拒绝（可诊断）
      await expect(handle.createWriteStream()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
      await handle.close()
    })

    it('K5: fs/promises 直出面与 fs.promises 内嵌面同语义（读成 / 写拒）', async () => {
      fsGuard.configure({ readPaths: ['data/in.txt'] })
      const promisesDirect = fsGuard.buildProxyObject('fs/promises', realFs) as Record<string, (...args: unknown[]) => Promise<unknown>>
      const inside = join(homeDir, 'data', 'in.txt')
      const outside = join(homeDir, 'data', 'out.txt')

      await expect(promisesDirect.readFile(inside, 'utf-8')).resolves.toBe('inside-content')
      // 白名单外路径在包装的读 API 上同步抛（assertAllowedPath 先于 promise 创建，
      // 与 ESM 模板 wrap 函数同构——await 调用点语义不变，异常仍归调用方 try/catch）
      expect(denyCodeOf(() => promisesDirect.readFile(outside, 'utf-8'))).toBe('PERMISSION_DENIED')
      await expect(promisesDirect.writeFile(inside, 'x')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    })
  })

  describe('宿主侧 fork env 编码（in-process：D3 注入链）', () => {
    it('C1: buildPluginCapabilityForkEnv——能力词编码为放行模块 JSON + readPaths 编码', () => {
      const env = buildPluginCapabilityForkEnv({
        capabilities: [PluginCapabilityConstants.NETWORK_HTTP],
        readPaths: ['Library/Application Support/Trae CN/User/globalStorage/storage.json'],
      })
      expect(env[fsGuard.ENV_ALLOWED_MODULES_KEY]).toBe(JSON.stringify(NETWORK_HTTP_MODULES))
      expect(env[fsGuard.ENV_READ_PATHS_KEY]).toBe(
        JSON.stringify(['Library/Application Support/Trae CN/User/globalStorage/storage.json']),
      )
    })

    it('C2: 未知能力词剔除并 warn（不参与放行）；resolveAllowedModules 的 unknown 单独返回', () => {
      const warnSpy: string[] = []
      const originalWarn = console.warn
      console.warn = (...args: unknown[]) => {
        warnSpy.push(args.map(String).join(' '))
      }
      try {
        const env = buildPluginCapabilityForkEnv({ capabilities: ['network.http', 'made.up.capability'] })
        expect(env[fsGuard.ENV_ALLOWED_MODULES_KEY]).toBe(JSON.stringify(NETWORK_HTTP_MODULES))
        expect(warnSpy.join('\n')).toContain('made.up.capability')
        // 映射函数本身不吞 unknown（安装期校验的判定输入）
        expect(resolveAllowedModules(['made.up.capability']).unknown).toEqual(['made.up.capability'])
      } finally {
        console.warn = originalWarn
      }
    })

    it('C3: buildPluginHostChildEnv 注入能力 env——不 mutate 父 env，deny 两键仍被剥（extras 不可覆盖）', () => {
      const parent: NodeJS.ProcessEnv = {
        PATH: '/usr/bin:/bin',
        TAIJI_AGENT_PACKAGED: '1',
        TAIJI_RUNTIME_TOKEN: 'secret-token',
      }
      const capEnv = buildPluginCapabilityForkEnv({ capabilities: [PluginCapabilityConstants.FS_READ_USER_DATA], readPaths: ['data/in.txt'] })
      const out = buildPluginHostChildEnv(parent, capEnv)

      expect(out[fsGuard.ENV_ALLOWED_MODULES_KEY]).toBe(JSON.stringify(FS_READ_MODULES))
      expect(out[fsGuard.ENV_READ_PATHS_KEY]).toBe(JSON.stringify(['data/in.txt']))
      expect(out.ELECTRON_RUN_AS_NODE).toBe('1')
      // deny 兜底优先于 extras（C-proc-09 出站契约不被能力注入破坏）
      expect(out.TAIJI_AGENT_PACKAGED).toBeUndefined()
      expect(out.TAIJI_RUNTIME_TOKEN).toBeUndefined()
      // 不 mutate 父对象（R1）
      expect(parent).toEqual({ PATH: '/usr/bin:/bin', TAIJI_AGENT_PACKAGED: '1', TAIJI_RUNTIME_TOKEN: 'secret-token' })
    })

    it('C4: 无能力 env（未登记插件）——第二参缺省，输出无能力键（loader 按基线全拦）', () => {
      const out = buildPluginHostChildEnv({ PATH: '/usr/bin' })
      expect(out[fsGuard.ENV_ALLOWED_MODULES_KEY]).toBeUndefined()
      expect(out[fsGuard.ENV_READ_PATHS_KEY]).toBeUndefined()
    })
  })

  // ── 门控组：真实 fork + 真实 loader + 真实 fs 的 P-perm 四 fixture 实测 ──────
  // 「代码 + OS 组合行为」（hook 拦截 + fs 代理在子进程链路下）无完成信号可等，
  // 本地默认跳过；决策面已由上方 in-process 组逐条覆盖。

  interface PermResultMessage { // oe-exempt:20261024:framework:测试内契约类型——loader 行为探针单实现常态
    type: 'perm-result'
    label: string
    out: Record<string, unknown>
  }

  describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
    `P-perm 四 fixture 实测（真实 fork + 真实 ESM loader + 真实 fs）${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ''}`,
    () => {
      let homeDir = ''
      let pluginDir = ''
      let activeChild: ChildProcess | null = null

      beforeEach(() => {
        homeDir = mkdtempSync(join(tmpdir(), 'perm-home-'))
        pluginDir = mkdtempSync(join(tmpdir(), 'perm-plugin-'))
        mkdirSync(join(homeDir, 'data'), { recursive: true })
        writeFileSync(join(homeDir, 'data', 'in.txt'), 'inside-content')
        writeFileSync(join(homeDir, 'data', 'out.txt'), 'outside-content')
        symlinkSync(join(homeDir, 'data', 'out.txt'), join(homeDir, 'data', 'link.txt'))
      })

      afterEach(() => {
        activeChild?.kill()
        activeChild = null
        if (homeDir) rmSync(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
        if (pluginDir) rmSync(pluginDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      })

      /** 复制 fixture 模板到 pluginDir 内（parentURL 须在 sandbox 内才触发 loader），fork 并等待 perm-result */
      function runFixture(
        fixtureName: string,
        allowed: string[],
        readPaths: string[],
        extraEnv: Record<string, string> = {},
      ): Promise<PermResultMessage> {
        const entry = join(pluginDir, fixtureName)
        writeFileSync(entry, readFileSync(join(PERM_FIXTURES_DIR, fixtureName), 'utf-8'))
        const child = fork(entry, [], {
          execArgv: ['--import', LOADER_PATH],
          env: {
            ...process.env,
            TAIJI_PLUGIN_SANDBOX_DIR: pluginDir,
            HOME: homeDir,
            TAIJI_PLUGIN_ALLOWED_MODULES: JSON.stringify(allowed),
            TAIJI_PLUGIN_READ_PATHS: JSON.stringify(readPaths),
            ...extraEnv,
          },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        })
        activeChild = child
        return new Promise<PermResultMessage>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`perm fixture ${fixtureName} did not respond in time`)), TIMEOUT_MS)
          child.on('message', (msg: unknown) => {
            const m = msg as Partial<PermResultMessage>
            if (m?.type === 'perm-result' && m.label === fixtureName.replace('.mjs', '')) {
              clearTimeout(timer)
              resolve(m as PermResultMessage)
            }
          })
          child.on('error', (err: Error) => {
            clearTimeout(timer)
            reject(err)
          })
          child.on('exit', (code: number | null) => {
            if (code !== 0 && code !== null) {
              clearTimeout(timer)
              reject(new Error(`perm fixture ${fixtureName} exited with code ${code}`))
            }
          })
        })
      }

      const FS_DECLARED = { allowed: [...FS_READ_MODULES], readPaths: ['data/in.txt'] }

      it('P-perm ①: 声明内读取成功（sync + promises 双面，内容正确）', async () => {
        const result = await runFixture('read-inside.mjs', FS_DECLARED.allowed, FS_DECLARED.readPaths, {
          TAIJI_PERM_TARGET: join(homeDir, 'data', 'in.txt'),
        })
        const out = result.out as { sync: { ok: boolean; content?: string; code?: string }; promises: { ok: boolean; content?: string; code?: string } }
        expect(out.sync.ok, JSON.stringify(out.sync)).toBe(true)
        expect(out.sync.content).toBe('inside-content')
        expect(out.promises.ok, JSON.stringify(out.promises)).toBe(true)
        expect(out.promises.content).toBe('inside-content')
      }, TIMEOUT_MS)

      it('P-perm ②: 声明外读取拒（PERMISSION_DENIED）+ 符号链接绕过拒（realpath 判界）', async () => {
        const result = await runFixture('read-outside.mjs', FS_DECLARED.allowed, FS_DECLARED.readPaths, {
          TAIJI_PERM_TARGET: join(homeDir, 'data', 'out.txt'),
          TAIJI_PERM_LINK: join(homeDir, 'data', 'link.txt'),
        })
        const out = result.out as Record<string, string>
        expect(out.syncOutside, JSON.stringify(out)).toBe('PERMISSION_DENIED')
        expect(out.symlink).toBe('PERMISSION_DENIED')
        expect(out.promisesOutside).toBe('PERMISSION_DENIED')
        expect(JSON.stringify(out)).not.toContain('LEAKED')
      }, TIMEOUT_MS)

      it('P-perm ③: os.homedir 免声明可用（os 移出基线）；空放行下 fs 对照仍拒', async () => {
        const result = await runFixture('os-homedir.mjs', [], [])
        const out = result.out as { homedir: { ok: boolean; isHomeEnv?: boolean; code?: string }; fsControl: string }
        expect(out.homedir.ok, JSON.stringify(out.homedir)).toBe(true)
        expect(out.homedir.isHomeEnv).toBe(true)
        expect(out.fsControl).toBe('PERMISSION_DENIED')
      }, TIMEOUT_MS)

      it('P-perm ④: 五类写操作变体全拒（writeFileSync / promises.writeFile / open 写 flags / FileHandle 写 / createWriteStream）', async () => {
        const result = await runFixture('write-denied.mjs', FS_DECLARED.allowed, FS_DECLARED.readPaths, {
          TAIJI_PERM_TARGET: join(homeDir, 'data', 'in.txt'),
        })
        const out = result.out as Record<string, string>
        expect(out.writeFileSync).toBe('PERMISSION_DENIED')
        expect(out.promisesWriteFile).toBe('PERMISSION_DENIED')
        expect(out.openWriteFlags).toBe('PERMISSION_DENIED')
        expect(out.handleWrite).toBe('PERMISSION_DENIED')
        expect(out.createWriteStream).toBe('PERMISSION_DENIED')
        expect(JSON.stringify(out)).not.toContain('LEAKED')
        // 声明内文件未被写入（只读防线的事后磁盘断言）
        expect(readFileSync(join(homeDir, 'data', 'in.txt'), 'utf-8')).toBe('inside-content')
      }, TIMEOUT_MS)
    },
  )
});
});

// ======================================================================
// ← src/services/plugin-service/__tests__/rt6-hardening.test.ts
// ======================================================================

// ── RT-6#3 / RT-6#4：HookPipeline 可观测性 + observe 背压 ──────────

function makeContext(hookType: HookType, sessionId: string): HookContext {
  return { pluginId: '', hookType, data: { eventName: 'turn_end', data: {}, sessionId }, timestamp: Date.now() }
}


function setupPipeline(
  hookType: HookType,
  entries: HookEntry[],
  opts: { workerId?: string | null } = {},
): { pipeline: HookPipeline; deps: HookPipelineDeps } {
  const workerId = opts.workerId === undefined ? 'worker-1' : opts.workerId
  const hookRegistry = new Map<string, HookEntry[]>([[hookType, entries]])
  const host = {
    getWorkerHandle: vi.fn().mockReturnValue(workerId === null ? undefined : { workerId, postMessage: vi.fn() }),
  }
  const rpcServer = { invoke: vi.fn(), notify: vi.fn() }
  const deps = {
    hookRegistry,
    host: host as unknown as PluginHost,
    rpcServer: rpcServer as unknown as PluginRpcServer,
  }
  return { pipeline: new HookPipeline(deps), deps }
}


// ── RT-6#6：toggle/uninstall 失败不再「只 log 回成功形状」 ─────────────

function makeBroker() {
  return { send: vi.fn(), broadcast: vi.fn(), sendError: vi.fn() }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('rt6-hardening', () => {
describe('RT-6#3 HookPipeline skip/失败聚合 warn', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('execute：无 handle → warn 含 pluginId/hookType/sessionId（不再零日志 continue）', async () => {
    const { pipeline } = setupPipeline('onBeforeToolCall', [
      { pluginId: 'p-gone', handlerId: 'p-gone:h1', priority: 0 },
    ], { workerId: null })

    // 聚合节流：到达 N 的整数倍才输出一条（禁逐条刷屏），内容断言需跑满一轮
    for (let i = 0; i < HOOK_ANOMALY_WARN_EVERY; i++) {
      const result = await pipeline.execute('onBeforeToolCall', makeContext('onBeforeToolCall', 'sid-1'))
      expect(result).toEqual({ blocked: false })
    }

    const texts = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(texts).toContain('p-gone')
    expect(texts).toContain('onBeforeToolCall')
    expect(texts).toContain('sid-1')
    expect(texts).toContain('skipped total=10')
  })

  it('execute：handler 超时/抛错 → warn 含 pluginId/hookType/sessionId + 失败原因', async () => {
    const { pipeline, deps } = setupPipeline('onBeforeToolCall', [
      { pluginId: 'p-slow', handlerId: 'p-slow:h1', priority: 0 },
    ])
    ;(deps.rpcServer.invoke as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('RPC timeout'))

    for (let i = 0; i < HOOK_ANOMALY_WARN_EVERY; i++) {
      await pipeline.execute('onBeforeToolCall', makeContext('onBeforeToolCall', 'sid-2'))
    }

    const texts = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(texts).toContain('p-slow')
    expect(texts).toContain('onBeforeToolCall')
    expect(texts).toContain('sid-2')
    expect(texts).toContain('RPC timeout')
    expect(texts).toContain('failed total=10')
  })

  it('notifyObservers：无 handle 同样 warn 留痕（observe 路径不再静默 skip）', () => {
    const { pipeline } = setupPipeline('onPiEvent', [
      { pluginId: 'p-gone', handlerId: 'p-gone:h1', priority: 0 },
    ], { workerId: null })

    for (let i = 0; i < HOOK_ANOMALY_WARN_EVERY; i++) {
      pipeline.notifyObservers('onPiEvent', makeContext('onPiEvent', 'sid-3'))
    }

    const texts = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(texts).toContain('p-gone')
    expect(texts).toContain('onPiEvent')
    expect(texts).toContain('sid-3')
  })

  it('聚合节流：N 次以内只 warn 一次（禁逐条刷屏），计数达到 N 的整数倍再输出', async () => {
    const { pipeline } = setupPipeline('onBeforeToolCall', [
      { pluginId: 'p-gone', handlerId: 'p-gone:h1', priority: 0 },
    ], { workerId: null })

    for (let i = 0; i < 9; i++) {
      await pipeline.execute('onBeforeToolCall', makeContext('onBeforeToolCall', 'sid-4'))
    }
    expect(warnSpy).not.toHaveBeenCalled()

    await pipeline.execute('onBeforeToolCall', makeContext('onBeforeToolCall', 'sid-4'))
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const texts = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(texts).toContain('skipped total=10')
  })
})
describe('RT-6#4 HookPipeline observe 路径在途深度上限', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('同步突发超过上限 → 超出部分 drop + warn，未超限部分照常 notify', () => {
    // 120 个 handler × 同一次 notifyObservers（同步循环内槽位未释放）→ 上限 64，
    // 前 64 下发、后 56 drop。
    const entries: HookEntry[] = Array.from({ length: 120 }, (_, i) => ({
      pluginId: `p-${i}`,
      handlerId: `p-${i}:h`,
      priority: i,
    }))
    const { pipeline, deps } = setupPipeline('onPiEvent', entries)
    const notify = deps.rpcServer.notify as unknown as ReturnType<typeof vi.fn>

    pipeline.notifyObservers('onPiEvent', makeContext('onPiEvent', 'sid-5'))

    expect(notify).toHaveBeenCalledTimes(64)
    const texts = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(texts).toContain('dropped')
    expect(texts).toContain('in-flight depth at limit')
  })

  it('跨事件循环轮次：槽位释放后不再误 drop（正常高频路径不受影响）', async () => {
    const { pipeline, deps } = setupPipeline('onPiEvent', [
      { pluginId: 'p-1', handlerId: 'p-1:h', priority: 0 },
    ])
    const notify = deps.rpcServer.notify as unknown as ReturnType<typeof vi.fn>

    for (let i = 0; i < 200; i++) {
      pipeline.notifyObservers('onPiEvent', makeContext('onPiEvent', 'sid-6'))
      // 让宏任务（槽位释放定时器）跑完再进下一轮
      await new Promise((r) => setTimeout(r, 0))
    }

    expect(notify).toHaveBeenCalledTimes(200)
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
describe('RT-6#6 togglePlugin 失败透出领域错误', () => {
  it('激活失败 → 广播回滚列表 + 抛带 code 的错误（不再回成功形状）', async () => {
    const broker = makeBroker()
    const service = new PluginService({} as never, broker)
    ;(service as unknown as { registry: unknown }).registry = {
      getDescriptor: vi.fn().mockReturnValue({ pluginId: 'p1', status: 'INACTIVE' }),
      getAllDescriptors: vi.fn().mockReturnValue([]),
    }
    ;(service as unknown as { activator: unknown }).activator = {
      activatePlugin: vi.fn().mockRejectedValue(new Error('boot timeout')),
      stopWatching: vi.fn(),
      getState: vi.fn().mockReturnValue('INACTIVE'),
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(service.togglePlugin('p1', true)).rejects.toThrow(/boot timeout/)
      await service.togglePlugin('p1', true).catch((e: unknown) => {
        expect((e as { code?: string }).code).toBe('PLUGIN_TOGGLE_FAILED')
      })
      // 回滚通道保留：仍广播最新列表（前端订阅据此复位 UI）
      expect(broker.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'config.plugins' }),
      )
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('停用失败 → 同样抛错（开关回弹不再静默）', async () => {
    const service = new PluginService({} as never, makeBroker())
    ;(service as unknown as { registry: unknown }).registry = {
      getDescriptor: vi.fn().mockReturnValue({ pluginId: 'p2', status: 'ACTIVE' }),
      getAllDescriptors: vi.fn().mockReturnValue([]),
    }
    ;(service as unknown as { activator: unknown }).activator = {
      deactivatePlugin: vi.fn().mockRejectedValue(new Error('deactivate hung')),
      stopWatching: vi.fn(),
      getState: vi.fn().mockReturnValue('ACTIVE'),
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(service.togglePlugin('p2', false)).rejects.toThrow(/deactivate hung/)
    vi.restoreAllMocks()
  })

  it('成功路径不回退：toggle 成功仍返回列表且不抛', async () => {
    const service = new PluginService({} as never, makeBroker())
    ;(service as unknown as { registry: unknown }).registry = {
      getDescriptor: vi.fn().mockReturnValue({ pluginId: 'p3', status: 'INACTIVE' }),
      getAllDescriptors: vi.fn().mockReturnValue([]),
    }
    ;(service as unknown as { activator: unknown }).activator = {
      activatePlugin: vi.fn().mockResolvedValue(undefined),
      stopWatching: vi.fn(),
      getState: vi.fn().mockReturnValue('ACTIVE'),
    }

    await expect(service.togglePlugin('p3', true)).resolves.toEqual([])
  })
})
// ── RT-6#7：command started 广播 ──────────────────────────────────

describe('RT-6#7 executeCommand 下发后广播 started', () => {
  it('notify 成功后触发 broadcastCommandStarted（含 pluginId/commandId/handlerId）', async () => {
    const registration: CommandRegistration = {
      handlerId: 'p1:h1',
      commandId: 'cmd1',
      pluginId: 'p1',
      workerId: 'w1',
      registeredAt: Date.now(),
    }
    const notify = vi.fn()
    const broadcast = vi.fn()
    const deps: CommandExecutorDeps = {
      registry: { getDescriptor: () => ({ pluginId: 'p1' }) as PluginDescriptor },
      host: { getWorkerHandle: () => ({ workerId: 'w1', postMessage: () => {} }) },
      rpcServer: { notify },
      commandRegistry: new Map([['p1:cmd1', registration]]),
      commandInvokes: new PendingTracker<string, unknown>(),
      broadcast,
    }

    void executeCommand(deps, 'p1', 'cmd1', { a: 1 }).catch(() => {})

    expect(notify).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledTimes(1)
    const [type, id, payload] = broadcast.mock.calls[0]!
    expect(type).toBe('plugin:notification')
    expect(String(id)).toContain('cmdStarted_p1:cmd1_')
    const started = payload as { pluginId: string; level: string; message: string }
    expect(started.pluginId).toBe('p1')
    expect(started.level).toBe('info')
    expect(started.message).toContain("'cmd1'")
    expect(started.message).toContain("'p1:h1'")
  })

  it('未注入 broadcast 时不炸（可选依赖）', async () => {
    const registration: CommandRegistration = {
      handlerId: 'p2:h1',
      commandId: 'cmd2',
      pluginId: 'p2',
      workerId: 'w2',
      registeredAt: Date.now(),
    }
    const notify = vi.fn()
    const commandInvokes = new PendingTracker<string, unknown>()
    const deps: CommandExecutorDeps = {
      registry: { getDescriptor: () => ({ pluginId: 'p2' }) as PluginDescriptor },
      host: { getWorkerHandle: () => ({ workerId: 'w2', postMessage: () => {} }) },
      rpcServer: { notify },
      commandRegistry: new Map([['p2:cmd2', registration]]),
      commandInvokes,
    }

    // 不 await（pending 等 30min 兜底）——只验下发路径不因缺省依赖抛错
    void executeCommand(deps, 'p2', 'cmd2').catch(() => {})
    expect(notify).toHaveBeenCalledTimes(1)
    expect(commandInvokes.has('p2:h1')).toBe(true)
  })
})
});

// ======================================================================
// ← src/services/plugin-service/__tests__/worker-stderr-collector.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('worker-stderr-collector', () => {
describe('createWorkerStderrCollector（D6-⑤ worker stderr 崩溃取证缓冲）', () => {
  it('常态累积：多块 feed 后 take 返回拼接文本，take 后清空（二次 take 为空）', () => {
    const c = createWorkerStderrCollector()
    c.feed(Buffer.from('line one\n', 'utf8'))
    c.feed(Buffer.from('line two\n', 'utf8'))
    const snap = c.take()
    expect(snap.text).toBe('line one\nline two\n')
    expect(snap.truncated).toBe(false)
    const again = c.take()
    expect(again.text).toBe('')
    expect(again.truncated).toBe(false)
  })

  it('多字节字符跨 chunk 边界不截断（Buffer 累积、take 时才解码）', () => {
    const c = createWorkerStderrCollector()
    const text = '崩溃原因：内存耗尽'
    const buf = Buffer.from(text, 'utf8')
    // 按 2 字节一切：每个 UTF-8 多字节字符都被 chunk 边界切断
    for (let i = 0; i < buf.length; i += 2) {
      c.feed(buf.subarray(i, Math.min(i + 2, buf.length)))
    }
    expect(c.take().text).toBe(text)
  })

  it('超帽丢最旧并标注 truncated（对齐 rpc-client stderrChunks 保尾语义）', () => {
    const c = createWorkerStderrCollector(100)
    c.feed(Buffer.from('A'.repeat(60), 'utf8'))
    c.feed(Buffer.from('B'.repeat(60), 'utf8')) // 总 120 > 100 → 丢 A 块
    const snap = c.take()
    expect(snap.text).toBe('B'.repeat(60))
    expect(snap.truncated).toBe(true)
  })

  it('WORKER_STDERR_MAX_BYTES 对齐 pi-crash 的 1MB 上限', () => {
    expect(WORKER_STDERR_MAX_BYTES).toBe(1_000_000)
  })
})
});
