import { describe, it, expect, afterEach } from 'vitest'
import { fork, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

/**
 * plugin-esm-loader.cjs 集成测试：真实 fork 子进程 + --import 注入 loader，
 * 断言 node: 前缀/裸内置名/路径边界三类拦截（TC1-TC6）。
 * loader 用源文件（纯 cjs，无构建依赖）；插件测试文件写到 tmp pluginDir（.mjs 强制 ESM）。
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const LOADER_PATH = join(__dirname, '..', 'plugin-esm-loader.cjs')
const FIXTURE_PATH = join(__dirname, 'fixtures', 'esm-loader-fixture.cjs')

const TIMEOUT_MS = 15_000

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

describe('plugin-esm-loader sandbox interception', () => {
  let pluginDir = ''

  afterEach(() => {
    if (pluginDir) rmSync(pluginDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  function setupSandbox(): void {
    pluginDir = mkdtempSync(join(tmpdir(), 'esm-loader-plugin-'))
    // 插件测试文件（pluginDir 内）：内部 import 触发 loader 拦截
    writeFileSync(join(pluginDir, 'good.mjs'), 'export const value = 42\n')
    writeFileSync(join(pluginDir, 'inner-import.mjs'), "import './good.mjs'\nexport const ok = true\n")
    writeFileSync(join(pluginDir, 'bad-builtin.mjs'), "import 'node:fs'\n")
    writeFileSync(join(pluginDir, 'bad-module.mjs'), "import 'node:module'\n")
    writeFileSync(join(pluginDir, 'bad-bare.mjs'), "import 'fs'\n")
    writeFileSync(join(pluginDir, 'bad-outside.mjs'), "import '../outside.mjs'\n")
    // 出界目标放 pluginDir 父目录（../outside.mjs 解析目标），保证拦截因边界而非文件缺失
    writeFileSync(join(dirname(pluginDir), 'outside.mjs'), 'export const value = 1\n')
  }

  function pluginFile(name: string): string {
    return pathToFileURL(join(pluginDir, name)).href
  }

  it('TC1: node: 前缀内置模块被拦截（node:fs → PERMISSION_DENIED）', async () => {
    setupSandbox()
    const results = await runImports({ TAIJI_PLUGIN_SANDBOX_DIR: pluginDir }, [
      { label: 'bad-builtin', url: pluginFile('bad-builtin.mjs') },
    ])
    expect(results[0].ok).toBe(false)
    expect(results[0].error).toContain('PERMISSION_DENIED')
  }, TIMEOUT_MS)

  it('TC2: 安全内置模块放行（node:path / node:util）', async () => {
    setupSandbox()
    // node:path 等安全模块不被拦：插件文件内部 import 验证
    writeFileSync(join(pluginDir, 'safe-builtin.mjs'), "import 'node:path'\nimport 'node:util'\nexport const ok = true\n")
    const results = await runImports({ TAIJI_PLUGIN_SANDBOX_DIR: pluginDir }, [
      { label: 'safe-builtin', url: pluginFile('safe-builtin.mjs') },
    ])
    expect(results[0].ok).toBe(true)
  }, TIMEOUT_MS)

  it('TC3: 相对路径出界被拦截（resolve 后不在 pluginDir 内）', async () => {
    setupSandbox()
    const results = await runImports({ TAIJI_PLUGIN_SANDBOX_DIR: pluginDir }, [
      { label: 'bad-outside', url: pluginFile('bad-outside.mjs') },
    ])
    expect(results[0].ok).toBe(false)
    expect(results[0].error).toContain('PERMISSION_DENIED')
  }, TIMEOUT_MS)

  it('TC4: pluginDir 内相对 import 放行', async () => {
    setupSandbox()
    const results = await runImports({ TAIJI_PLUGIN_SANDBOX_DIR: pluginDir }, [
      { label: 'inner-import', url: pluginFile('inner-import.mjs') },
    ])
    expect(results[0].ok).toBe(true)
  }, TIMEOUT_MS)

  it('TC5: 裸内置名被拦截（import("fs") 无 node: 前缀）', async () => {
    setupSandbox()
    const results = await runImports({ TAIJI_PLUGIN_SANDBOX_DIR: pluginDir }, [
      { label: 'bad-bare', url: pluginFile('bad-bare.mjs') },
    ])
    expect(results[0].ok).toBe(false)
    expect(results[0].error).toContain('PERMISSION_DENIED')
  }, TIMEOUT_MS)

  it('TC6: env 缺失 fail-closed（loader initialize throw → 子进程启动失败）', async () => {
    const child = fork(FIXTURE_PATH, [], {
      execArgv: ['--import', LOADER_PATH],
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    const exitPromise = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code))
      child.on('error', () => resolve(null))
    })
    // 不给 run 消息——loader initialize 阶段即失败，进程不会进入消息循环
    const code = await exitPromise
    expect(code).not.toBe(0)
  }, TIMEOUT_MS)

  it('TC8: node:module 被拦截（createRequire 绕过链第一环，M6a-01）', async () => {
    setupSandbox()
    const results = await runImports({ TAIJI_PLUGIN_SANDBOX_DIR: pluginDir }, [
      { label: 'bad-module', url: pluginFile('bad-module.mjs') },
    ])
    expect(results[0].ok).toBe(false)
    expect(results[0].error).toContain('PERMISSION_DENIED')
  }, TIMEOUT_MS)

  it('TC9: data:/blob: URL 沙箱逃逸被拦截（MF-1：插件代码 import 非 file:// 非 npm 裸名 scheme 一律拒绝）', async () => {
    setupSandbox()
    // 插件代码 import data: URL —— MF-1 逃逸向量：
    // data: 模块内的 node: import，parentURL 为 data: URL（非 file://）→ isInsideSandbox 短路 → 黑名单绕过。
    // 修复后插件代码发起的 data:/blob:/http: 等 import 在 resolve 阶段即被拒绝。
    writeFileSync(
      join(pluginDir, 'bad-data.mjs'),
      "import 'data:text/javascript,export const x=1'\n",
    )
    const results = await runImports({ TAIJI_PLUGIN_SANDBOX_DIR: pluginDir }, [
      { label: 'bad-data', url: pluginFile('bad-data.mjs') },
    ])
    expect(results[0].ok).toBe(false)
    expect(results[0].error).toContain('PERMISSION_DENIED')
  }, TIMEOUT_MS)

  it('TC7: loader 源文件结构正确（hooks 导出 + self-register + realpath 规范化）', () => {
    // 对应 TC7（打包验证的源文件层检查）：hooks 先赋值后 self-register 是
    // resolve 生效的前提，realpath 规范化修复 macOS /var→/private/var 失配。
    // 不 require 该模块（self-register 会污染 vitest 的 ESM loader），读源断言。
    const src = readFileSync(LOADER_PATH, 'utf-8')
    expect(src).toContain('module.exports = { initialize, resolve }')
    expect(src).toContain('register(pathToFileURL(__filename).href)')
    expect(src).toContain('realpathSync')
  })
})
