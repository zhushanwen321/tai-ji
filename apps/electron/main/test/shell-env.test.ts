import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fixPathEnv, fixShellEnv } from '../supervisor/shell-env.js'
import { AMBIENT_ENV_NAMES } from '@taiji/shared'

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}))

const mockedSpawnSync = vi.mocked(spawnSync)

const ORIG_PLATFORM = process.platform
const ORIG_SHELL = process.env.SHELL
const ORIG_PATH = process.env.PATH

/** 临时覆盖 process.platform（通过 Object.defineProperty，因 process.platform 只读） */
function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

describe('fixPathEnv', () => {
  beforeEach(() => {
    mockedSpawnSync.mockReset()
    process.env.SHELL = '/bin/zsh'
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: ORIG_PLATFORM, configurable: true })
    process.env.SHELL = ORIG_SHELL
    process.env.PATH = ORIG_PATH
  })

  it('shell 返回更长 PATH 时覆盖 process.env.PATH', () => {
    const longPath = [
      '/Users/test/.local/bin',
      '/Users/test/.cargo/bin',
      '/opt/homebrew/bin',
      '/usr/bin:/bin:/usr/sbin:/sbin',
    ].join(':')
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: `PATH=${longPath}\nHOME=/Users/test\n`,
      stderr: '',
      pid: 12345,
      output: [null, `PATH=${longPath}\n`, ''],
      signal: null,
    } as any)

    fixPathEnv()

    expect(process.env.PATH).toBe(longPath)
  })

  it('shell 返回更短 PATH 时不覆盖', () => {
    const shortPath = '/usr/bin:/bin'
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: `PATH=${shortPath}\n`,
      stderr: '',
      pid: 12345,
      output: [null, `PATH=${shortPath}\n`, ''],
      signal: null,
    } as any)

    const before = process.env.PATH
    fixPathEnv()

    expect(process.env.PATH).toBe(before)
  })

  it('spawnSync 非零退出时不修改 PATH', () => {
    mockedSpawnSync.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'shell error',
      pid: 12345,
      output: [null, '', 'shell error'],
      signal: null,
    } as any)

    const before = process.env.PATH
    fixPathEnv()

    expect(process.env.PATH).toBe(before)
  })

  it('spawnSync 超时（signal = SIGTERM）时不修改 PATH', () => {
    mockedSpawnSync.mockReturnValue({
      status: null,
      stdout: '',
      stderr: '',
      pid: 12345,
      output: [null, '', ''],
      signal: 'SIGTERM',
    } as any)

    const before = process.env.PATH
    fixPathEnv()

    expect(process.env.PATH).toBe(before)
  })

  it('Windows 平台跳过（不调 spawnSync）', () => {
    setPlatform('win32')

    fixPathEnv()

    expect(mockedSpawnSync).not.toHaveBeenCalled()
  })

  it('无 $SHELL 时跳过（不调 spawnSync）', () => {
    delete process.env.SHELL

    fixPathEnv()

    expect(mockedSpawnSync).not.toHaveBeenCalled()
  })

  it('stdout 含 motd/fortune 污染行时只解析 KEY=VALUE 行', () => {
    const longPath = '/Users/test/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
    mockedSpawnSync.mockReturnValue({
      status: 0,
      // 模拟 shell 配置输出的 motd / fortune / 空行等污染
      stdout: [
        'Welcome to your shell!',
        'fortune: The early bird gets the worm.',
        '',
        'PATH=' + longPath,
        'HOME=/Users/test',
        'invalid line without equals',
        '=leading equals',
        '123BAD=starts with digit',
      ].join('\n') + '\n',
      stderr: '',
      pid: 12345,
      output: [null, '', ''],
      signal: null,
    } as any)

    fixPathEnv()

    expect(process.env.PATH).toBe(longPath)
  })

  it('shell 输出无 PATH 时不修改', () => {
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: 'HOME=/Users/test\nUSER=test\n',
      stderr: '',
      pid: 12345,
      output: [null, 'HOME=/Users/test\nUSER=test\n', ''],
      signal: null,
    } as any)

    const before = process.env.PATH
    fixPathEnv()

    expect(process.env.PATH).toBe(before)
  })
})

describe('fixShellEnv ambient env 回写（wave-env-check T4）', () => {
  const ORIG_AMBIENT: Record<string, string | undefined> = {}
  for (const name of AMBIENT_ENV_NAMES) {
    ORIG_AMBIENT[name] = process.env[name]
  }

  beforeEach(() => {
    mockedSpawnSync.mockReset()
    process.env.SHELL = '/bin/zsh'
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
    // 清空 ambient 变量（模拟 GUI 启动最小环境）
    for (const name of AMBIENT_ENV_NAMES) {
      delete process.env[name]
    }
  })

  afterEach(() => {
    for (const name of AMBIENT_ENV_NAMES) {
      const v = ORIG_AMBIENT[name]
      if (v === undefined) delete process.env[name]
      else process.env[name] = v
    }
  })

  it('shell 有值且当前未设置 → 补齐 ambient 变量', () => {
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: 'PATH=/usr/bin:/bin\nGOOGLE_APPLICATION_CREDENTIALS=/Users/test/.config/gcloud/adc.json\nAWS_PROFILE=prod\n',
      stderr: '',
      pid: 12345,
      output: [null, '', ''],
      signal: null,
    } as any)

    fixShellEnv()

    expect(process.env.GOOGLE_APPLICATION_CREDENTIALS).toBe('/Users/test/.config/gcloud/adc.json')
    expect(process.env.AWS_PROFILE).toBe('prod')
  })

  it('当前已有值 → 保留不覆盖（blind overwrite 防护）', () => {
    process.env.AWS_PROFILE = 'dev' // 用户显式配置
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: 'PATH=/usr/bin:/bin\nAWS_PROFILE=prod\n',
      stderr: '',
      pid: 12345,
      output: [null, '', ''],
      signal: null,
    } as any)

    fixShellEnv()

    expect(process.env.AWS_PROFILE).toBe('dev')
  })

  it('当前值为空串 → 视为未设置，补齐', () => {
    process.env.GCLOUD_PROJECT = ''
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: 'PATH=/usr/bin:/bin\nGCLOUD_PROJECT=my-project\n',
      stderr: '',
      pid: 12345,
      output: [null, '', ''],
      signal: null,
    } as any)

    fixShellEnv()

    expect(process.env.GCLOUD_PROJECT).toBe('my-project')
  })

  it('shell 无 ambient 值 / spawnSync 失败 → 不修改（fail-safe）', () => {
    mockedSpawnSync.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'shell error',
      pid: 12345,
      output: [null, '', 'shell error'],
      signal: null,
    } as any)

    fixShellEnv()

    for (const name of AMBIENT_ENV_NAMES) {
      expect(process.env[name]).toBeUndefined()
    }
  })

  it('fixPathEnv 别名兼容：仍修复 PATH（转发 fixShellEnv）', () => {
    const longPath = '/Users/test/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: `PATH=${longPath}\n`,
      stderr: '',
      pid: 12345,
      output: [null, `PATH=${longPath}\n`, ''],
      signal: null,
    } as any)

    fixPathEnv()

    expect(process.env.PATH).toBe(longPath)
  })
})
