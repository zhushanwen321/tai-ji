/**
 * S1-W3 沙箱逃逸回归测试（spec §3.3 D2 / 验收 A1/A2 单元层）
 *
 * 背景：dirname 修正前，宿主把入口文件路径原样注入 TAIJI_PLUGIN_SANDBOX_DIR，
 * ESM loader 的 startsWith(sandboxDir + sep) 恒 false → 边界/黑名单/scheme 检查
 * 0% 命中。本文件以「真实 fork 子进程 + 真实 plugin-esm-loader.cjs + dirname
 * 目录形态 env（模拟宿主修正后注入）」验证：
 *   1. 恶意 import（node:fs）在真实 loader 下被拒，同文件合法相对 import 的
 *      副作用（sibling 顶层代码）先于拦截执行
 *   2. 裸名 import 向上遍历命中沙箱外 node_modules 副本被拒（解析结果出界）
 *   3. CJS 拦截器对 / 与 file: 前缀及裸名出界的边界判定（单元级）
 *   4. BLOCKED_BUILTINS SSOT 防退化（plugin-sandbox.ts 与 .cjs 数据源一致 +
 *      loader 不回退为内联数组）
 *
 * 端到端（真实 activator → assignProcess → fork env → loader）由
 * scripts/verify-plugin-e2e.sh 的 SEC-A1/A2 场景覆盖。
 */

import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest'
import { fork } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { createRequireInterceptor, BLOCKED_BUILTINS } from '../src/services/plugin-service/plugin-sandbox.js'
import { createTsxPathsTsconfig } from './helpers/tsx-fork-tsconfig.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LOADER_PATH = join(__dirname, '../src/services/plugin-service/plugin-esm-loader.cjs')
// 专用 runner：回传 results 后不 exit（插件 console.log 副作用需 flush stdout）
const RUNNER_PATH = join(__dirname, 'fixtures/sandbox-escape-runner.cjs')
const BLOCKED_BUILTINS_SOURCE = join(__dirname, '../src/services/plugin-service/plugin-blocked-builtins.cjs')

const TIMEOUT_MS = 15_000

/** 本用例存活中的 runner 进程（afterEach 统一回收） */
let activeChild: ReturnType<typeof fork> | null = null

interface ImportResult {
  label: string
  ok: boolean
  error?: string
}

const collectResults = (child: ReturnType<typeof fork>): Promise<ImportResult[]> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture did not respond in time')), TIMEOUT_MS)
    child.on('message', (msg: unknown) => {
      const m = msg as { type?: string; results?: ImportResult[] }
      if (m?.type === 'results') {
        clearTimeout(timer)
        resolve(m.results ?? [])
      }
    })
    child.on('exit', (code: number | null) => {
      // runner 正常存活到宿主 kill（code null / SIGTERM）；非 kill 退出视为失败
      if (code !== 0 && code !== null) {
        clearTimeout(timer)
        reject(new Error(`fixture exited with code ${code}`))
      }
    })
    child.on('error', (err: Error) => {
      clearTimeout(timer)
      reject(err)
    })
  })

/** fork runner：真实 ESM loader + env（目录形态 = dirname(入口)，对齐 S1-W3 宿主注入） */
function runInSandbox(
  pluginEntry: string,
  items: Array<{ label: string; url: string }>,
): { child: ReturnType<typeof fork>; results: Promise<ImportResult[]> } {
  const child = fork(RUNNER_PATH, [], {
    execArgv: ['--import', LOADER_PATH],
    env: {
      ...process.env,
      // 宿主（plugin-host-process env 注入处）修正后的注入形态：dirname(pluginPath)
      TAIJI_PLUGIN_SANDBOX_DIR: dirname(pluginEntry),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  activeChild = child
  const results = collectResults(child)
  child.send({ type: 'run', items })
  return { child, results }
}

describe('S1-W3: sandbox escape regression (real fork + real ESM loader)', () => {
  let pluginDir = ''

  afterEach(() => {
    // runner 不主动 exit，用例结束时统一回收（幂等：已退出的 kill 是 no-op）
    activeChild?.kill()
    activeChild = null
    if (pluginDir) rmSync(pluginDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    // 向上逃逸的沙箱外 node_modules 放在 pluginDir 父目录（mktemp 工作目录），单独清理
    if (pluginDir) rmSync(join(dirname(pluginDir), 'node_modules'), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('SEC-A1(单元): node:fs 被拒（静态/动态）+ 同入口合法相对 import 成功', async () => {
    pluginDir = mkdtempSync(join(tmpdir(), 'escape-plugin-'))
    writeFileSync(join(pluginDir, 'sibling.mjs'), 'console.log("[escape] sibling loaded")\nexport const v = 1\n')
    // 静态形态：link 阶段即被 resolve hook 拒绝 → 整个模块加载失败
    writeFileSync(join(pluginDir, 'evil-static.mjs'), "import 'node:fs'\n")
    // 动态形态：合法 sibling 先执行，node:fs 动态 import 被 catch（模块本体加载成功，
    // 两个标记都经 stdout 可观察——sibling 成功与 node:fs 被拒互不牵连）
    writeFileSync(
      join(pluginDir, 'evil-dynamic.mjs'),
      [
        "const s = await import('./sibling.mjs')",
        'console.log("[escape] sibling loaded")',
        'try {',
        "  await import('node:fs')",
        '  console.log("[escape] NODE:FS LEAKED")',
        '} catch (e) {',
        "  console.log('[escape] node:fs rejected: ' + (e && e.message))",
        '}',
        'export const loaded = s.v',
      ].join('\n'),
    )

    const stdoutChunks: string[] = []
    const { child, results } = runInSandbox(join(pluginDir, 'evil-dynamic.mjs'), [
      { label: 'evil-static', url: pathToFileURL(join(pluginDir, 'evil-static.mjs')).href },
      { label: 'evil-dynamic', url: pathToFileURL(join(pluginDir, 'evil-dynamic.mjs')).href },
    ])
    child.stdout?.on('data', (d: Buffer) => stdoutChunks.push(String(d)))
    const all = await results
    const staticResult = all.find((r) => r.label === 'evil-static')
    const dynamicResult = all.find((r) => r.label === 'evil-dynamic')

    // 静态：拦截错误可定位（含被拒 specifier），code 语义为 PERMISSION_DENIED
    expect(staticResult?.ok).toBe(false)
    expect(staticResult?.error).toContain("Sandbox: import('node:fs') is blocked")
    expect(staticResult?.error).toContain('PERMISSION_DENIED')
    // 动态：模块本体加载成功（合法 import 不受牵连）
    expect(dynamicResult?.ok).toBe(true)

    const stdout = () => stdoutChunks.join('')
    await vi.waitFor(() => expect(stdout()).toContain('[escape] sibling loaded'), { timeout: 5000, interval: 100 })
    // node:fs 动态 import 同样被拒（错误文案含被拒 specifier），无泄漏标记
    await vi.waitFor(() => expect(stdout()).toContain("node:fs rejected: Sandbox: import('node:fs') is blocked"), {
      timeout: 5000,
      interval: 100,
    })
    expect(stdout()).not.toContain('NODE:FS LEAKED')
    child.kill()
  }, TIMEOUT_MS)

  it('SEC-A2(单元): 裸名 import 向上遍历命中沙箱外 node_modules 副本被拒', async () => {
    pluginDir = mkdtempSync(join(tmpdir(), 'escape-plugin-'))
    // 沙箱外副本：pluginDir 上层的 node_modules（Node 裸名解析会向上命中这里）
    const outsideModules = join(dirname(pluginDir), 'node_modules', 'escape-evil-pkg')
    mkdirSync(outsideModules, { recursive: true })
    writeFileSync(join(outsideModules, 'package.json'), JSON.stringify({ name: 'escape-evil-pkg', version: '1.0.0', main: 'index.mjs' }))
    writeFileSync(join(outsideModules, 'index.mjs'), 'console.log("[escape] EVIL PKG EXECUTED")\nexport const v = 1\n')
    // 界内合法依赖对照（pluginDir/node_modules 内 → 放行）
    const insideModules = join(pluginDir, 'node_modules', 'escape-ok-pkg')
    mkdirSync(insideModules, { recursive: true })
    writeFileSync(join(insideModules, 'package.json'), JSON.stringify({ name: 'escape-ok-pkg', version: '1.0.0', main: 'index.mjs' }))
    writeFileSync(join(insideModules, 'index.mjs'), 'export const v = 2\n')
    // 发起者文件必须在 pluginDir 内（loader 只拦插件代码发起的 import）
    writeFileSync(join(pluginDir, 'evil-bare.mjs'), "import 'escape-evil-pkg'\n")
    writeFileSync(join(pluginDir, 'ok-bare.mjs'), "import 'escape-ok-pkg'\n")

    const { child, results } = runInSandbox(join(pluginDir, 'entry.mjs'), [
      { label: 'evil-bare', url: pathToFileURL(join(pluginDir, 'evil-bare.mjs')).href },
      { label: 'ok-bare', url: pathToFileURL(join(pluginDir, 'ok-bare.mjs')).href },
    ])
    const all = await results
    child.kill()
    const evilBare = all.find((r) => r.label === 'evil-bare')
    const okBare = all.find((r) => r.label === 'ok-bare')

    // 出界裸名：解析结果在沙箱外 → 拒（修复前该 import 成功且后续 import 全绕过 hook）
    expect(evilBare?.ok).toBe(false)
    expect(evilBare?.error).toContain("Sandbox: import('escape-evil-pkg') resolves outside plugin directory")
    expect(evilBare?.error).toContain('PERMISSION_DENIED')
    // 界内 node_modules（合法依赖形态）：放行
    expect(okBare?.ok).toBe(true)
  }, TIMEOUT_MS)
})

describe('S1-W3: CJS interceptor boundary (/, file:, bare-name resolved)', () => {
  // fixture 目录 mkdtemp 自建自删且测试侧先 realpathSync 归一：生产码
  // createRequireInterceptor 内部对 pluginDir 做 realpathSync 归一后再 startsWith 判界
  // （macOS tmpdir 经 /var → /private/var symlink）——目录缺失会走生产码 realpath warn
  // + fail-closed 分支（vitest 解析 warn 的 Error stack 会炸 sourcemap artifact），
  // 未归一则断言传入的 resolvedPath 字符串与归一后的判界前缀恒不匹配。
  let pluginDir = ''
  let outsideRoot = ''
  let outsideEntry = ''
  let interceptor: ReturnType<typeof createRequireInterceptor>

  beforeAll(() => {
    pluginDir = realpathSync(mkdtempSync(join(tmpdir(), 'taiji-plugin-sandbox-cjs-')))
    // 出界对照路径：mkdtemp 父目录下的兄弟路径必然不共享 pluginDir 前缀
    outsideRoot = dirname(pluginDir)
    outsideEntry = join(outsideRoot, 'sandbox-outside-evil.cjs')
    interceptor = createRequireInterceptor(pluginDir)
  })

  afterAll(() => {
    if (pluginDir) rmSync(pluginDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('rejects absolute path requests outside pluginDir (SEC-A2 CJS 通道)', () => {
    expect(() => interceptor(outsideEntry, outsideEntry)).toThrowError(
      `Sandbox: require('${outsideEntry}') resolves outside plugin directory`,
    )
  })

  it('rejects file: URL requests outside pluginDir', () => {
    const outsideUrl = pathToFileURL(outsideEntry).href
    expect(() => interceptor(outsideUrl, outsideUrl)).toThrowError(/resolves outside plugin directory/)
  })

  it('allows absolute path requests inside pluginDir', () => {
    const insideEntry = join(pluginDir, 'helper.cjs')
    expect(interceptor(insideEntry, insideEntry)).toBe(insideEntry)
  })

  it('rejects bare-name require resolving to node_modules outside pluginDir', () => {
    expect(() =>
      interceptor('escape-evil-pkg', join(outsideRoot, 'node_modules', 'escape-evil-pkg', 'index.js')),
    ).toThrowError(/resolves outside plugin directory/)
  })

  it('allows bare-name require resolving inside pluginDir/node_modules', () => {
    expect(interceptor('ok-pkg', join(pluginDir, 'node_modules', 'ok-pkg', 'index.js'))).toBe('ok-pkg')
  })

  it('still allows builtin bare names (resolvedPath 非文件形态)', () => {
    expect(interceptor('path', 'node:path')).toBe('path')
    expect(interceptor('node:util', 'node:util')).toBe('node:util')
  })
})

describe('S1-W3: BLOCKED_BUILTINS SSOT 防退化', () => {
  it('plugin-sandbox.ts 导出与 plugin-blocked-builtins.cjs 数据源逐元素相等', () => {
    // 直接 require 真实 .cjs（绕过 plugin-sandbox.ts 的 import），抓「TS 侧改回内联」漂移
    const requireFromTest = createRequire(import.meta.url)
    const source = requireFromTest(BLOCKED_BUILTINS_SOURCE) as { BLOCKED_BUILTINS: readonly string[] }
    expect([...BLOCKED_BUILTINS]).toEqual([...source.BLOCKED_BUILTINS])
    // 数据源非空且含关键高危模块（空数组会让所有黑名单检查静默失效）
    expect(source.BLOCKED_BUILTINS.length).toBeGreaterThan(0)
    expect(source.BLOCKED_BUILTINS).toContain('fs')
    expect(source.BLOCKED_BUILTINS).toContain('child_process')
    expect(source.BLOCKED_BUILTINS).toContain('module')
  })

  it('ESM loader 消费同一数据源（源码含 require 引用，防回退为内联数组）', () => {
    const loaderSrc = readFileSync(LOADER_PATH, 'utf-8')
    expect(loaderSrc).toContain("require('./plugin-blocked-builtins.cjs')")
  })
})

describe('S-36: CJS 拦截一次性监控日志（usage monitor）', () => {
  // 与 plugin-sandbox-process-guards.test.ts 同一隔离模式：initSandbox 修改全局
  // process.env / process.kill / process.ppid / Module._resolveFilename，必须在 fork
  // 子进程调用（进程退出即丢弃污染，in-process 不可恢复）。区别在于本 fixture 由
  // 测试动态生成到 mkdtemp（不新增仓库 fixture 文件），经 --import tsx 加载 .ts 源码；
  // cwd 指向 packages/runtime 保证 tsx 从项目 node_modules 解析（对齐既有 fork 用例）。
  const PLUGIN_BOOTSTRAP_TS = join(__dirname, '../src/services/plugin-service/plugin-bootstrap.ts')
  const RUNTIME_ROOT = join(__dirname, '..')

  interface MonitorResult {
    monitorCalls: string[]
    resolveCount: number
    loaded: string[]
  }

  it('插件 CJS require 触发 patch 后，监控日志恰好输出一次，第二次 require 静默', async () => {
    // 临时 tsconfig（fork env TSX_TSCONFIG_PATH）：plugin-bootstrap 依赖链经 plugin-sdk
    // 运行时 re-export require @zhushanwen/extension-protocol，其 exports 无 require 条件
    // → 子进程崩溃产生 sourcemap artifact（unhandled error），见 helper 注释
    const tsxTsconfig = createTsxPathsTsconfig()
    try {
      const workDir = mkdtempSync(join(tmpdir(), 's36-monitor-'))
      const pluginDir = join(workDir, 'plugin')
      mkdirSync(pluginDir)
      // 两个不同 helper：两次 require 都真实走 _resolveFilename（require 同一文件第二
      // 次命中 CJS 模块缓存不触发 resolve，会把「恰好一次」变成缓存假阴性）
      writeFileSync(join(pluginDir, 'helper-a.cjs'), "module.exports = { tag: 'a' }\n")
      writeFileSync(join(pluginDir, 'helper-b.cjs'), "module.exports = { tag: 'b' }\n")
      const fixturePath = join(workDir, 'fixture.cjs')
      writeFileSync(
        fixturePath,
        [
          "'use strict'",
          '// S-36 fixture：spy console.log → initSandbox → 两次界内 CJS require → 回传计数',
          'const calls = []',
          'const originalLog = console.log',
          'console.log = (...args) => { calls.push(args.map(String).join(" ")) }',
          '// node:module 在 BLOCKED_BUILTINS 黑名单内，须在 initSandbox 装 patch 前取好构造器',
          "const Module = require('node:module').Module",
          `const { initSandbox } = require(${JSON.stringify(PLUGIN_BOOTSTRAP_TS)})`,
          `initSandbox(${JSON.stringify(pluginDir)})`,
          '// 计数后续 _resolveFilename 触发次数（证明两次 require 都经过了 sandbox patch）',
          'const sandboxPatched = Module._resolveFilename',
          'let resolveCount = 0',
          'Module._resolveFilename = function (...args) {',
          '  resolveCount++',
          '  return sandboxPatched.apply(this, args)',
          '}',
          `const a = require(${JSON.stringify(join(pluginDir, 'helper-a.cjs'))})`,
          `const b = require(${JSON.stringify(join(pluginDir, 'helper-b.cjs'))})`,
          'console.log = originalLog',
          "process.stdout.write('S36_RESULT:' + JSON.stringify({",
          '  monitorCalls: calls.filter((c) => c.includes("CJS require interception active")),',
          '  resolveCount,',
          '  loaded: [a.tag, b.tag],',
          '}))',
          '',
        ].join('\n'),
      )

      const result = await new Promise<MonitorResult>((resolveP, reject) => {
        const child = fork(fixturePath, [], {
          execPath: process.execPath,
          execArgv: ['--import', 'tsx'],
          cwd: RUNTIME_ROOT,
          env: { ...process.env, TSX_TSCONFIG_PATH: tsxTsconfig.tsconfigPath },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        })
        let stdout = ''
        let stderr = ''
        child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
        child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
        child.on('error', reject)
        child.on('close', (code) => {
          const line = stdout.split('\n').find((l) => l.startsWith('S36_RESULT:'))
          if (code !== 0 || !line) {
            reject(new Error(`fixture exited ${code}. stdout=${stdout} stderr=${stderr}`))
            return
          }
          try {
            resolveP(JSON.parse(line.slice('S36_RESULT:'.length)) as MonitorResult)
          } catch (e) {
            reject(new Error(`fixture result parse failed: ${(e as Error).message}`))
          }
        })
      })
      rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })

      // 两次 require 都真实经过了 sandbox patch 且加载成功（排除缓存假阴性）
      expect(result.resolveCount).toBeGreaterThanOrEqual(2)
      expect(result.loaded).toEqual(['a', 'b'])
      // 监控日志恰好一次：首次 patch 触发输出，第二次 require 静默
      expect(result.monitorCalls).toHaveLength(1)
      expect(result.monitorCalls[0]).toContain(
        `[plugin-sandbox] CJS require interception active for plugin dir: ${pluginDir}`,
      )
      expect(result.monitorCalls[0]).toContain(
        'spec gate S1-W3 usage monitor (observation window ends ~2026-11)',
      )
    } finally {
      tsxTsconfig.dispose()
    }
  }, 30_000)
})
