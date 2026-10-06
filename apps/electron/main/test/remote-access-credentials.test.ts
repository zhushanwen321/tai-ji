/**
 * remote-access spawn 凭据链单测（S1-W1 token 双通道）。
 *
 * 覆盖 spawnRuntimeProcess 全链的 token 凭据分发（argv 侧 --remote-access flag
 * 见 remote-access-spawn-args.test.ts，本文件只管凭据侧）：
 * - env 通道：spawn env 注入 TAIJI_RUNTIME_TOKEN，64 位 hex（32 字节随机值）；
 * - 文件通道：issueRuntimeToken 落盘 <dataDir>/runtime-token（0600），内容与 env 值
 *   一致（CLI / 脚本消费通道与 runtime 自身消费同一 token）；
 * - 轮换语义：每次 spawn 重新生成 token（旧 token 随旧进程死亡），文件跟随更新为
 *   最新一次 spawn 的 token。
 *
 * Mock 策略（对齐 remote-access-spawn-args.test.ts 全链 describe）：mock electron +
 * node:child_process + node:fs.existsSync；配置走真实 readRemoteAccessConfig + 真实
 * seed 文件（spawn 时刻现读语义）；数据目录经 TAIJI_AGENT_DATA_DIR 注入 mkdtemp tmp
 * 自建自删（红线：禁触真实数据目录）。
 *
 * 运行：cd apps/electron/main && npx vitest run test/remote-access-credentials.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REMOTE_ACCESS_FILENAME } from '@taiji/shared'

const spawnMock = vi.hoisted(() => vi.fn())

const electronMock = vi.hoisted(() => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/fake/app-path',
    getVersion: () => '0.0.0-test',
  },
}))

vi.mock('electron', () => ({ app: electronMock.app }))

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  execFileSync: vi.fn(() => ''),
}))

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: vi.fn(() => true),
}))

vi.mock('../logs/main-logger.js', () => ({
  mainLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  readMainLogMaxBytes: vi.fn(() => 50 * 1024 * 1024),
  initMainLogger: vi.fn(),
  closeMainLogger: vi.fn(async () => undefined),
}))

// 动态 import：确保 mock 先于模块加载生效
async function loadModule() {
  return await import('../supervisor/process-control.js')
}

describe('spawnRuntimeProcess 凭据链（token 双通道：env + runtime-token 文件）', () => {
  let tmpDataDir: string
  let originalResourcesPath: PropertyDescriptor | undefined
  let logSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpDataDir = mkdtempSync(join(tmpdir(), 'remote-access-credentials-'))
    // issueRuntimeToken 落盘与 readRemoteAccessConfig 现读都走 getDataDir()：
    // 钉 env 到 tmp，禁触真实数据目录
    process.env.TAIJI_AGENT_DATA_DIR = tmpDataDir
    // prod 分支 resources 路径推导依赖该属性（Electron 注入，Node 测试环境缺省）
    originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    Object.defineProperty(process, 'resourcesPath', { value: '/res', configurable: true })
    electronMock.app.isPackaged = true
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => ({
      on: vi.fn(),
      killed: false,
      exitCode: null,
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
    }))
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    if (originalResourcesPath) {
      Object.defineProperty(process, 'resourcesPath', originalResourcesPath)
    } else {
      // 测试环境原本无该属性（Node 无 Electron 注入），删除恢复原状
      delete (process as unknown as Record<string, unknown>).resourcesPath
    }
    electronMock.app.isPackaged = false
    delete process.env.TAIJI_AGENT_DATA_DIR
    rmSync(tmpDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    logSpy.mockRestore()
    errorSpy.mockRestore()
  })

  /** 向指定数据目录写开态 remote-access.json（凭据链测试夹具，token 值与凭据断言无关）。 */
  function seedEnabledConfig(dataDir: string): void {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(
      join(dataDir, REMOTE_ACCESS_FILENAME),
      JSON.stringify({ enabled: true, token: 'b'.repeat(64), createdAt: '2026-01-01T00:00:00.000Z' }),
      'utf-8',
    )
  }

  /** 读取第 callIndex 次 spawn（0 起）options（第 3 参）env 中注入的 TAIJI_RUNTIME_TOKEN（无值时断言失败可读）。 */
  function spawnEnvToken(callIndex = 0): string {
    const options = spawnMock.mock.calls[callIndex][2] as { env: NodeJS.ProcessEnv }
    const token = options.env.TAIJI_RUNTIME_TOKEN
    expect(token, 'spawn env 必须注入 TAIJI_RUNTIME_TOKEN').toBeTruthy()
    return token as string
  }

  it('开态 spawn：env 注入 64 位 hex token，runtime-token 文件 0600 落盘且内容与 env 一致', async () => {
    seedEnabledConfig(tmpDataDir)
    const tokenFile = join(tmpDataDir, 'runtime-token')
    const { spawnRuntimeProcess } = await loadModule()

    spawnRuntimeProcess(45680, () => {})

    const envToken = spawnEnvToken()
    expect(envToken).toMatch(/^[0-9a-f]{64}$/)
    // 文件通道：同一 token 落盘 <dataDir>/runtime-token（CLI / 脚本消费通道）
    expect(existsSync(tokenFile)).toBe(true)
    expect(readFileSync(tokenFile, 'utf-8')).toBe(envToken)
    // token 等同 WS 凭据，禁 group/other 读取（win32 无 POSIX mode 语义）
    if (process.platform !== 'win32') {
      expect(statSync(tokenFile).mode & 0o777).toBe(0o600)
    }
  })

  it('两次 spawn 轮换：token 重新生成，runtime-token 文件跟随更新为最新值', async () => {
    seedEnabledConfig(tmpDataDir)
    const tokenFile = join(tmpDataDir, 'runtime-token')
    const { spawnRuntimeProcess } = await loadModule()

    spawnRuntimeProcess(45681, () => {})
    const firstToken = spawnEnvToken(0)

    spawnRuntimeProcess(45682, () => {})
    const secondToken = spawnEnvToken(1)

    // 轮换语义：每次 spawn 新 token（旧 token 随旧进程死亡），两次不重复
    expect(firstToken).toMatch(/^[0-9a-f]{64}$/)
    expect(secondToken).toMatch(/^[0-9a-f]{64}$/)
    expect(secondToken).not.toBe(firstToken)
    // 文件通道跟随更新：落盘内容 = 最新一次 spawn 的 token（非首次残留）
    expect(readFileSync(tokenFile, 'utf-8')).toBe(secondToken)
  })
})
