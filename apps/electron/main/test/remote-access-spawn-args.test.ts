/**
 * remote-access supervisor 拼参单测（remote-access D3/D9）。
 *
 * 覆盖：
 * - buildRemoteAccessSpawnArgs 纯函数（enabled 经参数注入，无文件/环境依赖）：
 *   开态返回两 flag，dist 路径 dev/prod 分支正确；关态返回空数组（不拼任何 flag）；
 * - spawnRuntimeProcess 全链（打包分支）：关态 argv 与既有形态逐项一致（不含 remote
 *   flag）；开态 argv 尾部追加 --remote-access + --mobile-dist=<绝对路径>——该 describe
 *   走真实配置读取（spawn 时刻现读语义），保留 seed 基建；
 * - dist 缺失/读取失败路径不属于本单元（main 侧读配置失败按 E10 重建，见 store 测试；
 *   缺文件默认关态的读取侧语义亦在 store 测试 readRemoteAccessConfig describe）。
 *
 * Mock 策略（对齐 process-control.test.ts）：mock electron + node:child_process +
 * node:fs.existsSync（prod 分支 runtimeDist 存在性检查）；全链 describe 数据目录经
 * TAIJI_AGENT_DATA_DIR 注入 mkdtemp tmp 自建自删（红线：禁触真实数据目录）。
 * dev 分支全链不经 spawnRuntimeProcess 直测（require.resolve tsx 依赖真实包布局），
 * dev 路径正确性由 buildRemoteAccessSpawnArgs 纯函数用例覆盖（append 逻辑 dev/prod 共用）。
 *
 * 运行：cd apps/electron/main && npx vitest run test/remote-access-spawn-args.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
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

describe('buildRemoteAccessSpawnArgs（纯函数：dev/prod 分支路径）', () => {
  it('关态（enabled=false）→ 空数组，不拼任何 flag', async () => {
    const { buildRemoteAccessSpawnArgs } = await loadModule()
    expect(
      buildRemoteAccessSpawnArgs({ isPackaged: false, resourcesPath: '/res', appPath: '/fake/app-path' }, false),
    ).toEqual([])
  })

  it('开态 dev：--mobile-dist = <仓库根>/packages/mobile-renderer/dist', async () => {
    const { buildRemoteAccessSpawnArgs } = await loadModule()
    // appPath = apps/electron，仓库根相对其 ../..（与 process-control dev 分支 repoRoot 同构）
    expect(
      buildRemoteAccessSpawnArgs({ isPackaged: false, resourcesPath: '/res', appPath: '/fake/app-path' }, true),
    ).toEqual(['--remote-access', `--mobile-dist=${join('/', 'packages', 'mobile-renderer', 'dist')}`])
  })

  it('开态 prod：--mobile-dist = <resources>/mobile-dist（与 builder.yml extraResources to 一致）', async () => {
    const { buildRemoteAccessSpawnArgs } = await loadModule()
    expect(
      buildRemoteAccessSpawnArgs({ isPackaged: true, resourcesPath: '/res', appPath: '/ignored' }, true),
    ).toEqual(['--remote-access', `--mobile-dist=${join('/res', 'mobile-dist')}`])
  })
})

describe('spawnRuntimeProcess 全链 argv（打包分支）', () => {
  let tmpDataDir: string
  let originalResourcesPath: PropertyDescriptor | undefined
  let logSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpDataDir = mkdtempSync(join(tmpdir(), 'remote-access-full-'))
    // spawnRuntimeProcess 在 spawn 时刻现读 readRemoteAccessConfig()（缺省走 getDataDir()）：
    // 钉 env 到 tmp，禁触真实数据目录
    process.env.TAIJI_AGENT_DATA_DIR = tmpDataDir
    // prod 分支 runtimeDist 存在性检查与 resources 路径推导依赖该属性（Electron 注入，Node 测试环境缺省）
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

  it('关态：argv 与既有形态一致（runtimeDist / --port / --builtin-plugins-dir，无 remote flag）', async () => {
    rmSync(join(tmpDataDir, REMOTE_ACCESS_FILENAME), { force: true })
    const { spawnRuntimeProcess } = await loadModule()

    spawnRuntimeProcess(45678, () => {})

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [, args] = spawnMock.mock.calls[0] as [string, string[]]
    expect(args).toEqual([
      join('/res', 'app.asar.unpacked', 'dist', 'runtime', 'index.cjs'),
      '--port=45678',
      `--builtin-plugins-dir=${join('/res', 'resources', 'plugins')}`,
    ])
  })

  it('开态：argv 尾部追加 --remote-access 与 --mobile-dist=<prod 资源路径>', async () => {
    seedConfigFull(tmpDataDir, true)
    const { spawnRuntimeProcess } = await loadModule()

    spawnRuntimeProcess(45679, () => {})

    const [, args] = spawnMock.mock.calls[0] as [string, string[]]
    expect(args).toEqual([
      join('/res', 'app.asar.unpacked', 'dist', 'runtime', 'index.cjs'),
      '--port=45679',
      `--builtin-plugins-dir=${join('/res', 'resources', 'plugins')}`,
      '--remote-access',
      `--mobile-dist=${join('/res', 'mobile-dist')}`,
    ])
  })
})

/** 向指定数据目录写 remote-access.json（全链测试夹具）。 */
function seedConfigFull(dataDir: string, enabled: boolean): void {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(
    join(dataDir, REMOTE_ACCESS_FILENAME),
    JSON.stringify({ enabled, token: 'b'.repeat(64), createdAt: '2026-01-01T00:00:00.000Z' }),
    'utf-8',
  )
}
