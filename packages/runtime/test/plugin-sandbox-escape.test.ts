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
 *
 * 2026-10-22 单测层整治（判据三档与处置通道见 docs/todo/test-single-layer-cleanup.md）：
 * ESM loader 边界是「代码 + OS 组合行为」——真实 fork 子进程 + Node ESM loader hook
 * 的注册与拦截没有进程内的确定性完成信号（判据三档第 3 类），无法改写成纯逻辑，
 * 按处置通道「移 CI-only / 拆分层」门控：
 * - 「sandbox escape regression（real fork + real ESM loader）」describe 经
 *   describe.skipIf(!INTEGRATION_TESTS_ENABLED) 包裹——本地默认跳过，
 *   CI / 按改动范围触发时设 TAIJI_TEST_INTEGRATION=1 真跑（门控 SSOT =
 *   test-guard/integration-gate.ts，e2e-map 登记 R2 规则）；
 * - 「CJS interceptor boundary」与「BLOCKED_BUILTINS SSOT」是纯 in-process 逻辑
 *   （拦截器函数进/断言出 + require 数据源比对），无进程无时钟，留在默认单测组。
 */

import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest'
import { fork } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { createRequireInterceptor, BLOCKED_BUILTINS } from '../src/services/plugin-service/plugin-sandbox.js'
import { findPackageRootDir } from '../src/services/plugin-service/pkg-root.js'
import { createTsxPathsTsconfig } from './helpers/tsx-fork-tsconfig.js'
import { INTEGRATION_TESTS_ENABLED, INTEGRATION_TESTS_SKIP_REASON } from '../../../test-guard/integration-gate.ts'

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

/** fork runner：真实 ESM loader + env（目录形态 = 包根遍历，对齐宿主 S1-W3 + ⑤ 注入） */
function runInSandbox(
  pluginEntry: string,
  items: Array<{ label: string; url: string }>,
  extraEnv: Record<string, string> = {},
): { child: ReturnType<typeof fork>; results: Promise<ImportResult[]> } {
  const child = fork(RUNNER_PATH, [], {
    execArgv: ['--import', LOADER_PATH],
    env: {
      ...process.env,
      // 宿主（plugin-host-process env 注入处）的注入形态：入口向上首个含 package.json
      // 的祖先（⑤ 包根修正——子目录入口下 dirname 会把边界错划成 <插件目录>/src）
      TAIJI_PLUGIN_SANDBOX_DIR: findPackageRootDir(pluginEntry),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  activeChild = child
  const results = collectResults(child)
  child.send({ type: 'run', items })
  return { child, results }
}

describe.skipIf(!INTEGRATION_TESTS_ENABLED)(`S1-W3: sandbox escape regression (real fork + real ESM loader)${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ''}`, () => {
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

  it('SEC-A3(单元): 子目录入口 + 包根内 node_modules 依赖放行（真实发布形态，⑤ 包根修正回归）', async () => {
    // 真实发布形态 fixture：manifest main = src/index.ts（此处以 src/index.mjs 承载），
    // 依赖装在 pluginDir/node_modules（④ 修复后的安装落点）。修复前宿主注入
    // dirname(entry) = <pluginDir>/src，界内依赖被判越界激活即炸（d3-r2 实测）；
    // 修复后 sandboxDir = 包根（向上首个含 package.json 的祖先），裸导入界内解析放行。
    pluginDir = mkdtempSync(join(tmpdir(), 'escape-plugin-'))
    writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({
      name: '@fixture/plugin-sub-entry',
      version: '1.0.0',
      main: 'src/index.mjs',
    }))
    const insideModules = join(pluginDir, 'node_modules', 'escape-sub-dep')
    mkdirSync(insideModules, { recursive: true })
    writeFileSync(join(insideModules, 'package.json'), JSON.stringify({ name: 'escape-sub-dep', version: '1.0.0', main: 'index.mjs' }))
    writeFileSync(join(insideModules, 'index.mjs'), 'export const v = 3\n')
    mkdirSync(join(pluginDir, 'src'), { recursive: true })
    writeFileSync(join(pluginDir, 'src', 'index.mjs'), "import 'escape-sub-dep'\nexport const loaded = true\n")

    // findPackageRootDir 是宿主 env 注入处（plugin-host-process）的消费函数——
    // 本断言钉住「子目录入口 → 包根」的推导，env 注入即用推导值
    expect(findPackageRootDir(join(pluginDir, 'src', 'index.mjs'))).toBe(pluginDir)

    const { child, results } = runInSandbox(join(pluginDir, 'src', 'index.mjs'), [
      { label: 'sub-entry-bare', url: pathToFileURL(join(pluginDir, 'src', 'index.mjs')).href },
    ])
    const all = await results
    child.kill()
    const bare = all.find((r) => r.label === 'sub-entry-bare')
    expect(bare?.ok).toBe(true)
  }, TIMEOUT_MS)

  it('CAP-PERM(单元): 放行 network.http 后 import node:vm 仍被拒（永久封禁不受放行清单影响）', async () => {
    // provider-plugin-access D3：vm 属永久封禁 7 项，computeBlockedBuiltins 对
    // allowed 含 vm 免疫；本用例以 network.http 的放行集（http/https/net/dns/tls）
    // 注入 fork env，验证真 fork + 真 loader 下 https 放行生效、vm 仍拦。
    // fixture 必须复制进 sandbox（仓库路径的 parentURL 出界 → loader 整体放行，
    // 对齐 P-perm runFixture 的同款约束）。
    pluginDir = mkdtempSync(join(tmpdir(), 'escape-plugin-'))
    const fixtureEntry = join(pluginDir, 'vm-blocked.mjs')
    writeFileSync(fixtureEntry, readFileSync(join(__dirname, 'plugin-perm-fixtures', 'vm-blocked.mjs'), 'utf-8'))
    const { child, results } = runInSandbox(fixtureEntry, [
      { label: 'vm-blocked', url: pathToFileURL(fixtureEntry).href },
    ], {
      // 与宿主 buildPluginCapabilityForkEnv 同形态的 JSON 数组编码
      TAIJI_PLUGIN_ALLOWED_MODULES: JSON.stringify(['http', 'https', 'net', 'dns', 'tls']),
      TAIJI_PLUGIN_READ_PATHS: '[]',
    })
    // fixture 顶层执行后经 fork IPC 回传 perm-result（vm/https 两项判定）
    const permResult = await new Promise<{ label: string; out: Record<string, string | { ok: boolean }> }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('perm fixture did not respond in time')), TIMEOUT_MS)
      child.on('message', (msg: unknown) => {
        const m = msg as { type?: string; label?: string; out?: Record<string, string | { ok: boolean }> }
        if (m?.type === 'perm-result' && m.label === 'vm-blocked') {
          clearTimeout(timer)
          resolve(m as { label: string; out: Record<string, string | { ok: boolean }> })
        }
      })
    })
    const all = await results
    child.kill()
    // runner 的 import 完成回执（fixture 模块本体加载成功 = 两个动态 import 都被捕获）
    expect(all.find((r) => r.label === 'vm-blocked')?.ok).toBe(true)
    // 放行生效对照面：node:https import 成功
    expect(permResult.out.https).toBe('ok')
    // 新增断言（设计 §4）：network.http 放行后 node:vm 仍被拒（PERMISSION_DENIED）
    expect(permResult.out.vm).toBe('PERMISSION_DENIED')
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

describe('F1-9: CJS require 拦截接入能力词表（computeBlockedBuiltins）', () => {
  // 探针四判定（F1-10 修复契约）：声明 network.http 后 https 由拒变放行、fs 未声明拒
  // （CJS 通道 fs 系只走 FS_PROXY_MODULES 两态放行——声明 fs.read-user-data 才放行，
  // 由 Module._load patch 返回只读代理对象）、vm 永久拒、os 免声明放行。
  // 与「CJS interceptor boundary」同层：拦截器纯函数 in-process，无进程无时钟。
  let pluginDir = ''

  beforeAll(() => {
    pluginDir = realpathSync(mkdtempSync(join(tmpdir(), 'taiji-plugin-sandbox-cjs-cap-')))
  })

  afterAll(() => {
    if (pluginDir) rmSync(pluginDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('声明 network.http（allowed=http,https,net,dns,tls）→ https 放行、fs 拒、vm 永久拒、os 免声明放行', () => {
    const interceptor = createRequireInterceptor(pluginDir, ['http', 'https', 'net', 'dns', 'tls'])
    // 正例：声明能力对应的模块放行（含 node: 前缀形态，M6a-01 剥离对称）
    expect(interceptor('https', 'node:https')).toBe('https')
    expect(interceptor('node:https', 'node:https')).toBe('node:https')
    // 反例：fs 未声明 → 拒（CJS 通道 fs 系只走只读代理放行——声明 fs.read-user-data
    // 才两态放行，由 Module._load patch 返回代理对象，见 F1-24 fork 组）
    expect(() => interceptor('fs', 'node:fs')).toThrowError(/is blocked/)
    expect(() => interceptor('fs/promises', 'node:fs/promises')).toThrowError(/is blocked/)
    // 反例：vm 永久封禁，allowed 注入也不放行（fail-closed 免疫）
    expect(() => interceptor('vm', 'node:vm')).toThrowError(/is blocked/)
    // 对照：os 不在基线黑名单，免声明放行（D3 裁决移出）
    expect(interceptor('os', 'node:os')).toBe('os')
    // 基线未放行的其余模块仍拦（能力声明只放行映射集）
    expect(() => interceptor('child_process', 'node:child_process')).toThrowError(/is blocked/)
  })

  it('未声明能力（allowed 缺省空集）→ https 拒（基线全拦，fail-closed 向后兼容）', () => {
    const interceptor = createRequireInterceptor(pluginDir)
    expect(() => interceptor('https', 'node:https')).toThrowError(/is blocked/)
    expect(() => interceptor('fs', 'node:fs')).toThrowError(/is blocked/)
    expect(interceptor('path', 'node:path')).toBe('path')
  })
})

describe('S1-W3: BLOCKED_BUILTINS SSOT 防退化', () => {
  it('plugin-sandbox.ts 导出与 plugin-blocked-builtins.cjs 数据源逐元素相等', () => {
    // 直接 require 真实 .cjs（绕过 plugin-sandbox.ts 的 import），抓「TS 侧改回内联」漂移
    const requireFromTest = createRequire(import.meta.url)
    const source = requireFromTest(BLOCKED_BUILTINS_SOURCE) as {
      BLOCKED_BUILTINS: readonly string[]
      PERMANENTLY_BLOCKED_BUILTINS: readonly string[]
      computeBlockedBuiltins: (allowed: readonly string[] | unknown) => readonly string[]
    }
    expect([...BLOCKED_BUILTINS]).toEqual([...source.BLOCKED_BUILTINS])
    // 数据源非空且含关键高危模块（空数组会让所有黑名单检查静默失效）
    expect(source.BLOCKED_BUILTINS.length).toBeGreaterThan(0)
    expect(source.BLOCKED_BUILTINS).toContain('fs')
    expect(source.BLOCKED_BUILTINS).toContain('child_process')
    expect(source.BLOCKED_BUILTINS).toContain('module')
    expect(source.BLOCKED_BUILTINS).toContain('cluster')
    expect(source.BLOCKED_BUILTINS).toContain('dgram')
    expect(source.BLOCKED_BUILTINS).toContain('dns')
    expect(source.BLOCKED_BUILTINS).toContain('net')
  })

  it('D3 基线形态：16 项（os 移出）+ 永久封禁 7 项恒在基线', () => {
    const requireFromTest = createRequire(import.meta.url)
    const source = requireFromTest(BLOCKED_BUILTINS_SOURCE) as {
      BLOCKED_BUILTINS: readonly string[]
      PERMANENTLY_BLOCKED_BUILTINS: readonly string[]
    }
    // provider-plugin-access D3：os 移出基线（17 → 16）——os 免声明可用是
    // fs.read-user-data 落地的前提（拼 IDE 配置路径需要 homedir()）
    expect(source.BLOCKED_BUILTINS).toHaveLength(16)
    expect(source.BLOCKED_BUILTINS).not.toContain('os')
    // 永久封禁 7 项（vm/worker_threads/module/cluster/dgram/readline/v8）任何
    // 能力词都不可放行——恒在基线
    expect(source.PERMANENTLY_BLOCKED_BUILTINS).toEqual([
      'cluster',
      'dgram',
      'readline',
      'v8',
      'vm',
      'worker_threads',
      'module',
    ])
    for (const name of source.PERMANENTLY_BLOCKED_BUILTINS) {
      expect(source.BLOCKED_BUILTINS, name).toContain(name)
    }
  })

  it('D3 放行计算：allowed 与基线交集放行；永久封禁对 allowed 免疫', () => {
    const requireFromTest = createRequire(import.meta.url)
    const source = requireFromTest(BLOCKED_BUILTINS_SOURCE) as {
      BLOCKED_BUILTINS: readonly string[]
      PERMANENTLY_BLOCKED_BUILTINS: readonly string[]
      computeBlockedBuiltins: (allowed: readonly string[] | unknown) => readonly string[]
    }
    const { computeBlockedBuiltins, BLOCKED_BUILTINS, PERMANENTLY_BLOCKED_BUILTINS } = source

    // 空放行 = 基线原样（无能力声明插件的 fail-closed 缺省）
    expect(computeBlockedBuiltins([])).toEqual([...BLOCKED_BUILTINS])
    expect(computeBlockedBuiltins(undefined)).toEqual([...BLOCKED_BUILTINS])

    // network.http 全集放行后：5 个网络模块移出黑名单，其余基线保持
    const httpAllowed = ['http', 'https', 'net', 'dns', 'tls']
    const afterHttp = computeBlockedBuiltins(httpAllowed)
    for (const name of httpAllowed) expect(afterHttp, name).not.toContain(name)
    expect(afterHttp).toContain('fs')
    expect(afterHttp).toContain('child_process')
    expect(afterHttp).toHaveLength(16 - httpAllowed.length)

    // 永久封禁免疫：allowed 注入 'vm' 也不放行（防 env 注入错误 / 词表演进误入）
    expect(computeBlockedBuiltins(['vm'])).toContain('vm')
    expect(computeBlockedBuiltins([...PERMANENTLY_BLOCKED_BUILTINS])).toEqual(
      expect.arrayContaining([...PERMANENTLY_BLOCKED_BUILTINS]),
    )
    // 全部可放行项（基线 − 永久封禁）声明后：黑名单只剩永久封禁 7 项
    const allReleasable = BLOCKED_BUILTINS.filter((n) => !PERMANENTLY_BLOCKED_BUILTINS.includes(n))
    expect(computeBlockedBuiltins(allReleasable)).toEqual([...PERMANENTLY_BLOCKED_BUILTINS])
  })

  it('D3 词表对账：shared 能力词映射的放行集并集 = 基线可放行项（9 项，两侧不漂移）', async () => {
    const requireFromTest = createRequire(import.meta.url)
    const source = requireFromTest(BLOCKED_BUILTINS_SOURCE) as {
      BLOCKED_BUILTINS: readonly string[]
      PERMANENTLY_BLOCKED_BUILTINS: readonly string[]
    }
    const { resolveAllowedModules, PLUGIN_CAPABILITIES } = await import(
      '@taiji/shared/plugin-capability-map'
    )
    const releasable = source.BLOCKED_BUILTINS.filter(
      (n) => !source.PERMANENTLY_BLOCKED_BUILTINS.includes(n),
    )
    const fromCapabilityMap = resolveAllowedModules([...PLUGIN_CAPABILITIES]).allowed
    expect([...fromCapabilityMap].sort()).toEqual([...releasable].sort())
  })

  it('ESM loader 消费同一数据源（源码含 require 引用，防回退为内联数组）', () => {
    const loaderSrc = readFileSync(LOADER_PATH, 'utf-8')
    expect(loaderSrc).toContain("require('./plugin-blocked-builtins.cjs')")
  })
})

// D6 B3 恢复（原 S-36 describe 内的 F1-9 接线用例，8a4439914 连带删除）：真实
// initSandbox 消费 TAIJI_PLUGIN_ALLOWED_MODULES env（宿主 buildPluginCapabilityForkEnv
// 注入形态）→ 声明 network.http 后 CJS require('https') 放行、require('fs') 未声明拒
// （CJS 通道 fs 系只走只读代理放行）、require('vm') 永久拒。initSandbox 修改全局
// process.env / Module._resolveFilename / Module._load，必须 fork 调用（进程退出即丢弃污染）。
describe.skipIf(!INTEGRATION_TESTS_ENABLED)(`F1-9: CJS 通道能力词表 fork 级接线${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ''}`, () => {
  const PLUGIN_BOOTSTRAP_TS = join(__dirname, '../src/services/plugin-service/plugin-bootstrap.ts')
  const RUNTIME_ROOT = join(__dirname, '..')

  it('initSandbox 读 TAIJI_PLUGIN_ALLOWED_MODULES → https 放行 / fs / vm 拒', async () => {
    const tsxTsconfig = createTsxPathsTsconfig()
    try {
      const workDir = mkdtempSync(join(tmpdir(), 'f19-cjs-cap-'))
      const pluginDir = join(workDir, 'plugin')
      mkdirSync(pluginDir)
      const fixturePath = join(workDir, 'fixture.cjs')
      writeFileSync(
        fixturePath,
        [
          "'use strict'",
          '// F1-9 fixture：initSandbox（env 已注入放行清单）→ 逐模块 try require 回传结果',
          `const { initSandbox } = require(${JSON.stringify(PLUGIN_BOOTSTRAP_TS)})`,
          `initSandbox(${JSON.stringify(pluginDir)})`,
          'const tryRequire = (name) => {',
          '  try { require(name); return "ok" }',
          '  catch (e) { return e && e.code === "PERMISSION_DENIED" ? "PERMISSION_DENIED" : "other:" + String(e && e.code) }',
          '}',
          'process.stdout.write("F19_RESULT:" + JSON.stringify({',
          '  https: tryRequire("https"),',
          '  fs: tryRequire("fs"),',
          '  vm: tryRequire("vm"),',
          '  os: tryRequire("os"),',
          '}))',
          '',
        ].join('\n'),
      )

      const result = await new Promise<Record<string, string>>((resolveP, reject) => {
        const child = fork(fixturePath, [], {
          execPath: process.execPath,
          execArgv: ['--import', 'tsx'],
          cwd: RUNTIME_ROOT,
          env: {
            ...process.env,
            TSX_TSCONFIG_PATH: tsxTsconfig.tsconfigPath,
            // 宿主注入形态：JSON 数组字符串（buildPluginCapabilityForkEnv 编码）
            TAIJI_PLUGIN_ALLOWED_MODULES: JSON.stringify(['http', 'https', 'net', 'dns', 'tls']),
          },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        })
        let stdout = ''
        let stderr = ''
        child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
        child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
        child.on('error', reject)
        child.on('close', (code) => {
          const line = stdout.split('\n').find((l) => l.startsWith('F19_RESULT:'))
          if (code !== 0 || !line) {
            reject(new Error(`fixture exited ${code}. stdout=${stdout} stderr=${stderr}`))
            return
          }
          try {
            resolveP(JSON.parse(line.slice('F19_RESULT:'.length)) as Record<string, string>)
          } catch (e) {
            reject(new Error(`fixture result parse failed: ${(e as Error).message}`))
          }
        })
      })
      rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })

      expect(result.https).toBe('ok')
      expect(result.fs).toBe('PERMISSION_DENIED')
      expect(result.vm).toBe('PERMISSION_DENIED')
      expect(result.os).toBe('ok')
    } finally {
      tsxTsconfig.dispose()
    }
  }, 30_000)
})

// F1-24（2026-10-24 裁决落地）：CJS 通道 fs.read-user-data 真进程正反例。声明能力
// 的插件 require('fs') / require('fs/promises') 拿到只读代理对象（读白名单成功 /
// 白名单外拒 / 写改 API 拒 / open 写 flags 拒 / FileHandle 写方法拒 / promises 面同
// 语义）；未声明的对照插件 require('fs') 直接 PERMISSION_DENIED（fail-closed）。
// fixture 与 F1-9 同形态：隔离子进程 require 真实 plugin-bootstrap.ts 调 initSandbox
// （全局污染随进程退出丢弃）。判定本质 = 拦截器 + Module._load patch + fs 代理对象
// 在真实子进程链路下的组合行为，无进程内完成信号可等，本地默认跳过（e2e-map 规则
// 按 on-diff 触发）；判定面已由 plugin-esm-loader.test.ts 的 buildProxyObject 组与
// plugin-sandbox.test.ts 的两态组在 in-process 层覆盖。
describe.skipIf(!INTEGRATION_TESTS_ENABLED)(`F1-24: CJS 通道 fs 只读代理 fork 级接线${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ''}`, () => {
  const PLUGIN_BOOTSTRAP_TS = join(__dirname, '../src/services/plugin-service/plugin-bootstrap.ts')
  const RUNTIME_ROOT = join(__dirname, '..')

  /** 组装 fixture 源码（公共壳：先捕获目标路径 env → initSandbox → body 判定 → stdout 回传） */
  function buildF124Fixture(pluginDir: string, body: string): string {
    return [
      "'use strict'",
      `const { initSandbox } = require(${JSON.stringify(PLUGIN_BOOTSTRAP_TS)})`,
      '// initSandbox 会把 process.env 换成空 Proxy——目标路径必须在调用前捕获',
      'const TARGET = process.env.TAIJI_F124_TARGET',
      'const OUTSIDE = process.env.TAIJI_F124_OUTSIDE',
      `initSandbox(${JSON.stringify(pluginDir)})`,
      ';(async () => {',
      body,
      '})().catch((e) => {',
      "  process.stdout.write('F124_RESULT:' + JSON.stringify({ fatal: String((e && e.stack) || e) }))",
      '})',
      '',
    ].join('\n')
  }

  /**
   * fork 隔离子进程跑 fixture（tsx 装配 + 临时目录自建自删），解析 F124_RESULT 行。
   * setup（可选）在临时家目录内播种文件并返回 fork env（HOME / 能力 env / 目标路径——
   * 目标路径依赖 homeDir 实际值，故 env 在播种后构建）。
   */
  async function runF124(
    fixtureBody: string,
    setup?: (homeDir: string) => Record<string, string>,
  ): Promise<Record<string, string>> {
    const tsxTsconfig = createTsxPathsTsconfig()
    let workDir = ''
    let homeDir = ''
    let forkEnv: Record<string, string> = {}
    try {
      workDir = mkdtempSync(join(tmpdir(), 'f124-cjs-proxy-'))
      const pluginDir = join(workDir, 'plugin')
      mkdirSync(pluginDir)
      const fixturePath = join(workDir, 'fixture.cjs')
      writeFileSync(fixturePath, buildF124Fixture(pluginDir, fixtureBody))
      if (setup) {
        homeDir = mkdtempSync(join(tmpdir(), 'f124-home-'))
        forkEnv = setup(homeDir)
      }
      return await new Promise<Record<string, string>>((resolveP, reject) => {
        const child = fork(fixturePath, [], {
          execPath: process.execPath,
          execArgv: ['--import', 'tsx'],
          cwd: RUNTIME_ROOT,
          env: {
            ...process.env,
            TSX_TSCONFIG_PATH: tsxTsconfig.tsconfigPath,
            ...forkEnv,
          },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        })
        let stdout = ''
        let stderr = ''
        child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
        child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
        child.on('error', reject)
        child.on('close', (code) => {
          const line = stdout.split('\n').find((l) => l.startsWith('F124_RESULT:'))
          if (code !== 0 || !line) {
            reject(new Error(`fixture exited ${code}. stdout=${stdout} stderr=${stderr}`))
            return
          }
          try {
            resolveP(JSON.parse(line.slice('F124_RESULT:'.length)) as Record<string, string>)
          } catch (e) {
            reject(new Error(`fixture result parse failed: ${(e as Error).message}`))
          }
        })
      })
    } finally {
      tsxTsconfig.dispose()
      if (workDir) rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      if (homeDir) rmSync(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  }

  it("声明 fs.read-user-data → require('fs') / require('fs/promises') 为只读代理（读白名单成 / 白名单外拒 / 写改与写 flags 拒 / FileHandle 写拒）", async () => {
    const body = [
      'const out = {}',
      "const resultOf = (fn) => { try { return fn() } catch (e) { return (e && e.code) || 'ERR' } }",
      "const fs = require('fs')",
      'out.insideRead = resultOf(() => fs.readFileSync(TARGET, "utf-8"))',
      'out.outsideRead = resultOf(() => fs.readFileSync(OUTSIDE, "utf-8"))',
      'out.writeFileSync = resultOf(() => fs.writeFileSync(TARGET, "x"))',
      'out.openWriteFlags = resultOf(() => { const fd = fs.openSync(TARGET, "w"); fs.closeSync(fd) })',
      'out.openReadFlagsRead = resultOf(() => {',
      '  const fd = fs.openSync(TARGET, "r")',
      '  const buf = Buffer.alloc(14)',
      '  const bytes = fs.readSync(fd, buf, 0, 14, 0)',
      '  fs.closeSync(fd)',
      '  return buf.toString("utf-8", 0, bytes)',
      '})',
      "const fsp = require('fs/promises')",
      "out.promisesRead = await fsp.readFile(TARGET, 'utf-8').then((v) => v, (e) => (e && e.code) || 'ERR')",
      "out.promisesWrite = await fsp.writeFile(TARGET, 'x').then(() => 'LEAKED', (e) => (e && e.code) || 'ERR')",
      "out.handleWrite = await fsp.open(TARGET, 'r').then(async (h) => {",
      '  try {',
      "    await h.write('x')",
      "    return 'LEAKED'",
      '  } catch (e) {',
      "    return (e && e.code) || 'ERR'",
      '  } finally {',
      '    await h.close()',
      '  }',
      "}, (e) => 'OPEN_FAILED:' + ((e && e.code) || 'ERR'))",
      "process.stdout.write('F124_RESULT:' + JSON.stringify(out))",
    ].join('\n')
    // readPaths 家目录相对语义（'data/in.txt'）经 HOME 注入临时家目录（initSandbox
    // 的 fsGuard.configure 经 os.homedir() 推导），与 P-perm 门控组同款约束
    const result = await runF124(body, (homeDir) => {
      mkdirSync(join(homeDir, 'data'), { recursive: true })
      writeFileSync(join(homeDir, 'data', 'in.txt'), 'inside-content')
      writeFileSync(join(homeDir, 'data', 'out.txt'), 'outside-content')
      return {
        HOME: homeDir,
        TAIJI_PLUGIN_ALLOWED_MODULES: JSON.stringify(['fs', 'fs/promises']),
        TAIJI_PLUGIN_READ_PATHS: JSON.stringify(['data/in.txt']),
        TAIJI_F124_TARGET: join(homeDir, 'data', 'in.txt'),
        TAIJI_F124_OUTSIDE: join(homeDir, 'data', 'out.txt'),
      }
    })

    expect(result.insideRead).toBe('inside-content')
    expect(result.outsideRead).toBe('PERMISSION_DENIED')
    expect(result.writeFileSync).toBe('PERMISSION_DENIED')
    expect(result.openWriteFlags).toBe('PERMISSION_DENIED')
    // fd 族读 API（fd 只能来自受 flags 检查的 open）
    expect(result.openReadFlagsRead).toBe('inside-content')
    expect(result.promisesRead).toBe('inside-content')
    expect(result.promisesWrite).toBe('PERMISSION_DENIED')
    expect(result.handleWrite).toBe('PERMISSION_DENIED')
    expect(JSON.stringify(result)).not.toContain('LEAKED')
  }, 30_000)

  it("未声明能力的对照插件 → require('fs') / require('fs/promises') 直接 PERMISSION_DENIED（fail-closed）；os 免声明不误伤", async () => {
    const body = [
      'const out = {}',
      "try { require('fs'); out.fs = 'LEAKED' } catch (e) { out.fs = (e && e.code) || 'ERR' }",
      "try { require('fs/promises'); out.fsPromises = 'LEAKED' } catch (e) { out.fsPromises = (e && e.code) || 'ERR' }",
      "try { require('os'); out.os = 'ok' } catch (e) { out.os = (e && e.code) || 'ERR' }",
      "process.stdout.write('F124_RESULT:' + JSON.stringify(out))",
    ].join('\n')
    const result = await runF124(body, (homeDir) => ({
      HOME: homeDir,
      TAIJI_PLUGIN_ALLOWED_MODULES: JSON.stringify([]),
      TAIJI_PLUGIN_READ_PATHS: JSON.stringify([]),
    }))
    expect(result.fs).toBe('PERMISSION_DENIED')
    expect(result.fsPromises).toBe('PERMISSION_DENIED')
    expect(result.os).toBe('ok')
  }, 30_000)
})
