/**
 * U16（方案 B / 设计 §6.12）spawn 清单 + --session-dir 移除回归锁定。
 *
 * 覆盖（u16 验收条款 ①②）：
 * - A：spawn argv 不含 --session-dir（B1：pi 走默认派生 <agentDir>/sessions/<encodeCwd>），
 *   且基干 flags（--mode rpc --no-extensions --approve）与 --extension/--skill 透传
 *   不受影响（防「删参数误删整机」回归）；start() 落盘清单内容 = staged 子集，
 *   零 staged 值仍写空数组文件（§11.11：清单文件仍须写入）。
 * - B：spawn-markers 纯函数直测——三根形态收录（打包 .app / dev resources + dev 源码根
 *   〔D-11 ②-b〕 / <dataDir> extensions+npm）、用户三来源排除（~/.pi、项目 .pi、
 *   ~/.agents）、全量重算覆盖写（旧条目不残留）、tmp+rename 原子调用序列（依赖注入桩
 *   断言）、run/ 目录自建、写入失败不阻断 spawn（宁漏不崩）。
 *
 * 策略：describe A 沿 rpc-client-spawn-args.test.ts 同构骨架（mock node:child_process
 * 捕获 spawn args；getDataDir 指向 mkdtemp tmp 数据目录，真实落盘供内容断言，fs-guard
 * 白名单内）；describe B 全程纯 DI / mkdtemp 自建自删，不覆盖 fs-guard 全局 mock。
 *
 * 运行：npx vitest run src/infra/__tests__/rpc-client-spawn-markers.test.ts
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  getSpawnMarkersPath,
  isStagedMarkerPath,
  readSpawnMarkerList,
  recordSpawnMarkers,
  selectSpawnMarkerPaths,
  writeSpawnMarkersFile,
  type SpawnMarkerFsDeps,
} from '../pi/spawn-markers.js'
import type { RpcClient } from '../pi/rpc-client.js'

// ── describe A mocks（骨架与 rpc-client-spawn-args.test.ts 同构）─────────────

let capturedSpawnArgs: string[] = []
let procExitHandlers: Array<(code: number | null) => void> = []
let argvDataDir = ''

const fakeProc = {
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (event === 'exit') procExitHandlers.push(handler as (code: number | null) => void)
    return fakeProc
  }),
  off: vi.fn(),
  removeListener: vi.fn(),
  stdout: { on: vi.fn(), resume: vi.fn(), destroy: vi.fn() },
  stderr: { on: vi.fn() },
  stdin: { write: vi.fn(() => true), once: vi.fn() },
  // kill 即同步 emit exit：免去每用例 2s KILL_TIMEOUT 等待（exit handler 语义不变）
  kill: vi.fn(() => {
    for (const handler of [...procExitHandlers]) handler(0)
    return true
  }),
  pid: 12345,
}

vi.mock('node:child_process', () => ({
  spawn: (_cmd: string, args: string[]) => {
    capturedSpawnArgs = args
    return fakeProc
  },
}))

vi.mock('@taiji/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/shared')>()
  return { ...actual, ENV_WHITELIST_PREFIXES: ['PATH', 'HOME', 'USER', 'LANG', 'TERM'] }
})

// getDataDir 指 mkdtemp tmp 数据目录：recordSpawnMarkers 真实落盘（fs-guard 白名单内）
vi.mock('@taiji/shared/paths', () => ({ getDataDir: () => argvDataDir }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => '/mock/home' }
})

vi.mock('../pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pi/pi-provider-store.js')>()
  return { ...actual, getDefaultModel: () => null }
})

vi.mock('../logger.js', () => ({
  createPiSessionLog: () => ({ write: vi.fn(), end: vi.fn() }),
}))

/** 取 args 中 flag 后面的全部值；flag 不存在返回 [] */
function flagValues(args: string[], flag: string): string[] {
  const values: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) values.push(args[i + 1] ?? '')
  }
  return values
}

function readSpawnMarkers(): string[] {
  return JSON.parse(readFileSync(getSpawnMarkersPath(argvDataDir), 'utf-8')) as string[]
}

describe('A · RpcClient.start：argv 无 --session-dir + 清单落盘（集成面）', () => {
  beforeAll(() => {
    argvDataDir = mkdtempSync(join(tmpdir(), 'rpc-spawn-markers-'))
  })

  afterAll(() => {
    rmSync(argvDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  async function startClient(options: Record<string, unknown> = {}): Promise<RpcClient> {
    const { RpcClient: Client } = await import('../pi/rpc-client.js')
    const client = new Client({ cwd: '/project', ...options })
    await client.start()
    return client
  }

  it('A1: 默认 options → argv 不含 --session-dir，基干 flags 原样；零 staged 值仍写空数组清单', async () => {
    const client = await startClient()
    try {
      expect(capturedSpawnArgs).not.toContain('--session-dir')
      // B1 只删 --session-dir 一对，不伤整机 argv（首四 flag 原样）
      expect(capturedSpawnArgs.slice(0, 4)).toEqual(['--mode', 'rpc', '--no-extensions', '--approve'])
      // §11.11：零 staged 值的 spawn 仍须写清单文件（空数组合法）
      expect(readSpawnMarkers()).toEqual([])
    } finally {
      await client.kill()
    }
  })

  it('A2: 混合路径 launch → --extension/--skill 透传原样；清单只收 staged 子集，用户三来源排除', async () => {
    const stagedDev = join(argvDataDir, 'repo', 'apps', 'electron', 'resources', 'extensions', '@zhushanwen', 'pi-goal')
    const dataDirNpm = join(argvDataDir, 'npm', 'node_modules', '@zhushanwen', 'pi-cache-probe')
    const stagedSkill = join(argvDataDir, 'repo', 'apps', 'electron', 'resources', 'extensions', 'skill-pack', 'main')
    const userHomePi = join('/mock', 'home', '.pi', 'agent', 'extensions', 'user-ext')
    const userProjectPi = join('/project', '.pi', 'extensions', 'proj-ext')
    const userAgents = join('/mock', 'home', '.agents', 'skills', 'demo')

    const client = await startClient({
      extensionPaths: [stagedDev, dataDirNpm, userHomePi, userProjectPi, userAgents],
      skillPaths: [stagedSkill, userAgents],
    })
    try {
      expect(capturedSpawnArgs).not.toContain('--session-dir')
      // B1 不动 argv 其他部分：两类 flag 全量透传原样
      expect(flagValues(capturedSpawnArgs, '--extension')).toEqual([stagedDev, dataDirNpm, userHomePi, userProjectPi, userAgents])
      expect(flagValues(capturedSpawnArgs, '--skill')).toEqual([stagedSkill, userAgents])
      // 清单 = staged 子集（保序：skill 在前），用户三来源（~/.pi、项目 .pi、~/.agents）全排除
      expect(readSpawnMarkers()).toEqual([stagedSkill, stagedDev, dataDirNpm])
    } finally {
      await client.kill()
    }
  })
})

// ── describe B：spawn-markers 纯函数（三根登记规则 + 写语义）─────────────────

/** fs 桩（记录调用序列或注入失败），窄化签名对齐 SpawnMarkerFsDeps */
function stubFs(overrides: Partial<SpawnMarkerFsDeps> = {}): SpawnMarkerFsDeps {
  return {
    mkdirSync: vi.fn(() => undefined),
    writeFileSync: vi.fn(() => undefined),
    renameSync: vi.fn(() => undefined),
    rmSync: vi.fn(() => undefined),
    ...overrides,
  } as unknown as SpawnMarkerFsDeps
}

describe('B · spawn-markers 三根登记规则', () => {
  let dataDir: string

  it('B1: 三根形态各一收录（打包 .app 形态 / dev resources 形态 / dataDir 下 extensions+npm）', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'pi-spawn-markers-'))
    try {
      const values = [
        '/Applications/TaiJi.app/Contents/Resources/extensions/@zhushanwen/pi-goal',
        '/Users/dev/work/taiji/apps/electron/resources/extensions/@zhushanwen/pi-system-prompt',
        join(dataDir, 'extensions', 'my-local-ext'),
        join(dataDir, 'npm', 'node_modules', '@scope', 'pi-user-ext'),
      ]
      expect(selectSpawnMarkerPaths(values, dataDir)).toEqual(values)
      // ① 打包段链中间命中（.app 不在首段也可）
      expect(isStagedMarkerPath('/Volumes/X/TaiJi.app/Contents/Resources/extensions/@zhushanwen/pi-rename-session', dataDir)).toBe(true)
      // ③ 根目录自身形态也命中（isPathUnder 允许 rel === ''）
      expect(isStagedMarkerPath(join(dataDir, 'npm'), dataDir)).toBe(true)
    } finally {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('B2: 用户三来源排除（~/.pi、项目 .pi、~/.agents 一律不登记）', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'pi-spawn-markers-'))
    try {
      const values = [
        join('/mock/home', '.pi', 'agent', 'extensions', 'user-ext'),
        join('/project', '.pi', 'extensions', 'proj-ext'),
        join('/mock/home', '.agents', 'skills', 'demo'),
      ]
      expect(selectSpawnMarkerPaths(values, dataDir)).toEqual([])
      for (const value of values) {
        expect(isStagedMarkerPath(value, dataDir)).toBe(false)
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('B3: dev 源码根收录（D-11 ②-b）——<repo>/extensions/<group>/<pkg> 收录，.pi/extensions 与裸两层不误吸', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'pi-spawn-markers-'))
    try {
      const repo = '/Users/dev/work/taiji'
      // resolver dev 分支产出形态：分组层恒在（scanDirectory 只扫分组目录下的包）
      const values = [
        `${repo}/extensions/universal/session-reader`,
        `${repo}/extensions/taiji/plugin-bridge`,
      ]
      expect(selectSpawnMarkerPaths(values, dataDir)).toEqual(values)
      // discovery 深层形态（包目录下入口文件）同样收录
      expect(isStagedMarkerPath(`${repo}/extensions/universal/session-reader/index.ts`, dataDir)).toBe(true)
      // 用户世界 .pi/extensions（extensions 段后无子层）不误吸
      expect(isStagedMarkerPath('/Users/dev/.pi/agent/extensions/user-ext', dataDir)).toBe(false)
      expect(isStagedMarkerPath('/proj/.pi/extensions/proj-ext', dataDir)).toBe(false)
      // 裸两层 <root>/extensions/<pkg>（taiji 不产出此形态）不收录——收紧误吸面
      expect(isStagedMarkerPath('/any/repo/extensions/bare-pkg', dataDir)).toBe(false)
    } finally {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('C · spawn-markers 写语义（全量覆盖 / 原子 / 自建 / 降级）', () => {
  let dataDir: string

  function freshDir(): void {
    dataDir = mkdtempSync(join(tmpdir(), 'pi-spawn-markers-'))
  }

  it('C1（全量重算覆盖写）: 旧条目不残留，空集覆盖也合法', () => {
    freshDir()
    try {
      writeSpawnMarkersFile(['/old/one', '/old/two'], dataDir)
      expect(JSON.parse(readFileSync(getSpawnMarkersPath(dataDir), 'utf-8'))).toEqual(['/old/one', '/old/two'])
      writeSpawnMarkersFile(['/new/only'], dataDir)
      expect(JSON.parse(readFileSync(getSpawnMarkersPath(dataDir), 'utf-8'))).toEqual(['/new/only'])
      // 该次 spawn 无 staged 值：文件仍须写入（§11.11），且覆盖为空数组
      writeSpawnMarkersFile([], dataDir)
      expect(JSON.parse(readFileSync(getSpawnMarkersPath(dataDir), 'utf-8'))).toEqual([])
    } finally {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('C2（tmp+rename 原子性）: 写目标为同目录 tmp，rename 源 = tmp、目标 = 终态路径', () => {
    freshDir()
    try {
      const calls: string[] = []
      const finalPath = getSpawnMarkersPath(dataDir)
      const fsDeps = stubFs({
        mkdirSync: vi.fn((path: string) => { calls.push(`mkdir ${path}`) }),
        writeFileSync: vi.fn((path: string) => { calls.push(`write ${path}`) }),
        renameSync: vi.fn((from: string, to: string) => { calls.push(`rename ${from} -> ${to}`) }),
      })
      writeSpawnMarkersFile(['/a'], dataDir, fsDeps)
      // run/ 先自建
      expect(calls[0]).toBe(`mkdir ${join(dataDir, 'run')}`)
      // 调用序列 = write(tmp) → rename(tmp → final)：tmp 与终态同目录、rename 消费 tmp
      expect(calls).toHaveLength(3)
      const writeTarget = calls[1]!.slice('write '.length)
      const [renameSrc, renameDst] = calls[2]!.slice('rename '.length).split(' -> ')
      expect(writeTarget).toBe(renameSrc)
      expect(writeTarget.startsWith(`${finalPath}.tmp-`)).toBe(true)
      expect(renameDst).toBe(finalPath)
    } finally {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('C3（run/ 自建）: <dataDir> 存在但 run/ 不存在时，写入后清单文件在位', () => {
    freshDir()
    try {
      expect(existsSync(join(dataDir, 'run'))).toBe(false)
      writeSpawnMarkersFile(['/x'], dataDir)
      expect(existsSync(getSpawnMarkersPath(dataDir))).toBe(true)
      expect(JSON.parse(readFileSync(getSpawnMarkersPath(dataDir), 'utf-8'))).toEqual(['/x'])
    } finally {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('C4（写入失败不阻断 spawn）: recordSpawnMarkers 吞错 + console.error 出声 + tmp 残片清理被尝试', () => {
    freshDir()
    try {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const fsDeps = stubFs({
          writeFileSync: vi.fn(() => { throw new Error('EACCES: disk on fire') }),
        })
        expect(() =>
          recordSpawnMarkers({ extensionPaths: ['/Applications/X.app/Contents/Resources/extensions/e'] }, dataDir, fsDeps),
        ).not.toThrow()
        expect(fsDeps.rmSync).toHaveBeenCalled()
        expect(errSpy).toHaveBeenCalled()
        // 宁漏不崩：终态文件未被半写产生
        expect(existsSync(getSpawnMarkersPath(dataDir))).toBe(false)
      } finally {
        errSpy.mockRestore()
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('C5（边界）: 非绝对路径排除 / 去重保序 / 段链须成界不误吸', () => {
    freshDir()
    try {
      const dup = join(dataDir, 'npm', 'node_modules', 'x')
      const ext = join(dataDir, 'extensions', 'y')
      // 去重保序 + 非绝对路径/空值/undefined 排除
      expect(selectSpawnMarkerPaths([dup, dup, 'relative/ext', '', undefined, ext], dataDir)).toEqual([dup, ext])
      // 'fake-apps/...' 无段边界（链常量以 '/' 起头）不误吸
      expect(isStagedMarkerPath('/repo/fake-apps/electron/resources/extensions/x', dataDir)).toBe(false)
      // 'extensionsExtra' 前缀延伸不误吸
      expect(isStagedMarkerPath('/Applications/X.app/Contents/Resources/extensionsExtra/x', dataDir)).toBe(false)
      // win32 形态不在此断言：path.isAbsolute 平台感知（win32 生产端同平台 join 产出与
      // 判定一致），darwin 上 C:\\ 开头串本就不是绝对路径，跨平台硬造无意义
    } finally {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('D · readSpawnMarkerList 读侧（u17 reap 判据③数据源）', () => {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

  afterEach(() => {
    warnSpy.mockClear()
  })

  it('D1 合法清单（写侧落盘形态）→ 返回字符串数组', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-spawn-markers-read-'))
    try {
      mkdirSync(join(dir, 'run'), { recursive: true })
      const entries = [join(dir, 'extensions', 'a'), join(dir, 'npm', 'node_modules', 'b')]
      writeFileSync(getSpawnMarkersPath(dir), `${JSON.stringify(entries, null, 2)}\n`, 'utf-8')
      expect(readSpawnMarkerList(dir)).toEqual(entries)
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('D2 文件缺失 → null + warn（unreadable；首启前常态分支，消费方须跳过匹配）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-spawn-markers-read-'))
    try {
      expect(readSpawnMarkerList(dir)).toBeNull()
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('unreadable')
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain(getSpawnMarkersPath(dir))
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('D3 坏 JSON → null + warn（malformed）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-spawn-markers-read-'))
    try {
      mkdirSync(join(dir, 'run'), { recursive: true })
      writeFileSync(getSpawnMarkersPath(dir), '{ not valid json', 'utf-8')
      expect(readSpawnMarkerList(dir)).toBeNull()
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('malformed')
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('D4 非字符串数组（对象 / 混入非字符串元素）→ null + warn（格式守卫）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-spawn-markers-read-'))
    try {
      mkdirSync(join(dir, 'run'), { recursive: true })
      const p = getSpawnMarkersPath(dir)
      writeFileSync(p, JSON.stringify({ extensions: [] }), 'utf-8')
      expect(readSpawnMarkerList(dir)).toBeNull()
      writeFileSync(p, JSON.stringify([join(dir, 'extensions', 'a'), 42]), 'utf-8')
      expect(readSpawnMarkerList(dir)).toBeNull()
      expect(warnSpy).toHaveBeenCalledTimes(2)
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('malformed')
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
