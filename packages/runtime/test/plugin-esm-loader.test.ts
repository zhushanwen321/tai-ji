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
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { fork, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { buildPluginHostChildEnv } from '../src/services/plugin-service/plugin-host-process.js'
import { buildPluginCapabilityForkEnv } from '../src/services/plugin-service/plugin-fs-guard.js'
import { resolveAllowedModules, PluginCapabilityConstants } from '@taiji/shared/plugin-capability-map'
import { INTEGRATION_TESTS_ENABLED, INTEGRATION_TESTS_SKIP_REASON } from '../../../test-guard/integration-gate.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LOADER_PATH = join(__dirname, '../src/services/plugin-service/plugin-esm-loader.cjs')
const GUARD_PATH = join(__dirname, '../src/services/plugin-service/plugin-fs-guard.cjs')
const PERM_FIXTURES_DIR = join(__dirname, 'plugin-perm-fixtures')
const TIMEOUT_MS = 15_000

const nodeRequire = createRequire(import.meta.url)
const fsGuard = nodeRequire(GUARD_PATH) as {
  ENV_ALLOWED_MODULES_KEY: string
  ENV_READ_PATHS_KEY: string
  configure(options: { readPaths?: unknown }): void
  inlineReadBases(): string[]
  proxyExportNames(target: string): string[]
  buildProxyModuleSource(target: string): string
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
        return nodeRequire(join(__dirname, '../src/services/plugin-service/plugin-blocked-builtins.cjs'))
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
