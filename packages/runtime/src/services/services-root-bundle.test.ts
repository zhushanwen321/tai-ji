import { closeCrashJournal, initCrashJournal } from '../infra/crash-journal.js';
import { logger } from '../infra/logger.js';
import { getSpawnMarkersPath, readSpawnMarkerList } from '../infra/pi/spawn-markers.js';
import { findOrphanPiRows, matchesOwnPiArgv, parsePsOutput, reapOrphanPiProcesses, tokenizeArgv, type PsRow, type ReapOrphanOptions } from './reap-orphan-pi.js';
import { ensureAutoRenameDefault, getAutoRenameEnabled, getAutoRenameEnabledPath, getRenameConfigPath, getRenameMaxLength, getRenameMode, getRenameModel, getRenamePrompt, setAutoRenameEnabled, setRenameConfigLockTimingForTest, setRenameMaxLength, setRenameMode, setRenameModel, setRenamePrompt } from './rename-session-config.js';
import { DEFAULT_UI_LOCALE, readUiPreferences, uiPreferencesPath, writeUiPreferences } from './ui-preferences-helper.js';
import { RENAME_INSTRUCTION_MAX_LENGTH } from '@taiji/shared';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/services/reap-orphan-pi.journal.test.ts
// ======================================================================

import type { RenameMode } from '@taiji/shared';
const DATA_DIR = '/Users/tester/.taiji'

const OWN_PID = 100

/** spawn 清单值（判据 v2：argv --extension 值与清单精确相等；形态对齐 reap-orphan-pi.test MARKERS）。 */
const MARKER = '/Applications/TaiJi.app/Contents/Resources/extensions/pi-host-internals'


let dataDir: string

const createdDirs: string[] = []


/** taiji spawn 的 pi 典型 argv（判据 v2 形态：--mode rpc + --no-extensions + --extension 注入段）。 */
function piCmd(extensionPath: string = MARKER): string {
  return `/opt/pi/pi --mode rpc --no-extensions --approve --extension ${extensionPath}`
}


function row(pid: number, ppid: number, command: string): PsRow {
  return { pid, ppid, command }
}


/** ESRCH 错误（signal 0 探活对已死 pid 的 errno 形态）。 */
function esrch(): NodeJS.ErrnoException {
  const e = new Error('no such process') as NodeJS.ErrnoException
  e.code = 'ESRCH'
  return e
}


function psStdout(rows: PsRow[]): string {
  return rows.map(r => `  ${r.pid}   ${r.ppid} ${r.command}`).join('\n') + '\n'
}


/** SIGKILL no-op 注入（journal 测试不真发信号；ESRCH 形态见各用例 override）。 */
function noopSignal(): ReapOrphanOptions['signal'] {
  return () => {}
}


function makeOptions(rows: PsRow[], overrides?: Partial<ReapOrphanOptions>): ReapOrphanOptions {
  return {
    dataDir: DATA_DIR,
    ownPid: OWN_PID,
    readSpawnMarkers: () => [MARKER],
    listProcesses: () => Promise.resolve(psStdout(rows)),
    signal: noopSignal(),
    ...overrides,
  }
}


/** 读 journal 活跃档全部行（不存在 = 零事件）。 */
function readJournalRecords(): Array<Record<string, unknown>> {
  const p = join(dataDir, 'logs', 'crashes', 'runtime.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l !== '')
    .map(l => JSON.parse(l) as Record<string, unknown>)
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('reap-orphan-pi.journal', () => {
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'reap-journal-'))
  createdDirs.push(dataDir)
})
afterAll(() => {
  // maxRetries+retryDelay（教训 d9ad39cb8）：teardown 递归删除与在途异步写竞争的
  // ENOTEMPTY 瞬态重试（pre-commit flake 卫生检查硬要求）
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('reap-orphan-pi → 崩溃 journal reaped 事件（D1 矩阵 reaped 行）', () => {
  it('① 判据命中且处置成功：一条 reaped 事件，含 pid/ppid 与 argv 判据摘要', async () => {
    initCrashJournal(dataDir)
    const result = await reapOrphanPiProcesses(makeOptions([
      row(501, 1, piCmd()),
    ]))
    await closeCrashJournal()

    expect(result.reaped).toEqual([501])
    const records = readJournalRecords()
    expect(records).toHaveLength(1)
    const rec = records[0]!
    expect(rec.layer).toBe('pi')
    expect(rec.event).toBe('reaped')
    // 结构化进程身份（schema 外扩展字段经 writer spread 序列化落盘）
    expect(rec.pid).toBe(501)
    expect(rec.ppid).toBe(1)
    // 判据摘要内嵌 detailDigest：v2 marker 判据说明（argv 匹配 spawn 清单 + ppid=1）
    // + argv 头部可辨识
    const digest = String(rec.detailDigest)
    expect(digest).toContain('ppid=1')
    expect(digest).toContain('spawn marker list')
    expect(digest).toContain('--mode rpc')
  })

  it('④ 防误记：判据未命中（ppid=并存实例 pid / marker 清单外值）→ 零 journal 事件', async () => {
    initCrashJournal(dataDir)
    const result = await reapOrphanPiProcesses(makeOptions([
      row(601, 40842, piCmd()), // 另一合法实例的活跃 pi（ppid=对方 runtime）
      row(602, 1, piCmd('/Users/other/other-ext')), // 其他实例清单外的 pi（argv marker 不匹配）
    ]))
    await closeCrashJournal()

    expect(result.reaped).toEqual([])
    expect(result.failed).toEqual([])
    expect(readJournalRecords()).toEqual([])
  })

  it('④ 防误记：混合命中 + 自有子进程（ppid=ownPid 被防线②排除）→ 仅命中者产生事件', async () => {
    initCrashJournal(dataDir)
    const result = await reapOrphanPiProcesses(makeOptions([
      row(701, OWN_PID, piCmd()), // 本 runtime 活跃子代（不杀）
      row(702, 1, piCmd()), // 真孤儿
    ]))
    await closeCrashJournal()

    expect(result.reaped).toEqual([702])
    const records = readJournalRecords()
    expect(records).toHaveLength(1)
    expect(records[0]!.pid).toBe(702)
  })

  it('④ 处置失败（SIGKILL 抛非 ESRCH）→ 进 failed，journal 记 reap-failed（不记 reaped）', async () => {
    initCrashJournal(dataDir)
    const boom = new Error('operation not permitted')
    const result = await reapOrphanPiProcesses(makeOptions(
      [row(801, 1, piCmd())],
      { signal: () => { throw boom } },
    ))
    await closeCrashJournal()

    expect(result.reaped).toEqual([])
    expect(result.failed).toEqual([801])
    const records = readJournalRecords()
    expect(records).toHaveLength(1)
    const rec = records[0]!
    expect(rec.event).toBe('reap-failed')
    expect(rec.layer).toBe('pi')
    expect(rec.pid).toBe(801)
    expect(rec.ppid).toBe(1)
    expect(String(rec.detailDigest)).toContain('disposal failed')
  })

  it('多孤儿逐一记事件：每 pid 一条，事件 pid 集与 reaped 结果一致', async () => {
    initCrashJournal(dataDir)
    const result = await reapOrphanPiProcesses(makeOptions([
      row(901, 1, piCmd()),
      row(902, 1, piCmd()),
    ]))
    await closeCrashJournal()

    expect(result.reaped).toEqual([901, 902])
    const records = readJournalRecords()
    expect(records.map(r => r.pid)).toEqual([901, 902])
    for (const rec of records) {
      expect(rec.event).toBe('reaped')
      expect(rec.layer).toBe('pi')
    }
  })

})
});

// ======================================================================
// ← src/services/reap-orphan-pi.test.ts
// ======================================================================

/** 本实例数据目录（方案 B 新布局：<dataDir>/agent/sessions/…，判据不再消费 sessions 路径）。 */
const DATA_DIR_m2 = '/Users/tester/.taiji'

const OWN_PID_m2 = 100


/**
 * spawn 清单 fixture（写侧 u16 三根登记规则的两种常见形态；对 matchesOwnPiArgv 而言
 * 只是精确相等目标字符串，形态区分用于正向 ×2 的宿主覆盖：打包 / dev）。
 */
const MARKERS = [
  '/Applications/TaiJi.app/Contents/Resources/extensions/pi-host-internals', // ① 打包资源根
  '/Users/tester/Code/taiji/extensions/universal/todo', // ② dev 仓库源码根（D-11 形态）
] as const


function row_m2(pid: number, ppid: number, command: string): PsRow {
  return { pid, ppid, command }
}


/** taiji spawn 的 pi 典型 argv（rpc-client buildPiArgs 拼参形态：首 flags → --extension 注入段）。 */
function piCmd_m2(extensionPath: string): string {
  return `/opt/pi/pi --mode rpc --no-extensions --approve --extension ${extensionPath}`
}


/** 孤儿 subagent 的 argv（引擎 CLI 直 spawn 形态：buildSpawnArgs 恒定 --no-extensions 基座 + --extension/--skill 注入段，与主 pi 同判据形态）。 */
function subagentMirrorCmd(extensionPath: string): string {
  return `/opt/pi/pi --mode rpc --no-extensions --approve --extension ${extensionPath} --skill /Users/tester/Code/taiji/extensions/universal/subagent-workflow`
}


/** ESRCH 错误（process.kill 对不存在 pid 的 errno 形态）。 */
function esrch_m2(): NodeJS.ErrnoException {
  const e = new Error('process not found') as NodeJS.ErrnoException
  e.code = 'ESRCH'
  return e
}


/** 构造 ps stdout（`ps -axo pid=,ppid=,command=` 的缩进列形态）。 */
function psStdout_m2(rows: PsRow[]): string {
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

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('reap-orphan-pi', () => {
describe('parsePsOutput（ps 三列解析）', () => {
  it('解析 pid/ppid/command 三列，command 含空格整段保留', () => {
    const out = psStdout_m2([
      row_m2(123, 1, piCmd_m2('/a/b')),
      row_m2(456, 123, 'node server.js'),
    ])
    expect(parsePsOutput(out)).toEqual([
      { pid: 123, ppid: 1, command: piCmd_m2('/a/b') },
      { pid: 456, ppid: 123, command: 'node server.js' },
    ])
  })

  it('空行与非数字列行跳过（fail-open 只影响覆盖范围不影响精确性）', () => {
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
    expect(matchesOwnPiArgv(row_m2(1, 1, piCmd_m2(MARKERS[0])), [...MARKERS])).toBe(true)
  })

  it('正向：dev 仓库清单值（D-11 源码根形态）同理命中', () => {
    expect(matchesOwnPiArgv(row_m2(1, 1, piCmd_m2(MARKERS[1])), [...MARKERS])).toBe(true)
  })

  // —— 反向三态（V10② 的判据层）——
  it('反向：缺 --mode rpc（用户终端交互 pi，即使带 --no-extensions 与清单值）不命中', () => {
    expect(matchesOwnPiArgv(row_m2(1, 1, `/opt/pi/pi --no-extensions --approve --extension ${MARKERS[0]}`), [...MARKERS])).toBe(false)
  })

  it('反向：无 --no-extensions 不命中（主判别位；AGENTS.md 实测命令模板形态——带清单值也不杀）', () => {
    expect(matchesOwnPiArgv(row_m2(1, 1, `/opt/pi/pi --mode rpc --approve --extension ${MARKERS[0]}`), [...MARKERS])).toBe(false)
  })

  it('反向：--extension 值不在清单（用户配置来源路径）不命中', () => {
    expect(matchesOwnPiArgv(row_m2(1, 1, piCmd_m2('/Users/tester/some-project/.pi/extensions/my-ext')), [...MARKERS])).toBe(false)
  })

  it('反向：空清单恒不命中（防御位，正常路径由编排层清单缺失跳过兜住）', () => {
    expect(matchesOwnPiArgv(row_m2(1, 1, piCmd_m2(MARKERS[0])), [])).toBe(false)
  })

  it('--skill 值与清单精确相等同样命中（③ 的两个值承载 flag 都参与）', () => {
    const argv = `/opt/pi/pi --mode rpc --no-extensions --skill ${MARKERS[0]}`
    expect(matchesOwnPiArgv(row_m2(1, 1, argv), [...MARKERS])).toBe(true)
  })

  it('精确等值：/a/b 与 /a/bc 双向不混淆（禁前缀/子串）', () => {
    expect(matchesOwnPiArgv(row_m2(1, 1, piCmd_m2('/a/bc')), ['/a/b'])).toBe(false)
    expect(matchesOwnPiArgv(row_m2(1, 1, piCmd_m2('/a/b')), ['/a/bc'])).toBe(false)
  })

  it('参数顺序无关：--extension/--mode/--no-extensions 相对位置任意', () => {
    expect(matchesOwnPiArgv(row_m2(1, 1, `pi --extension ${MARKERS[0]} --no-extensions --mode rpc`), [...MARKERS])).toBe(true)
  })

  it('= 等号形态：--mode=rpc / --extension=<清单值> 命中', () => {
    expect(matchesOwnPiArgv(row_m2(1, 1, `pi --mode=rpc --no-extensions --extension=${MARKERS[0]}`), [...MARKERS])).toBe(true)
  })

  it('多值注入：多个 --extension 任一命中即命中（appendSkillAndExtensionArgs 逐路径 push 形态）', () => {
    const argv = `/opt/pi/pi --mode rpc --no-extensions --extension /not/in/markers --extension ${MARKERS[1]}`
    expect(matchesOwnPiArgv(row_m2(1, 1, argv), [...MARKERS])).toBe(true)
    expect(matchesOwnPiArgv(row_m2(1, 1, argv), [MARKERS[0]])).toBe(false)
  })

  it('--no-extensions 必须是独立 token（前缀延伸不算，防未来放宽成 startsWith）', () => {
    const argv = `pi --mode rpc --no-extensions-x --extension ${MARKERS[0]}`
    expect(matchesOwnPiArgv(row_m2(1, 1, argv), [...MARKERS])).toBe(false)
  })

  it('引号包裹的空格路径清单值：分词后精确相等命中', () => {
    const staged = '/Users/John Doe/app/Contents/Resources/extensions/my-ext'
    expect(matchesOwnPiArgv(row_m2(1, 1, `pi --mode rpc --no-extensions --extension "${staged}"`), [staged])).toBe(true)
  })
})
describe('findOrphanPiRows（判据④：ppid=1 reparent 证据）', () => {
  it('孤儿判据：argv 匹配 + ppid=1 才杀；并存合法实例子代（ppid=其他活值）与本 runtime 子代（ppid=ownPid）不杀', () => {
    const rows = [
      row_m2(201, 1, piCmd_m2(MARKERS[0])),                          // 真孤儿：旧 runtime 死后 reparent 到 launchd
      row_m2(202, 40842, piCmd_m2(MARKERS[0])),                      // 并存合法实例（如打包版 runtime 40842）的活跃子代——跨实例保护
      row_m2(203, OWN_PID_m2, piCmd_m2(MARKERS[0])),                    // 本 runtime 自己的活跃子进程
      row_m2(OWN_PID_m2, 1, piCmd_m2(MARKERS[0])),                      // 自身行（防御性排除）
      row_m2(204, 1, piCmd_m2('/Users/tester/some-project/.pi/extensions/my-ext')), // argv 不匹配（值不在清单）
      row_m2(205, 1, 'node app.js'),                              // 无关进程
    ]
    expect(findOrphanPiRows(rows, [...MARKERS], OWN_PID_m2).map(r => r.pid)).toEqual([201])
  })

  it('ppid=任意其他活值一律不杀（跨实例保护的直接断言：dev+打包版共存场景）', () => {
    const rows = [
      row_m2(301, 40842, piCmd_m2(MARKERS[0])), // 打包版 runtime 的活跃 pi
      row_m2(302, 99999, piCmd_m2(MARKERS[0])), // 任意非 1、非 ownPid 的父
    ]
    expect(findOrphanPiRows(rows, [...MARKERS], OWN_PID_m2)).toEqual([])
  })

  it('收殓范围扩大（设计 §6.12）：孤儿 subagent argv（--extension + --skill 白名单值）ppid=1 被收', () => {
    const rows = [row_m2(401, 1, subagentMirrorCmd(MARKERS[0]))]
    expect(findOrphanPiRows(rows, [...MARKERS], OWN_PID_m2).map(r => r.pid)).toEqual([401])
  })

  it('两轮时序（V10③）：活跃 subagent（ppid=父进程活值）第一轮不收 → 父进程死后 reparent ppid=1 第二轮收', () => {
    const mainPiPid = 500
    // 同一 subagent pid、同一 argv，仅 ppid 随 reparent 变化（现行父进程 = 引擎 CLI / runtime）
    const firstRound = [row_m2(402, mainPiPid, subagentMirrorCmd(MARKERS[0]))]
    expect(findOrphanPiRows(firstRound, [...MARKERS], OWN_PID_m2)).toEqual([])
    const secondRound = [row_m2(402, 1, subagentMirrorCmd(MARKERS[0]))]
    expect(findOrphanPiRows(secondRound, [...MARKERS], OWN_PID_m2).map(r => r.pid)).toEqual([402])
  })
})
describe('spawn 清单读取与 fail-safe 降级（V10④：宁漏不误杀）', () => {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

  // spy 在 describe 收集期创建，同文件前序节（合并进来的其他来源）的用例产生的
  // console.warn 会残留在计数里——每个用例开跑前先清零，只统计本用例的调用。
  beforeEach(() => {
    warnSpy.mockClear()
  })

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
        ownPid: OWN_PID_m2,
        listProcesses: async () => psStdout_m2([row_m2(501, 1, piCmd_m2(MARKERS[0]))]),
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
        ownPid: OWN_PID_m2,
        listProcesses: async () => psStdout_m2([row_m2(502, 1, piCmd_m2(MARKERS[0]))]),
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

  it('清单非字符串数组（JSON 对象）→ 跳过收殓 + warn 日志（格式检查，防类型混淆误判）', async () => {
    const dataDir = makeMarkersDataDir()
    try {
      mkdirSync(join(dataDir, 'run'), { recursive: true })
      writeFileSync(getSpawnMarkersPath(dataDir), JSON.stringify({ extensions: [MARKERS[0]] }), 'utf-8')
      const signal = vi.fn()
      const res = await reapOrphanPiProcesses({
        dataDir,
        ownPid: OWN_PID_m2,
        listProcesses: async () => psStdout_m2([row_m2(503, 1, piCmd_m2(MARKERS[0]))]),
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
      const signal = vi.fn()
      const res = await reapOrphanPiProcesses({
        dataDir,
        ownPid: OWN_PID_m2,
        listProcesses: async () => psStdout_m2([row_m2(504, 1, piCmd_m2(MARKERS[0]))]),
        signal,
        readSpawnMarkers: realRead(dataDir),
      })
      expect(res.reaped).toEqual([504])
      // 合并后语义取 dev 侧 D5① kill-path-logging 契约（K1-K8 同族）：正常收殓也是 kill 路径，
      // 必须 warn 级留痕并带结构化 kill_source。本行基线为 console.log、dev 升为 console.warn
      // + kill_source（packages/runtime/test/session-lifecycle-attach.test.ts K7 即断言同一行），故不再是
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
      dataDir: DATA_DIR_m2,
      ownPid: OWN_PID_m2,
      listProcesses: async () => psStdout_m2([row_m2(505, 1, piCmd_m2(MARKERS[0]))]),
      signal,
      readSpawnMarkers: () => null,
    })
    expect(res.reaped).toEqual([])
    expect(res.scanned).toBe(1)
    expect(signal).not.toHaveBeenCalled()
  })

  it('清单合法但为空数组 → 判据③结构性失效 warn（reap 全局失效可诊断），零信号', async () => {
    // 与「文件缺失/坏」（null 路径，读侧已 warn）区分：清单在但为空 = 最近一次 spawn
    // 的 staged 集为空，判据③对任何 argv 恒 false——本轮收殓全局失效必须出声。
    const signal = vi.fn()
    const res = await reapOrphanPiProcesses({
      dataDir: DATA_DIR_m2,
      ownPid: OWN_PID_m2,
      listProcesses: async () => psStdout_m2([row_m2(511, 1, piCmd_m2(MARKERS[0]))]),
      signal,
      readProcessStartTime: async () => null,
      readSpawnMarkers: () => [],
    })
    expect(res.reaped).toEqual([])
    expect(res.failed).toEqual([])
    expect(signal).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('marker list is empty')
  })
})
describe('reapOrphanPiProcesses（编排；清单一律注入，与 fs 隔离）', () => {
  it('目标 = 判据 v2 且 ppid=1；并存实例与本 runtime 的子代不触碰；SIGKILL 直杀', async () => {
    const stdout = psStdout_m2([
      row_m2(201, 1, piCmd_m2(MARKERS[0])),       // 孤儿（ppid=1）
      row_m2(202, OWN_PID_m2, piCmd_m2(MARKERS[0])), // 本 runtime 子进程
      row_m2(205, 40842, piCmd_m2(MARKERS[0])),   // 并存合法实例（打包版）的活跃 pi——跨实例保护
      row_m2(204, 1, 'node app.js'),           // 无关进程
    ])
    const signal = vi.fn()
    const res = await reapOrphanPiProcesses({
      dataDir: DATA_DIR_m2,
      ownPid: OWN_PID_m2,
      listProcesses: async () => stdout,
      signal,
      readSpawnMarkers: () => [...MARKERS],
    })
    expect(res.reaped).toEqual([201])
    expect(res.failed).toEqual([])
    expect(res.scanned).toBe(4)
    expect(signal).toHaveBeenCalledTimes(1)
    expect(signal).toHaveBeenCalledWith(201, 'SIGKILL')
  })

  it('SIGKILL 即 ESRCH（stdin-EOF 自杀链先到）：按已回收计，不记失败', async () => {
    const signal = vi.fn((pid: number, sig: 'SIGKILL') => {
      if (sig === 'SIGKILL' && pid === 401) throw esrch_m2()
    })
    const res = await reapOrphanPiProcesses({
      dataDir: DATA_DIR_m2,
      ownPid: OWN_PID_m2,
      listProcesses: async () => psStdout_m2([row_m2(401, 1, piCmd_m2(MARKERS[0]))]),
      signal,
      readSpawnMarkers: () => [...MARKERS],
    })
    expect(res.reaped).toEqual([401])
    expect(res.failed).toEqual([])
  })

  it('真信号错误（非 ESRCH）：记入 failed 不抛', async () => {
    const signal = vi.fn((_pid: number, sig: 'SIGKILL') => {
      if (sig === 'SIGKILL') {
        const e = new Error('not permitted') as NodeJS.ErrnoException
        e.code = 'EPERM'
        throw e
      }
    })
    const res = await reapOrphanPiProcesses({
      dataDir: DATA_DIR_m2,
      ownPid: OWN_PID_m2,
      listProcesses: async () => psStdout_m2([row_m2(601, 1, piCmd_m2(MARKERS[0]))]),
      signal,
      readSpawnMarkers: () => [...MARKERS],
    })
    expect(res.reaped).toEqual([])
    expect(res.failed).toEqual([601])
  })

  it('枚举失败（ps 不可用）：降级 unsupported，不抛、不处置、不读清单', async () => {
    const signal = vi.fn()
    const readSpawnMarkers = vi.fn(() => [...MARKERS])
    const res = await reapOrphanPiProcesses({
      dataDir: DATA_DIR_m2,
      ownPid: OWN_PID_m2,
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
        dataDir: DATA_DIR_m2,
        ownPid: OWN_PID_m2,
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
      dataDir: DATA_DIR_m2,
      ownPid: OWN_PID_m2,
      listProcesses: async () => psStdout_m2([row_m2(701, 1, 'node app.js')]),
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
      const dataDir = makeMarkersDataDir()
      try {
        writeMarkersFile(dataDir, [...MARKERS])
        await reapOrphanPiProcesses({
          dataDir,
          ownPid: OWN_PID_m2,
          trigger: 'startup-sweep',
          listProcesses: async () => psStdout_m2([
            row_m2(801, 1, piCmd_m2(MARKERS[0]!)),
            row_m2(802, 1, piCmd_m2(MARKERS[1]!)),
          ]),
          signal,
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
          ownPid: OWN_PID_m2,
          listProcesses: async () => psStdout_m2([row_m2(901, 1, 'node app.js')]),
          signal: vi.fn(),
          readSpawnMarkers: () => readSpawnMarkerList(dataDir),
        })
        await reapOrphanPiProcesses({
          dataDir,
          ownPid: OWN_PID_m2,
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
          ownPid: OWN_PID_m2,
          listProcesses: async () => psStdout_m2([row_m2(902, 1, piCmd_m2(MARKERS[0]!))]),
          signal: vi.fn(),
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
});

// ======================================================================
// ← src/services/rename-session-config.test.ts
// ======================================================================

// ── 共用装置（各 describe 的 tmp 数据目录 + ext 配置文件读写）──────────
// 收敛自各 describe 内的重复副本（fallow 重复块告警：装置曾按 describe 复制六份）。
// beforeEach/afterEach 须在 describe 体内调用才注册到对应 scope，故以工厂函数形态提供。

/**
 * 临时数据目录装置：beforeEach 建目录并 stub TAIJI_AGENT_DATA_DIR，afterEach 还原 env
 * 并删目录。返回 tmpRoot 取值函数（测试体内调用取当前用例的目录）。
 * extraTeardown 在 afterEach 最先执行（域专属还原，如锁参数复位）。
 */
function useTmpDataDir(prefix: string, extraTeardown?: () => void): () => string {
  let tmpRoot = ''
  beforeEach(() => {
    // 每个测试独立临时目录，避免互相干扰
    tmpRoot = mkdtempSync(join(tmpdir(), prefix))
    // getPiAgentDir 经 getDataDir 读 TAIJI_AGENT_DATA_DIR → 临时目录/agent
    vi.stubEnv('TAIJI_AGENT_DATA_DIR', tmpRoot)
  })
  afterEach(() => {
    extraTeardown?.()
    vi.unstubAllEnvs()
    rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  return () => tmpRoot
}


/** rename-session ext 配置文件路径（<TAIJI_AGENT_DATA_DIR>/agent/config/...，各域 describe 共用）。 */
const renameConfigPath = (tmpRoot: string) =>
  join(tmpRoot, 'agent', 'config', 'rename-session-ext-config.json')


/** 写入原始配置 JSON（预建目录）。 */
function writeRawConfig(tmpRoot: string, raw: unknown): void {
  const p = renameConfigPath(tmpRoot)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2), 'utf-8')
}


/** 读回配置 JSON（parse 后对象）。 */
function readRawConfig(tmpRoot: string): Record<string, unknown> {
  return JSON.parse(readFileSync(renameConfigPath(tmpRoot), 'utf-8')) as Record<string, unknown>
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('rename-session-config', () => {
describe('auto-rename enabled 标志文件', () => {
  const tmpRoot = useTmpDataDir('auto-rename-test-')

  it('getAutoRenameEnabledPath 解析到 <TAIJI_AGENT_DATA_DIR>/agent/auto-rename-enabled', () => {
    expect(getAutoRenameEnabledPath()).toBe(join(tmpRoot(), 'agent', 'auto-rename-enabled'))
  })

  it('文件不存在时 getAutoRenameEnabled 返回 false（默认关闭）', () => {
    expect(getAutoRenameEnabled()).toBe(false)
  })

  it('setAutoRenameEnabled(true) 创建文件后 getAutoRenameEnabled 返回 true', () => {
    setAutoRenameEnabled(true)
    expect(existsSync(getAutoRenameEnabledPath())).toBe(true)
    expect(getAutoRenameEnabled()).toBe(true)
  })

  it('setAutoRenameEnabled(false) 删除已存在的文件', () => {
    setAutoRenameEnabled(true)
    expect(getAutoRenameEnabled()).toBe(true)
    setAutoRenameEnabled(false)
    expect(existsSync(getAutoRenameEnabledPath())).toBe(false)
    expect(getAutoRenameEnabled()).toBe(false)
  })

  it('文件不存在时 setAutoRenameEnabled(false) 不报错（吞 ENOENT）', () => {
    expect(() => setAutoRenameEnabled(false)).not.toThrow()
    expect(getAutoRenameEnabled()).toBe(false)
  })
})
describe('ensureAutoRenameDefault', () => {
  const tmpRoot = useTmpDataDir('auto-rename-init-')
  const initializedPath = () => join(tmpRoot(), 'agent', 'auto-rename-initialized')

  it('首次调用：创建 initialized 标记 + 开启 auto-rename', () => {
    expect(existsSync(initializedPath())).toBe(false)
    expect(getAutoRenameEnabled()).toBe(false)

    ensureAutoRenameDefault()

    // initialized 标记已写
    expect(existsSync(initializedPath())).toBe(true)
    // 默认开启 auto-rename
    expect(getAutoRenameEnabled()).toBe(true)
  })

  it('幂等性：initialized 标记存在时不干预，不覆盖用户的关闭操作', () => {
    // 模拟用户已关闭 auto-rename（initialized 标记存在，但 enabled 文件不存在）
    setAutoRenameEnabled(false)
    // 手动创建 initialized 标记（表示已完成首次初始化）
    // 先建好 agent/ 目录再写标记（ensureAutoRenameDefault 检测到标记存在会直接 return，
    // 不会自己 mkdir，所以测试要预先把目录和标记造好）
    mkdirSync(dirname(initializedPath()), { recursive: true })
    writeFileSync(initializedPath(), '', 'utf-8')

    ensureAutoRenameDefault()

    // 用户关闭的状态被保留，没有被 boot 反复重开
    expect(getAutoRenameEnabled()).toBe(false)
    // initialized 标记仍在
    expect(existsSync(initializedPath())).toBe(true)
  })

  it('初始化失败不抛错（不阻塞 boot）', () => {
    // 让 getPiAgentDir 抛错：把 TAIJI_AGENT_DATA_DIR 指向一个不存在的根，使 mkdirSync 失败
    // （mock 一个不可创建的路径：指向一个已被删除的目录的子路径）
    const { mkdirSync } = require('node:fs')
    const origMkdir = mkdirSync
    require('node:fs').mkdirSync = vi.fn(() => { throw new Error('mock mkdir failure') })

    expect(() => ensureAutoRenameDefault()).not.toThrow()

    // 恢复
    require('node:fs').mkdirSync = origMkdir
  })
})
describe('rename-session 模型配置（config/rename-session-ext-config.json）', () => {
  const tmpRoot = useTmpDataDir('rename-model-test-')
  const configPath = () => renameConfigPath(tmpRoot())

  it('getRenameConfigPath 解析到 <TAIJI_AGENT_DATA_DIR>/agent/config/rename-session-ext-config.json', () => {
    expect(getRenameConfigPath()).toBe(join(tmpRoot(), 'agent', 'config', 'rename-session-ext-config.json'))
  })

  it('getRenameModel：文件不存在返回空串（未设置）', () => {
    expect(getRenameModel()).toBe('')
  })

  it('getRenameModel：正常文件读出 model.ref', () => {
    writeRawConfig(tmpRoot(), { enabled: true, model: { type: 'ref', ref: 'p1/m1' }, maxTitleLength: 50, thinkingLevel: 'off' })
    expect(getRenameModel()).toBe('p1/m1')
  })

  it('getRenameModel：model 字段缺失 / 非法形态返回空串', () => {
    writeRawConfig(tmpRoot(), { enabled: true })
    expect(getRenameModel()).toBe('')
    writeRawConfig(tmpRoot(), { model: 'p1/m1' })
    expect(getRenameModel()).toBe('')
    writeRawConfig(tmpRoot(), { model: { type: 'scoped' } })
    expect(getRenameModel()).toBe('')
    writeRawConfig(tmpRoot(), { model: { type: 'ref', ref: 123 } })
    expect(getRenameModel()).toBe('')
  })

  it('getRenameModel：坏 JSON 返回空串（不抛错）', () => {
    writeRawConfig(tmpRoot(), '{ not valid json')
    expect(getRenameModel()).toBe('')
  })

  it('setRenameModel：读改写保留其他字段与未知字段', () => {
    writeRawConfig(tmpRoot(), { enabled: true, model: { type: 'ref', ref: 'old/m' }, maxTitleLength: 30, thinkingLevel: 'low', futureField: { a: 1 } })
    setRenameModel('p1/m1')

    // 整对象断言：被写域更新 + 其余字段（含未知字段）原样保留 + 无多余字段
    expect(readRawConfig(tmpRoot())).toEqual({
      model: { type: 'ref', ref: 'p1/m1' },
      enabled: true,
      maxTitleLength: 30,
      thinkingLevel: 'low',
      futureField: { a: 1 },
    })
    // get/set roundtrip
    expect(getRenameModel()).toBe('p1/m1')
  })

  it('setRenameModel：文件不存在时以默认基底建文件（基底七字段与 extension DEFAULT_RENAME_CONFIG 同批收敛）', () => {
    setRenameModel('p1/m1')

    expect(existsSync(configPath())).toBe(true)
    // 默认基底字段（与 extension DEFAULT_RENAME_CONFIG 一致，全字段锁定）
    expect(readRawConfig(tmpRoot())).toEqual({
      model: { type: 'ref', ref: 'p1/m1' },
      enabled: false,
      mode: 'first-stop',
      maxTitleLength: 50,
      thinkingLevel: 'off',
      style: 'slug',
      customInstruction: '',
    })
  })

  it('setRenameModel：空串清除回未设置', () => {
    writeRawConfig(tmpRoot(), { model: { type: 'ref', ref: 'p1/m1' } })
    setRenameModel('')
    expect(getRenameModel()).toBe('')
    expect(readRawConfig(tmpRoot())['model']).toEqual({ type: 'ref', ref: '' })
  })

  it('setRenameModel：非空但不含 "/" 归一为空串（extension parseModelRef 不认）', () => {
    setRenameModel('garbage-no-slash')
    expect(getRenameModel()).toBe('')
    expect(readRawConfig(tmpRoot())['model']).toEqual({ type: 'ref', ref: '' })
  })

  it('setRenameModel：坏 JSON 用默认基底覆写（与 extension 读取侧回退语义一致）', () => {
    writeRawConfig(tmpRoot(), '{ corrupted')
    setRenameModel('p1/m1')
    expect(getRenameModel()).toBe('p1/m1')
    expect(readRawConfig(tmpRoot())['enabled']).toBe(false)
  })
})
describe('rename-session 模式配置（config/rename-session-ext-config.json 的 mode 字段，设计 D1）', () => {
  const tmpRoot = useTmpDataDir('rename-mode-test-')

  it('getRenameMode：文件不存在返回默认 first-stop（旧 config 零迁移，与 extension normalize 同语义）', () => {
    expect(getRenameMode()).toBe('first-stop')
  })

  it('getRenameMode：正常文件读出三值', () => {
    writeRawConfig(tmpRoot(), { mode: 'first-prompt' })
    expect(getRenameMode()).toBe('first-prompt')
    writeRawConfig(tmpRoot(), { mode: 'first-stop' })
    expect(getRenameMode()).toBe('first-stop')
    writeRawConfig(tmpRoot(), { mode: 'agent-tool' })
    expect(getRenameMode()).toBe('agent-tool')
  })

  it('getRenameMode：字段缺失 / 非法值回默认 first-stop', () => {
    writeRawConfig(tmpRoot(), { enabled: true })
    expect(getRenameMode()).toBe('first-stop')
    writeRawConfig(tmpRoot(), { mode: 'weird-mode' })
    expect(getRenameMode()).toBe('first-stop')
    writeRawConfig(tmpRoot(), { mode: 123 })
    expect(getRenameMode()).toBe('first-stop')
  })

  it('getRenameMode：坏 JSON 回默认 first-stop（不抛错）', () => {
    writeRawConfig(tmpRoot(), '{ not valid json')
    expect(getRenameMode()).toBe('first-stop')
  })

  it('setRenameMode：读改写保留其他字段（含 model）与未知字段 + set-get 往返', () => {
    writeRawConfig(tmpRoot(), { enabled: true, mode: 'first-stop', model: { type: 'ref', ref: 'p1/m1' }, maxTitleLength: 30, futureField: { a: 1 } })
    setRenameMode('agent-tool')

    expect(readRawConfig(tmpRoot())).toEqual({
      mode: 'agent-tool',
      model: { type: 'ref', ref: 'p1/m1' },
      enabled: true,
      maxTitleLength: 30,
      futureField: { a: 1 },
    })
    // set-get roundtrip
    expect(getRenameMode()).toBe('agent-tool')
  })

  it('setRenameMode：文件不存在时以默认基底建文件（三处默认值真相收敛：基底含 mode: first-stop）', () => {
    setRenameMode('first-prompt')

    expect(existsSync(renameConfigPath(tmpRoot()))).toBe(true)
    // 默认基底七字段（与 setRenameModel 用例同款基底，mode 为本域写入值）
    expect(readRawConfig(tmpRoot())).toEqual({
      mode: 'first-prompt',
      enabled: false,
      model: { type: 'ref', ref: '' },
      maxTitleLength: 50,
      thinkingLevel: 'off',
      style: 'slug',
      customInstruction: '',
    })
  })

  it('setRenameMode：非法值归一为 first-stop（读侧同语义，写侧不放大坏值）', () => {
    setRenameMode('not-a-mode' as unknown as RenameMode)
    expect(getRenameMode()).toBe('first-stop')
    expect(readRawConfig(tmpRoot())['mode']).toBe('first-stop')
  })

  it('setRenameMode：坏 JSON 用默认基底覆写（与 setRenameModel 同款回退）', () => {
    writeRawConfig(tmpRoot(), '{ corrupted')
    setRenameMode('first-prompt')
    expect(getRenameMode()).toBe('first-prompt')
    expect(readRawConfig(tmpRoot())['enabled']).toBe(false)
  })

  it('mode 写锁与 model 写锁同源：setRenameMode 后无 .lock 残留且 setRenameModel 仍可写（同一把锁协议）', () => {
    setRenameMode('agent-tool')
    setRenameModel('p1/m1')
    expect(existsSync(`${renameConfigPath(tmpRoot())}.lock`)).toBe(false)
    expect(getRenameMode()).toBe('agent-tool')
    expect(getRenameModel()).toBe('p1/m1')
  })
})
describe('rename-session-ext-config 写锁（D1e 跨进程锁）', () => {
  // 参照 pi-settings-store.test.ts 的锁测试模式：同一把 lockfile（<config>.json.lock，
  // realpath:false）模拟 extension 侧写方，验证 runtime RMW 的互斥与降级语义。
  // extraTeardown：恢复锁参数默认值，避免压缩预算泄漏到后续用例
  const tmpRoot = useTmpDataDir('rename-model-lock-test-', () => setRenameConfigLockTimingForTest({}))
  const configPath = () => renameConfigPath(tmpRoot())

  it('写完释放锁：.lock 目录不残留（残留会困住后续写方）', () => {
    setRenameModel('p1/m1')
    expect(existsSync(`${configPath()}.lock`)).toBe(false)
    expect(getRenameModel()).toBe('p1/m1')
  })

  it('锁内重读最新：外部持锁写方（模拟 extension）写的字段不被本次 RMW 覆盖', () => {
    setRenameModel('p1/m1')
    // 模拟 pi-rename-session extension 持同一把锁写 enabled/maxTitleLength
    //（llm-shared saveConfig 约定的 lockfile 路径 = 目标文件 + '.lock'）
    const release = lockfile.lockSync(configPath(), { realpath: false })
    try {
      const raw = JSON.parse(readFileSync(configPath(), 'utf-8')) as Record<string, unknown>
      raw['enabled'] = true
      raw['maxTitleLength'] = 30
      writeFileSync(configPath(), JSON.stringify(raw, null, 2), 'utf-8')
    } finally {
      release()
    }
    setRenameModel('p2/m2')
    const saved = JSON.parse(readFileSync(configPath(), 'utf-8')) as Record<string, unknown>
    // model 域被本次写更新，extension 写的域被锁内重读吃进（不覆盖）
    expect(saved['model']).toEqual({ type: 'ref', ref: 'p2/m2' })
    expect(saved['enabled']).toBe(true)
    expect(saved['maxTitleLength']).toBe(30)
  })

  it('fail-fast：锁被外部持有超出重试预算 → 抛 ELOCKED，文件保持原样', () => {
    setRenameModel('p1/m1')
    // 压缩预算：10ms/次 × 预算 60ms，快速走完 fail-fast 路径
    setRenameConfigLockTimingForTest({ retryDelayMs: 10, retryBudgetMs: 60 })
    const release = lockfile.lockSync(configPath(), { realpath: false })
    let err: unknown
    try {
      setRenameModel('blocked/m')
    } catch (e) {
      err = e
    } finally {
      release()
    }
    // fail-fast：预算耗尽抛错（对齐 pi 放弃保存语义），而非静默丢弃或死等
    expect((err as { code?: string } | undefined)?.code).toBe('ELOCKED')
    expect(getRenameModel()).toBe('p1/m1') // 本次写入被放弃
    // 锁释放后恢复正常
    setRenameModel('after/m')
    expect(getRenameModel()).toBe('after/m')
  })

  it('目录不存在时首写：锁工具先建父目录，写入成功', () => {
    expect(existsSync(dirname(configPath()))).toBe(false)
    setRenameModel('first/m')
    expect(existsSync(configPath())).toBe(true)
    expect(getRenameModel()).toBe('first/m')
  })
})
describe('rename-session 标题提示词（style + customInstruction 合并读写，rename-prompt-config）', () => {
  const tmpRoot = useTmpDataDir('rename-prompt-test-')

  it('getRenamePrompt：文件不存在 = 从未配置（corrupted:false，默认 slug + 空指令）', () => {
    expect(getRenamePrompt()).toEqual({ style: 'slug', instruction: '', corrupted: false })
  })

  it('getRenamePrompt：正常文件读出 style + customInstruction', () => {
    writeRawConfig(tmpRoot(), { style: 'sentence', customInstruction: '' })
    expect(getRenamePrompt()).toEqual({ style: 'sentence', instruction: '', corrupted: false })
    writeRawConfig(tmpRoot(), { style: 'custom', customInstruction: '生成不超过 12 字的中文标题' })
    expect(getRenamePrompt()).toEqual({ style: 'custom', instruction: '生成不超过 12 字的中文标题', corrupted: false })
  })

  it('getRenamePrompt：坏 JSON / 非 object → corrupted:true 防御回默认（不抛错）', () => {
    writeRawConfig(tmpRoot(), '{ not valid json')
    expect(getRenamePrompt()).toEqual({ style: 'slug', instruction: '', corrupted: true })
    writeRawConfig(tmpRoot(), [1, 2])
    expect(getRenamePrompt().corrupted).toBe(true)
  })

  it('getRenamePrompt：字段级回退（style 非法 → slug；instruction 非法 → 空串；corrupted 不误报）', () => {
    writeRawConfig(tmpRoot(), { style: 'weird', customInstruction: 42 })
    const snap = getRenamePrompt()
    expect(snap.style).toBe('slug')
    expect(snap.instruction).toBe('')
    expect(snap.corrupted).toBe(false)
  })

  it('setRenamePrompt：合并写两字段，保留其他字段（含 model/maxTitleLength/未知字段）', () => {
    writeRawConfig(tmpRoot(), { enabled: true, mode: 'first-prompt', model: { type: 'ref', ref: 'p1/m1' }, maxTitleLength: 30, futureField: { a: 1 } })
    const applied = setRenamePrompt('custom', '自定义指令')

    expect(applied).toEqual({ style: 'custom', instruction: '自定义指令', corrupted: false })
    expect(readRawConfig(tmpRoot())).toEqual({
      style: 'custom',
      customInstruction: '自定义指令',
      mode: 'first-prompt',
      model: { type: 'ref', ref: 'p1/m1' },
      enabled: true,
      maxTitleLength: 30,
      futureField: { a: 1 },
    })
  })

  it('setRenamePrompt：文件不存在时以默认基底建文件', () => {
    setRenamePrompt('emoji', '')

    expect(existsSync(renameConfigPath(tmpRoot()))).toBe(true)
    const saved = readRawConfig(tmpRoot())
    expect(saved['style']).toBe('emoji')
    expect(saved['customInstruction']).toBe('')
    expect(saved['enabled']).toBe(false)
  })

  it('setRenamePrompt：非法 style 归一 slug；非 string instruction 归一空串（reply = 生效值）', () => {
    const applied = setRenamePrompt('fancy' as unknown as ReturnType<typeof getRenamePrompt>['style'], undefined as unknown as string)
    expect(applied).toEqual({ style: 'slug', instruction: '', corrupted: false })
    expect(readRawConfig(tmpRoot())['style']).toBe('slug')
  })

  it('setRenamePrompt：超长 instruction 防御截断（与 extension normalize 同限 2000 码点）', () => {
    const long = 'a'.repeat(2500)
    const applied = setRenamePrompt('custom', long)
    expect(Array.from(applied.instruction)).toHaveLength(2000)
    expect(Array.from(readRawConfig(tmpRoot())['customInstruction'] as string)).toHaveLength(2000)
  })
})
describe('rename-session 标题最大长度（maxTitleLength 字段）', () => {
  const tmpRoot = useTmpDataDir('rename-maxlen-test-')

  it('getRenameMaxLength：文件不存在 / 字段非法 / 坏 JSON → 默认 50（与 extension normalize 同语义）', () => {
    expect(getRenameMaxLength()).toBe(50)
    writeRawConfig(tmpRoot(), { maxTitleLength: 30.5 })
    expect(getRenameMaxLength()).toBe(50)
    writeRawConfig(tmpRoot(), { maxTitleLength: 0 })
    expect(getRenameMaxLength()).toBe(50)
    writeRawConfig(tmpRoot(), '{ bad')
    expect(getRenameMaxLength()).toBe(50)
  })

  it('getRenameMaxLength：正常文件读出值', () => {
    writeRawConfig(tmpRoot(), { maxTitleLength: 80 })
    expect(getRenameMaxLength()).toBe(80)
  })

  it('getRenameMaxLength：文件不存在（ENOENT）→ 静默回默认 50，不留痕（从未配置属正常回退）', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      expect(getRenameMaxLength()).toBe(50)
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('getRenameMaxLength：非 ENOENT 读失败（EISDIR 等真 IO 故障）→ warn 留痕且返回默认 50', () => {
    // 把配置路径置换成同名目录：readFileSync(目录) 抛 EISDIR（非 ENOENT），命中读失败留痕分支
    mkdirSync(renameConfigPath(tmpRoot()), { recursive: true })
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      expect(getRenameMaxLength()).toBe(50)
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0]?.[0]).toContain('getRenameMaxLength')
      expect(warnSpy.mock.calls[0]?.[0]).toContain('50')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('setRenameMaxLength：读改写只覆盖 maxTitleLength，保留其他字段 + 合法值往返', () => {
    writeRawConfig(tmpRoot(), { enabled: true, mode: 'first-stop', model: { type: 'ref', ref: 'p1/m1' } })
    setRenameMaxLength(24)

    expect(readRawConfig(tmpRoot())).toEqual({
      maxTitleLength: 24,
      enabled: true,
      mode: 'first-stop',
      model: { type: 'ref', ref: 'p1/m1' },
    })
    expect(getRenameMaxLength()).toBe(24)
  })

  it('setRenameMaxLength：非法值（小数/0/负数/非数字）归一默认 50', () => {
    for (const bad of [30.5, 0, -5, NaN]) {
      setRenameMaxLength(bad as number)
      expect(readRawConfig(tmpRoot())['maxTitleLength']).toBe(50)
    }
  })
})
describe('rename 跨包镜像同值锁定（跨包不 import 的手写镜像，改任一侧须双侧同步，对侧测试同值锁定）', () => {
  it('RENAME_INSTRUCTION_MAX_LENGTH 协议字面值 = 2000（extension pure.ts 手写镜像侧由 pure.test.ts 锁定）', () => {
    expect(RENAME_INSTRUCTION_MAX_LENGTH).toBe(2000)
  })

  it('style 词表五值往返 = 协议 RenameStyle 值域（slug/sentence/emoji/topic/custom，与 extension pure.ts RENAME_STYLES 同构）', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'rename-mirror-test-'))
    vi.stubEnv('TAIJI_AGENT_DATA_DIR', tmpRoot)
    try {
      for (const style of ['slug', 'sentence', 'emoji', 'topic', 'custom'] as const) {
        setRenamePrompt(style, '')
        expect(getRenamePrompt().style).toBe(style)
      }
    } finally {
      vi.unstubAllEnvs()
      rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
});

// ======================================================================
// ← src/services/ui-preferences-helper.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('ui-preferences-helper', () => {
describe('ui-preferences-helper', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ui-prefs-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('写入后文件形状 = { v:1, locale, updatedAt }，且无 tmp 残留（原子写）', () => {
    const result = writeUiPreferences(root, 'zh-CN', 1_700_000_000_000)
    expect(result).toEqual({ ok: true })

    const parsed = JSON.parse(readFileSync(uiPreferencesPath(root), 'utf-8')) as {
      v: number
      locale: string
      updatedAt: number
    }
    expect(parsed).toEqual({ v: 1, locale: 'zh-CN', updatedAt: 1_700_000_000_000 })
    // 原子写：tmp 文件已 rename 掉，目录里只剩正式文件
    expect(readdirSync(root)).toEqual(['ui-preferences.json'])
    expect(readUiPreferences(root)).toBe('zh-CN')
  })

  it('缺失文件：读侧回落默认 en-US（不抛）', () => {
    expect(existsSync(uiPreferencesPath(root))).toBe(false)
    expect(readUiPreferences(root)).toBe(DEFAULT_UI_LOCALE)
    expect(DEFAULT_UI_LOCALE).toBe('en-US')
  })

  it('JSON 损坏：读侧回落默认 en-US + warn', () => {
    writeFileSync(uiPreferencesPath(root), '{ not json', 'utf-8')
    expect(readUiPreferences(root)).toBe('en-US')
  })

  it('locale 非法 / 顶层非对象：读侧回落默认 en-US', () => {
    writeFileSync(uiPreferencesPath(root), JSON.stringify({ v: 1, locale: 'fr-FR' }), 'utf-8')
    expect(readUiPreferences(root)).toBe('en-US')
    writeFileSync(uiPreferencesPath(root), JSON.stringify('zh-CN'), 'utf-8')
    expect(readUiPreferences(root)).toBe('en-US')
    writeFileSync(uiPreferencesPath(root), JSON.stringify(null), 'utf-8')
    expect(readUiPreferences(root)).toBe('en-US')
  })

  it('同值重复推送：短路不重写（updatedAt 保持不变）', () => {
    expect(writeUiPreferences(root, 'zh-CN', 1000)).toEqual({ ok: true })
    // 第二次同值推送带不同 now：短路命中，不落盘
    expect(writeUiPreferences(root, 'zh-CN', 2000)).toEqual({ ok: true })
    const parsed = JSON.parse(readFileSync(uiPreferencesPath(root), 'utf-8')) as { updatedAt: number }
    expect(parsed.updatedAt).toBe(1000)
  })

  it('值变化重写，且多窗口 last-write-wins（最后写入者权威）', () => {
    expect(writeUiPreferences(root, 'zh-CN', 1000).ok).toBe(true)
    expect(writeUiPreferences(root, 'en-US', 2000).ok).toBe(true)
    expect(readUiPreferences(root)).toBe('en-US')
    expect(writeUiPreferences(root, 'zh-CN', 3000).ok).toBe(true)
    expect(readUiPreferences(root)).toBe('zh-CN')
  })

  it('configDir 不存在时自动创建（mkdir recursive）', () => {
    const nested = join(root, 'instances', 'wt-x')
    expect(writeUiPreferences(nested, 'en-US', 1).ok).toBe(true)
    expect(readUiPreferences(nested)).toBe('en-US')
  })

  it('写盘失败：返回 { ok:false, code, error } 不抛（handler 据此走错误信封）', () => {
    // 让 configDir 指向一个已存在的文件 → mkdir recursive 抛 EEXIST/ENOTDIR
    const asFile = join(root, 'not-a-dir')
    writeFileSync(asFile, 'x', 'utf-8')
    const result = writeUiPreferences(asFile, 'zh-CN')
    expect(result.ok).toBe(false)
    expect(result.code).toBe('ui_preferences_io_error')
    expect(typeof result.error).toBe('string')
  })
})
});
