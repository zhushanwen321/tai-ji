/**
 * electron-runtime-stderr.log main 侧 size 轮转单测（u5a 验收：
 * D6-⑦「固定名 stderr 文件治理唯一归 writer 侧 size 轮转」——writer 是 main）。
 *
 * 覆盖：
 * - 超帽触发轮转：旧数据落 `.1`，rename 后新 stderr 续写**新主文件**（append fd 重建
 *   在 rename 之后——无孤儿 inode，A9②「轮转不打断写方」的单元级形态）
 * - 未超帽不轮转
 * - 非打包（dev）不建 sink（写入 no-op）
 *
 * Mock 策略：electron app.isPackaged=true + node:child_process.spawn（不 spawn 真实
 * runtime）；runtimeDist 用真实 fixture 文件满足 existsSync 校验。node:fs 走全局
 * fs-guard（本文件不叠加 vi.mock node:fs——guard 白名单 tmp 放行，见 vitest.config）。
 *
 * 运行：cd apps/electron/main && npx vitest run logs/__tests__/stderr-sink-rotation.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// electron mock：app.isPackaged 可变（非打包 no-op 用例切换），工厂经 getter 读取。
// getAppPath 返回真实 apps/electron 目录（本文件位于 main/logs/__tests__/，上三级）：
// dev 分支的 require.resolve('tsx/package.json', { paths: [projectRoot] }) 依赖真实包布局可解析。
import { fileURLToPath } from 'node:url'
const ELECTRON_APP_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const electronState = vi.hoisted(() => ({ isPackaged: true }))
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return electronState.isPackaged
    },
    getAppPath: () => ELECTRON_APP_ROOT,
    getVersion: () => '0.0.0-test',
  },
}))

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  execFileSync: vi.fn(),
}))

/** spawnRuntimeProcess 的 child 依赖面：EventEmitter + stdout/stderr + kill。 */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false
  pid = 4242
  kill = vi.fn(() => true)
}

describe('electron-runtime-stderr.log size rotation', () => {
  let tmpDir: string
  let logsDir: string
  const ENV_KEYS = ['TAIJI_AGENT_DATA_DIR', 'TAIJI_LOG_MAX_BYTES'] as const
  let savedEnv: Record<string, string | undefined>
  /** 打包分支 spawnRuntimeProcess 读全局 process.resourcesPath（不可 mock，临时赋值）。 */
  let savedResourcesPath: string | undefined

  async function loadModule() {
    return await import('../../supervisor/process-control.js')
  }

  beforeEach(() => {
    vi.resetModules()
    tmpDir = mkdtempSync(join(tmpdir(), 'stderr-rotation-test-'))
    logsDir = join(tmpDir, 'logs')
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
    process.env.TAIJI_AGENT_DATA_DIR = tmpDir
    process.env.TAIJI_LOG_MAX_BYTES = '400'
    electronState.isPackaged = true
    // 打包分支 runtimeDist = <resourcesPath>/app.asar.unpacked/dist/runtime/index.cjs，
    // 预建真实占位文件满足 existsSync（不 mock fs，保住全局 fs-guard 防线）
    savedResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    const runtimeDist = join(tmpDir, 'app.asar.unpacked', 'dist', 'runtime', 'index.cjs')
    mkdirSync(join(runtimeDist, '..'), { recursive: true })
    writeFileSync(runtimeDist, '// fixture stub')
    ;(process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = tmpDir
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => new FakeChild())
  })

  afterEach(async () => {
    // 清理模块级 sink 单例（flush 等落盘），防跨测试串扰与 rm 在途 flush 竞争
    try {
      const mod = await loadModule()
      await mod.flushStderrSink()
    } catch { /* 模块未加载场景 no-op */ }
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    // @types/node 的 Process.resourcesPath 标为必选 string（Electron 才有值），恢复按可选处理
    const proc = process as unknown as { resourcesPath?: string }
    if (savedResourcesPath === undefined) delete proc.resourcesPath
    else proc.resourcesPath = savedResourcesPath
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** spawnRuntimeProcess 返回类型断言（child 实为 FakeChild mock；直断言类型不重叠须过 unknown）。 */
  function childOf(result: { child: unknown }): FakeChild {
    return result.child as FakeChild
  }

  /** 轮询等待 predicate 为真（写流/轮转是异步链，固定 sleep 满载下不可靠）。 */
  async function waitFor(predicate: () => boolean, label: string, deadlineMs = 5000): Promise<void> {
    const deadline = performance.now() + deadlineMs
    while (!predicate()) {
      if (performance.now() >= deadline) {
        const files = (() => { try { return readdirSync(logsDir).join(',') } catch { return '(no logs dir)' } })()
        throw new Error(`waitFor timeout: ${label}; files: ${files}`)
      }
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  /**
   * 负向轮询：宽限窗口内「文件出现」一旦成立立即失败。负向断言（无产物）无法 waitFor
   * 条件为真，只能有界宽限——若 sink 被误建，写链产物在正向用例 25ms 步进首两拍内即可
   * 观察到，50ms 宽限 = 2× 余量（替换原固定 100ms sleep：提前失败 + 同等覆盖）。
   */
  async function waitForAbsence(exists: () => boolean, label: string, graceMs = 50): Promise<void> {
    const deadline = performance.now() + graceMs
    while (performance.now() < deadline) {
      if (exists()) throw new Error(`waitForAbsence: ${label} unexpectedly appeared`)
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  /** emit 一条可定位的 stderr chunk（内容含 chunk-N 标记）。 */
  function emitChunk(child: FakeChild, n: number): void {
    child.stderr.emit('data', Buffer.from(`chunk-${n}-${'x'.repeat(110)}`))
  }

  it('超帽触发轮转：旧数据落 .1，rename 后新 stderr 续写新主文件（fd 重建无孤儿 inode）', async () => {
    const mod = await loadModule()
    const child = childOf(mod.spawnRuntimeProcess(3210))

    // 帽 400B，每 chunk ~118B：chunk-4 写入前预测累计 472B 超帽 → 触发轮转（chunk-3/4 计入轮转窗口）
    emitChunk(child, 1)
    emitChunk(child, 2)
    emitChunk(child, 3)
    emitChunk(child, 4)
    const rolled = join(logsDir, 'electron-runtime-stderr.log.1')
    await waitFor(() => existsSync(rolled), 'rotation .1 file created')
    // rename 完成后轮转 promise 尚有微任务尾（finally 解除 suspend）——留一拍宏任务
    await new Promise((r) => setImmediate(r))

    const rolledContent = readFileSync(rolled, 'utf-8')
    expect(rolledContent).toContain('chunk-1')
    expect(rolledContent).toContain('chunk-2')

    // 轮转后写入：append fd 重建落新主文件（验收条款「轮转后 writer 继续写新文件」）
    child.stderr.emit('data', Buffer.from('final-marker-chunk'))
    const mainFile = join(logsDir, 'electron-runtime-stderr.log')
    await waitFor(() => existsSync(mainFile) && readFileSync(mainFile, 'utf-8').includes('final-marker-chunk'), 'post-rotation write lands in fresh main file')
    expect(readFileSync(mainFile, 'utf-8')).not.toContain('chunk-1')
    expect(rolledContent).not.toContain('final-marker-chunk')
  })

  it('未超帽不轮转：两 chunk 落主文件，无 .1 产物', async () => {
    const mod = await loadModule()
    const child = childOf(mod.spawnRuntimeProcess(3211))
    emitChunk(child, 1)
    emitChunk(child, 2)
    // 轮询等两 chunk 落盘（写链异步，固定 sleep 满载下不可靠——waitFor docstring 同述）
    const mainFile = join(logsDir, 'electron-runtime-stderr.log')
    await waitFor(() => {
      if (!existsSync(mainFile)) return false
      const content = readFileSync(mainFile, 'utf-8')
      return content.includes('chunk-1') && content.includes('chunk-2')
    }, 'both chunks land in main file')
    expect(existsSync(mainFile)).toBe(true)
    const content = readFileSync(mainFile, 'utf-8')
    expect(content).toContain('chunk-1')
    expect(content).toContain('chunk-2')
    expect(existsSync(join(logsDir, 'electron-runtime-stderr.log.1'))).toBe(false)
  })

  it('非打包（dev）不建 sink：emit data 后 logs 目录无 stderr 文件', async () => {
    electronState.isPackaged = false
    const mod = await loadModule()
    const child = childOf(mod.spawnRuntimeProcess(3212))
    emitChunk(child, 1)
    // 负向断言：宽限窗口内轮询「文件出现即提前失败」（waitForAbsence docstring 述依据）
    await waitForAbsence(() => existsSync(join(logsDir, 'electron-runtime-stderr.log')), 'dev sink should not exist')
    expect(existsSync(join(logsDir, 'electron-runtime-stderr.log'))).toBe(false)
  })
})
