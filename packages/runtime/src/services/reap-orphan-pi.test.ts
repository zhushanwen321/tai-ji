/**
 * 孤儿 pi 收殓测试（integrity-hardening §3.4 D4a/D4b + 判据 v2：设计 §6.12 四条合取）。
 *
 * 锁定（V10 子项单测化）：
 * - 判据 v2 四条合取：--mode rpc（①）+ --no-extensions 独立 token 在位（②主判别位）+
 *   任一 --extension/--skill 值 ∈ spawn 清单精确相等（③，禁子串/前缀 /a/b 不得命中
 *   /a/bc）+ ppid=1（④，防线② reparent 证据）。
 * - 反向三态（V10②）：裸 pi 交互式（无 --mode rpc）/ AGENTS.md 实测模板形态（带清单值
 *   但无 --no-extensions）/ 带 --no-extensions 但值不在清单——三者都不匹配。
 * - 清单 fail-safe（V10④）：清单缺失/读不到/坏 JSON/非字符串数组 → 跳过收殓 + warn
 *   日志（宁漏不误杀）；真实读路径用 mkdtemp 自建自删（fs-guard 白名单内）。
 * - 收殓范围扩大（设计 §6.12）：孤儿 subagent/relay（引擎 CLI 直 spawn，argv 由
 *   pi-subagent-cli buildSpawnArgs 构造——恒定 --no-extensions 基座 + --extension
 *   白名单集，staged 值登记进 spawn-markers 清单）ppid=1 被收；活跃 subagent
 *   ppid=父进程活值（引擎 CLI / relay 受托 runtime）不收；两轮时序 = 第一轮
 *   ppid≠1 不收 → reparent 后第二轮 ppid=1 收。
 * - 编排时序：SIGTERM → 宽限 → 探活（signal 0）→ 仍活才 SIGKILL；SIGTERM 即 ESRCH
 *   按「已回收」计且不等待宽限；枚举失败 / Windows 降级 unsupported 不抛。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/reap-orphan-pi.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  parsePsOutput,
  tokenizeArgv,
  matchesOwnPiArgv,
  findOrphanPiRows,
  reapOrphanPiProcesses,
  ORPHAN_KILL_GRACE_MS,
  type PsRow,
} from './reap-orphan-pi.js'
import { getSpawnMarkersPath, readSpawnMarkerList } from '../infra/pi/spawn-markers.js'

/** 本实例数据目录（方案 B 新布局：<dataDir>/agent/sessions/…，判据不再消费 sessions 路径）。 */
const DATA_DIR = '/Users/tester/.taiji'
const OWN_PID = 100

/**
 * spawn 清单 fixture（写侧 u16 三根登记规则的两种常见形态；对 matchesOwnPiArgv 而言
 * 只是精确相等目标字符串，形态区分用于正向 ×2 的宿主覆盖：打包 / dev）。
 */
const MARKERS = [
  '/Applications/TaiJi.app/Contents/Resources/extensions/pi-agent-ext', // ① 打包资源根
  '/Users/tester/Code/taiji/extensions/universal/todo', // ② dev 仓库源码根（D-11 形态）
] as const

function row(pid: number, ppid: number, command: string): PsRow {
  return { pid, ppid, command }
}

/** taiji spawn 的 pi 典型 argv（rpc-client buildPiArgs 拼参形态：首 flags → --extension 注入段）。 */
function piCmd(extensionPath: string): string {
  return `/opt/pi/pi --mode rpc --no-extensions --approve --extension ${extensionPath}`
}

/** 孤儿 subagent 的 argv（引擎 CLI 直 spawn 形态：buildSpawnArgs 恒定 --no-extensions 基座 + --extension/--skill 注入段，与主 pi 同判据形态）。 */
function subagentMirrorCmd(extensionPath: string): string {
  return `/opt/pi/pi --mode rpc --no-extensions --approve --extension ${extensionPath} --skill /Users/tester/Code/taiji/extensions/universal/subagent-workflow`
}

/** ESRCH 错误（process.kill 对不存在 pid 的 errno 形态）。 */
function esrch(): NodeJS.ErrnoException {
  const e = new Error('process not found') as NodeJS.ErrnoException
  e.code = 'ESRCH'
  return e
}

/** 构造 ps stdout（`ps -axo pid=,ppid=,command=` 的缩进列形态）。 */
function psStdout(rows: PsRow[]): string {
  return rows.map(r => `  ${r.pid}   ${r.ppid} ${r.command}`).join('\n') + '\n'
}

/** mkdtemp 自建清单目录（fs-guard 白名单内自建自删）；返回 dataDir 根。 */
function makeMarkersDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'reap-markers-'))
}

/** 以写侧同款路径/格式落一份清单文件（路径经 getSpawnMarkersPath SSOT，防读写漂移）。 */
function writeMarkersFile(dataDir: string, entries: string[]): void {
  mkdirSync(join(dataDir, 'run'), { recursive: true })
  writeFileSync(getSpawnMarkersPath(dataDir), `${JSON.stringify(entries, null, 2)}\n`, 'utf-8')
}

describe('parsePsOutput（ps 三列解析）', () => {
  it('解析 pid/ppid/command 三列，command 含空格整段保留', () => {
    const out = psStdout([
      row(123, 1, piCmd('/a/b')),
      row(456, 123, 'node server.js'),
    ])
    expect(parsePsOutput(out)).toEqual([
      { pid: 123, ppid: 1, command: piCmd('/a/b') },
      { pid: 456, ppid: 123, command: 'node server.js' },
    ])
  })

  it('空行与非数字列行跳过（fail-open 只影响覆盖面不影响精确性）', () => {
    const out = ['', 'garbage line', '   ', '  1 2 x'].join('\n')
    expect(parsePsOutput(out)).toEqual([{ pid: 1, ppid: 2, command: 'x' }])
  })
})

describe('tokenizeArgv（引号感知分词）', () => {
  it('空格/Tab 分词，多余空白收敛', () => {
    expect(tokenizeArgv('a b\tc  d ')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('双引号/单引号内空格不分词，引号剥离', () => {
    expect(tokenizeArgv('pi --extension "/a b/s"')).toEqual(['pi', '--extension', '/a b/s'])
    expect(tokenizeArgv("pi --extension '/a b/s'")).toEqual(['pi', '--extension', '/a b/s'])
  })

  it('未加引号的空格路径被拆碎（真实 ps 形态）——值级精确相等不再命中，该进程漏收（fail-safe 宁漏不误杀）', () => {
    expect(tokenizeArgv('pi --extension /a b/s')).toEqual(['pi', '--extension', '/a', 'b/s'])
  })
})

describe('matchesOwnPiArgv（判据 v2 四条合取的 ①②③）', () => {
  // —— 正向 ×2（V10① 的判据层：清单形态覆盖打包 / dev 两宿主）——
  it('正向：--mode rpc + --no-extensions + 打包资源根清单值精确相等 → 命中', () => {
    expect(matchesOwnPiArgv(row(1, 1, piCmd(MARKERS[0])), [...MARKERS])).toBe(true)
  })

  it('正向：dev 仓库清单值（D-11 源码根形态）同理命中', () => {
    expect(matchesOwnPiArgv(row(1, 1, piCmd(MARKERS[1])), [...MARKERS])).toBe(true)
  })

  // —— 反向三态（V10② 的判据层）——
  it('反向：缺 --mode rpc（用户终端交互 pi，即使带 --no-extensions 与清单值）不命中', () => {
    expect(matchesOwnPiArgv(row(1, 1, `/opt/pi/pi --no-extensions --approve --extension ${MARKERS[0]}`), [...MARKERS])).toBe(false)
  })

  it('反向：无 --no-extensions 不命中（主判别位；AGENTS.md 实测命令模板形态——带清单值也不杀）', () => {
    expect(matchesOwnPiArgv(row(1, 1, `/opt/pi/pi --mode rpc --approve --extension ${MARKERS[0]}`), [...MARKERS])).toBe(false)
  })

  it('反向：--extension 值不在清单（用户配置来源路径）不命中', () => {
    expect(matchesOwnPiArgv(row(1, 1, piCmd('/Users/tester/some-project/.pi/extensions/my-ext')), [...MARKERS])).toBe(false)
  })

  it('反向：空清单恒不命中（防御位，正常路径由编排层清单缺失跳过兜住）', () => {
    expect(matchesOwnPiArgv(row(1, 1, piCmd(MARKERS[0])), [])).toBe(false)
  })

  it('--skill 值与清单精确相等同样命中（③ 的两个值承载 flag 都参与）', () => {
    const argv = `/opt/pi/pi --mode rpc --no-extensions --skill ${MARKERS[0]}`
    expect(matchesOwnPiArgv(row(1, 1, argv), [...MARKERS])).toBe(true)
  })

  it('精确等值：/a/b 与 /a/bc 双向不混淆（禁前缀/子串）', () => {
    expect(matchesOwnPiArgv(row(1, 1, piCmd('/a/bc')), ['/a/b'])).toBe(false)
    expect(matchesOwnPiArgv(row(1, 1, piCmd('/a/b')), ['/a/bc'])).toBe(false)
  })

  it('参数顺序无关：--extension/--mode/--no-extensions 相对位置任意', () => {
    expect(matchesOwnPiArgv(row(1, 1, `pi --extension ${MARKERS[0]} --no-extensions --mode rpc`), [...MARKERS])).toBe(true)
  })

  it('= 等号形态：--mode=rpc / --extension=<清单值> 命中', () => {
    expect(matchesOwnPiArgv(row(1, 1, `pi --mode=rpc --no-extensions --extension=${MARKERS[0]}`), [...MARKERS])).toBe(true)
  })

  it('多值注入：多个 --extension 任一命中即命中（appendSkillAndExtensionArgs 逐路径 push 形态）', () => {
    const argv = `/opt/pi/pi --mode rpc --no-extensions --extension /not/in/markers --extension ${MARKERS[1]}`
    expect(matchesOwnPiArgv(row(1, 1, argv), [...MARKERS])).toBe(true)
    expect(matchesOwnPiArgv(row(1, 1, argv), [MARKERS[0]])).toBe(false)
  })

  it('--no-extensions 必须是独立 token（前缀延伸不算，防未来放宽成 startsWith）', () => {
    const argv = `pi --mode rpc --no-extensions-x --extension ${MARKERS[0]}`
    expect(matchesOwnPiArgv(row(1, 1, argv), [...MARKERS])).toBe(false)
  })

  it('引号包裹的空格路径清单值：分词后精确相等命中', () => {
    const staged = '/Users/John Doe/app/Contents/Resources/extensions/my-ext'
    expect(matchesOwnPiArgv(row(1, 1, `pi --mode rpc --no-extensions --extension "${staged}"`), [staged])).toBe(true)
  })
})

describe('findOrphanPiRows（判据④：ppid=1 reparent 证据）', () => {
  it('孤儿判据：argv 匹配 + ppid=1 才杀；并存合法实例子代（ppid=其他活值）与本 runtime 子代（ppid=ownPid）不杀', () => {
    const rows = [
      row(201, 1, piCmd(MARKERS[0])),                          // 真孤儿：旧 runtime 死后 reparent 到 launchd
      row(202, 40842, piCmd(MARKERS[0])),                      // 并存合法实例（如打包版 runtime 40842）的活跃子代——跨实例保护
      row(203, OWN_PID, piCmd(MARKERS[0])),                    // 本 runtime 自己的活跃子进程
      row(OWN_PID, 1, piCmd(MARKERS[0])),                      // 自身行（防御性排除）
      row(204, 1, piCmd('/Users/tester/some-project/.pi/extensions/my-ext')), // argv 不匹配（值不在清单）
      row(205, 1, 'node app.js'),                              // 无关进程
    ]
    expect(findOrphanPiRows(rows, [...MARKERS], OWN_PID).map(r => r.pid)).toEqual([201])
  })

  it('ppid=任意其他活值一律不杀（跨实例保护的直接断言：dev+打包版共存场景）', () => {
    const rows = [
      row(301, 40842, piCmd(MARKERS[0])), // 打包版 runtime 的活跃 pi
      row(302, 99999, piCmd(MARKERS[0])), // 任意非 1、非 ownPid 的父
    ]
    expect(findOrphanPiRows(rows, [...MARKERS], OWN_PID)).toEqual([])
  })

  it('收殓范围扩大（设计 §6.12）：孤儿 subagent argv（--extension + --skill 白名单值）ppid=1 被收', () => {
    const rows = [row(401, 1, subagentMirrorCmd(MARKERS[0]))]
    expect(findOrphanPiRows(rows, [...MARKERS], OWN_PID).map(r => r.pid)).toEqual([401])
  })

  it('两轮时序（V10③）：活跃 subagent（ppid=父进程活值）第一轮不收 → 父进程死后 reparent ppid=1 第二轮收', () => {
    const mainPiPid = 500
    // 同一 subagent pid、同一 argv，仅 ppid 随 reparent 变化（现行父进程 = 引擎 CLI / relay 受托 runtime）
    const firstRound = [row(402, mainPiPid, subagentMirrorCmd(MARKERS[0]))]
    expect(findOrphanPiRows(firstRound, [...MARKERS], OWN_PID)).toEqual([])
    const secondRound = [row(402, 1, subagentMirrorCmd(MARKERS[0]))]
    expect(findOrphanPiRows(secondRound, [...MARKERS], OWN_PID).map(r => r.pid)).toEqual([402])
  })
})

describe('spawn 清单读取与 fail-safe 降级（V10④：宁漏不误杀）', () => {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

  afterEach(() => {
    warnSpy.mockClear()
  })

  // 真实读路径用例：注入 infra 读侧 SSOT 函数（组合根同款接线 `() => readSpawnMarkerList(dir)`），
  // mkdtemp 自建自删（fs-guard 白名单内）——端到端覆盖「infra 读失败 → services 跳过」组合行为。
  /** infra 读侧接线替身（等价组合根注入形态）。 */
  const realRead = (dataDir: string) => () => readSpawnMarkerList(dataDir)

  it('清单文件缺失 → 跳过收殓 + warn 日志（真实读路径，mkdtemp 自建自删）', async () => {
    const dataDir = makeMarkersDataDir()
    try {
      const signal = vi.fn()
      const res = await reapOrphanPiProcesses({
        dataDir,
        ownPid: OWN_PID,
        listProcesses: async () => psStdout([row(501, 1, piCmd(MARKERS[0]))]),
        signal,
        readSpawnMarkers: realRead(dataDir),
      })
      expect(res.reaped).toEqual([])
      expect(signal).not.toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('unreadable')
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain(getSpawnMarkersPath(dataDir))
    } finally {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('清单坏 JSON → 跳过收殓 + warn 日志（malformed）', async () => {
    const dataDir = makeMarkersDataDir()
    try {
      mkdirSync(join(dataDir, 'run'), { recursive: true })
      writeFileSync(getSpawnMarkersPath(dataDir), '{ not valid json', 'utf-8')
      const signal = vi.fn()
      const res = await reapOrphanPiProcesses({
        dataDir,
        ownPid: OWN_PID,
        listProcesses: async () => psStdout([row(502, 1, piCmd(MARKERS[0]))]),
        signal,
        readSpawnMarkers: realRead(dataDir),
      })
      expect(res.reaped).toEqual([])
      expect(signal).not.toHaveBeenCalled()
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('malformed')
    } finally {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('清单非字符串数组（JSON 对象）→ 跳过收殓 + warn 日志（格式守卫，防类型混淆误判）', async () => {
    const dataDir = makeMarkersDataDir()
    try {
      mkdirSync(join(dataDir, 'run'), { recursive: true })
      writeFileSync(getSpawnMarkersPath(dataDir), JSON.stringify({ extensions: [MARKERS[0]] }), 'utf-8')
      const signal = vi.fn()
      const res = await reapOrphanPiProcesses({
        dataDir,
        ownPid: OWN_PID,
        listProcesses: async () => psStdout([row(503, 1, piCmd(MARKERS[0]))]),
        signal,
        readSpawnMarkers: realRead(dataDir),
      })
      expect(res.reaped).toEqual([])
      expect(signal).not.toHaveBeenCalled()
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('malformed')
    } finally {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('清单合法（写侧同款路径与格式落盘）→ 正常收殓（真实读路径 SSOT 推导一致性）', async () => {
    const dataDir = makeMarkersDataDir()
    try {
      writeMarkersFile(dataDir, [...MARKERS])
      const signal = vi.fn((pid: number, sig: 'SIGTERM' | 'SIGKILL' | 0) => {
        if (sig === 0 && pid === 504) throw esrch() // 宽限后探活已退出
      })
      const res = await reapOrphanPiProcesses({
        dataDir,
        ownPid: OWN_PID,
        listProcesses: async () => psStdout([row(504, 1, piCmd(MARKERS[0]))]),
        signal,
        delay: async () => {},
        readSpawnMarkers: realRead(dataDir),
      })
      expect(res.reaped).toEqual([504])
      // 合并后语义取 dev 侧 D5① kill-path-logging 契约（K1-K8 同族）：正常收殓也是 kill 路径，
      // 必须 warn 级留痕并带结构化 kill_source。本行基线为 console.log、dev 升为 console.warn
      // + kill_source（packages/runtime/test/kill-path-logging.test.ts K7 即断言同一行），故不再是
      // 「零 warn」；此处钉住「唯一 warn 就是这条结构化 kill 日志」。
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('kill_source=reap_orphan')
    } finally {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('清单读取注入返回 null（替身路径）→ 跳过收殓，零信号', async () => {
    const signal = vi.fn()
    const res = await reapOrphanPiProcesses({
      dataDir: DATA_DIR,
      ownPid: OWN_PID,
      listProcesses: async () => psStdout([row(505, 1, piCmd(MARKERS[0]))]),
      signal,
      readSpawnMarkers: () => null,
    })
    expect(res.reaped).toEqual([])
    expect(res.scanned).toBe(1)
    expect(signal).not.toHaveBeenCalled()
  })
})

describe('reapOrphanPiProcesses（编排；清单一律注入，与 fs 隔离）', () => {
  it('目标 = 判据 v2 且 ppid=1；并存实例与本 runtime 的子代不触碰；SIGTERM 后已退出则收殓，不打 SIGKILL', async () => {
    const stdout = psStdout([
      row(201, 1, piCmd(MARKERS[0])),       // 孤儿（ppid=1）
      row(202, OWN_PID, piCmd(MARKERS[0])), // 本 runtime 子进程
      row(205, 40842, piCmd(MARKERS[0])),   // 并存合法实例（打包版）的活跃 pi——跨实例保护
      row(204, 1, 'node app.js'),           // 无关进程
    ])
    const signal = vi.fn((pid: number, sig: 'SIGTERM' | 'SIGKILL' | 0) => {
      if (sig === 0 && pid === 201) throw esrch() // 宽限后探活：已退出
    })
    const delay = vi.fn(async () => {})
    const res = await reapOrphanPiProcesses({
      dataDir: DATA_DIR,
      ownPid: OWN_PID,
      listProcesses: async () => stdout,
      signal,
      delay,
      readSpawnMarkers: () => [...MARKERS],
    })
    expect(res.reaped).toEqual([201])
    expect(res.failed).toEqual([])
    expect(res.scanned).toBe(4)
    expect(signal).toHaveBeenCalledWith(201, 'SIGTERM')
    expect(signal).toHaveBeenCalledWith(201, 0)
    expect(signal).not.toHaveBeenCalledWith(201, 'SIGKILL')
    // 非目标 pid（202/205 活实例子代、204 无关进程）全程不被触碰
    const touched = signal.mock.calls.map(c => c[0])
    expect(touched).toEqual([201, 201])
    expect(delay).toHaveBeenCalledWith(ORPHAN_KILL_GRACE_MS)
  })

  it('顽固孤儿：SIGTERM → 宽限探活仍活 → SIGKILL（完整时序）', async () => {
    const signal = vi.fn()
    const delay = vi.fn(async () => {})
    const res = await reapOrphanPiProcesses({
      dataDir: DATA_DIR,
      ownPid: OWN_PID,
      listProcesses: async () => psStdout([row(301, 1, piCmd(MARKERS[0]))]),
      signal,
      delay,
      readSpawnMarkers: () => [...MARKERS],
    })
    expect(res.reaped).toEqual([301])
    expect(signal.mock.calls.map(c => `${c[0]}:${c[1]}`)).toEqual(['301:SIGTERM', '301:0', '301:SIGKILL'])
    expect(delay).toHaveBeenCalledTimes(1)
    expect(delay).toHaveBeenCalledWith(ORPHAN_KILL_GRACE_MS)
  })

  it('SIGTERM 即 ESRCH（stdin-EOF 自杀链先到）：按已回收计，不等待宽限', async () => {
    const signal = vi.fn((_pid: number, sig: 'SIGTERM' | 'SIGKILL' | 0) => {
      if (sig === 'SIGTERM') throw esrch()
    })
    const delay = vi.fn(async () => {})
    const res = await reapOrphanPiProcesses({
      dataDir: DATA_DIR,
      ownPid: OWN_PID,
      listProcesses: async () => psStdout([row(401, 1, piCmd(MARKERS[0]))]),
      signal,
      delay,
      readSpawnMarkers: () => [...MARKERS],
    })
    expect(res.reaped).toEqual([401])
    expect(delay).not.toHaveBeenCalled()
  })

  it('SIGKILL 也 ESRCH（宽限期内自行退出）：按已回收计不记失败', async () => {
    const signal = vi.fn((pid: number, sig: 'SIGTERM' | 'SIGKILL' | 0) => {
      if (sig === 'SIGKILL' && pid === 501) throw esrch()
    })
    const res = await reapOrphanPiProcesses({
      dataDir: DATA_DIR,
      ownPid: OWN_PID,
      listProcesses: async () => psStdout([row(501, 1, piCmd(MARKERS[0]))]),
      signal,
      delay: async () => {},
      readSpawnMarkers: () => [...MARKERS],
    })
    expect(res.reaped).toEqual([501])
    expect(res.failed).toEqual([])
  })

  it('真信号错误（非 ESRCH）：记入 failed 不抛', async () => {
    const signal = vi.fn((_pid: number, sig: 'SIGTERM' | 'SIGKILL' | 0) => {
      if (sig === 'SIGTERM') {
        const e = new Error('not permitted') as NodeJS.ErrnoException
        e.code = 'EPERM'
        throw e
      }
    })
    const res = await reapOrphanPiProcesses({
      dataDir: DATA_DIR,
      ownPid: OWN_PID,
      listProcesses: async () => psStdout([row(601, 1, piCmd(MARKERS[0]))]),
      signal,
      delay: async () => {},
      readSpawnMarkers: () => [...MARKERS],
    })
    expect(res.reaped).toEqual([])
    expect(res.failed).toEqual([601])
  })

  it('枚举失败（ps 不可用）：降级 unsupported，不抛、不处置、不读清单', async () => {
    const signal = vi.fn()
    const readSpawnMarkers = vi.fn(() => [...MARKERS])
    const res = await reapOrphanPiProcesses({
      dataDir: DATA_DIR,
      ownPid: OWN_PID,
      listProcesses: async () => { throw new Error('spawn ps ENOENT') },
      signal,
      readSpawnMarkers,
    })
    expect(res.unsupported).toBe(true)
    expect(res.reaped).toEqual([])
    expect(signal).not.toHaveBeenCalled()
    expect(readSpawnMarkers).not.toHaveBeenCalled()
  })

  it('Windows：单条 warn 降级（已知边界），不枚举不处置', async () => {
    const listProcesses = vi.fn(async () => '')
    const signal = vi.fn()
    // 本仓 vitest 版本无 vi.replaceProperty，用 defineProperty 原地替换并恢复。
    const orig = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      const res = await reapOrphanPiProcesses({
        dataDir: DATA_DIR,
        ownPid: OWN_PID,
        listProcesses,
        signal,
        readSpawnMarkers: () => [...MARKERS],
      })
      expect(res.unsupported).toBe(true)
      expect(listProcesses).not.toHaveBeenCalled()
      expect(signal).not.toHaveBeenCalled()
    } finally {
      if (orig) Object.defineProperty(process, 'platform', orig)
    }
  })

  it('无孤儿时静默返回（零匹配不产生任何信号）', async () => {
    const signal = vi.fn()
    const res = await reapOrphanPiProcesses({
      dataDir: DATA_DIR,
      ownPid: OWN_PID,
      listProcesses: async () => psStdout([row(701, 1, 'node app.js')]),
      signal,
      readSpawnMarkers: () => [...MARKERS],
    })
    expect(res).toEqual({ scanned: 1, reaped: [], failed: [], unsupported: false })
    expect(signal).not.toHaveBeenCalled()
  })
})

describe('reapOrphanPiProcesses 杀链决策日志（crash-resilience §3.3 D6-⑥，E2 归因缺口修复）', () => {
  it('有孤儿时落结构化决策行：动作/触发者/目标 pid/原因字段齐全', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const signal = vi.fn()
      const delay = vi.fn(async () => {})
      const dataDir = makeMarkersDataDir()
      try {
        writeMarkersFile(dataDir, [...MARKERS])
        await reapOrphanPiProcesses({
          dataDir,
          ownPid: OWN_PID,
          trigger: 'startup-sweep',
          listProcesses: async () => psStdout([
            row(801, 1, piCmd(MARKERS[0]!)),
            row(802, 1, piCmd(MARKERS[1]!)),
          ]),
          signal,
          delay,
          readSpawnMarkers: () => readSpawnMarkerList(dataDir),
        })
      } finally {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
      const decisionCall = logSpy.mock.calls.find(([msg]) => msg === '[orphan-reap] kill decision')
      expect(decisionCall).toBeDefined()
      const meta = decisionCall![1] as Record<string, unknown>
      expect(meta.action).toBe('reap_orphan_pi')
      expect(meta.trigger).toBe('startup-sweep')
      expect(meta.targets).toEqual([
        { pid: 801, ppid: 1 },
        { pid: 802, ppid: 1 },
      ])
      expect(String(meta.reason)).toContain('ppid=1')
      // 决策之后有结果汇总行（决策 → 结果闭环，failed 非空时归因有据）
      const resultCall = logSpy.mock.calls.find(([msg]) => msg === '[orphan-reap] reap result')
      expect(resultCall).toBeDefined()
      expect((resultCall![1] as Record<string, unknown>).reaped).toEqual([801, 802])
    } finally {
      logSpy.mockRestore()
    }
  })

  it('无孤儿 / 枚举失败时不落决策行（决策日志只随真实杀链动作出现）', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const dataDir = makeMarkersDataDir()
      try {
        writeMarkersFile(dataDir, [...MARKERS])
        await reapOrphanPiProcesses({
          dataDir,
          ownPid: OWN_PID,
          listProcesses: async () => psStdout([row(901, 1, 'node app.js')]),
          signal: vi.fn(),
          readSpawnMarkers: () => readSpawnMarkerList(dataDir),
        })
        await reapOrphanPiProcesses({
          dataDir,
          ownPid: OWN_PID,
          listProcesses: async () => { throw new Error('spawn ps ENOENT') },
          signal: vi.fn(),
          readSpawnMarkers: () => readSpawnMarkerList(dataDir),
        })
      } finally {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
      expect(logSpy.mock.calls.some(([msg]) => msg === '[orphan-reap] kill decision')).toBe(false)
    } finally {
      logSpy.mockRestore()
    }
  })

  it('trigger 未传时降级 unspecified（不强制改动既有调用方）', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const dataDir = makeMarkersDataDir()
      try {
        writeMarkersFile(dataDir, [...MARKERS])
        await reapOrphanPiProcesses({
          dataDir,
          ownPid: OWN_PID,
          listProcesses: async () => psStdout([row(902, 1, piCmd(MARKERS[0]!))]),
          signal: vi.fn(),
          delay: vi.fn(async () => {}),
          readSpawnMarkers: () => readSpawnMarkerList(dataDir),
        })
      } finally {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
      const decisionCall = logSpy.mock.calls.find(([msg]) => msg === '[orphan-reap] kill decision')
      expect((decisionCall![1] as Record<string, unknown>).trigger).toBe('unspecified')
    } finally {
      logSpy.mockRestore()
    }
  })
})
