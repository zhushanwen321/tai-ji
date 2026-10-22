/**
 * 跨代残留清理单测（L2，验收 ④，设计 §3.3 D7）：残留 socket 探活清理（死删活留）+
 * 孤儿引擎 pid 收割（owner runtime 死 → 立即组杀；owner 活 → 跳过；引擎已死 → 删档；
 * pid 复用 → 不杀只删）。附 paths 形状断言（socket 长度门禁 / pid 文件名清洗）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import * as net from 'node:net'
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { isPidAlive } from '../../../utils/protocol-background-task.js'
import {
  assertSocketPathLength,
  CONTROL_ENGINES_DIR_NAME,
  getControlEnginesDir,
  getControlRunDir,
  getControlSocketPath,
  getEnginePidFilePath,
} from '../../../infra/subagent-control/paths.js'
import { sweepOrphanEnginePids, sweepStaleControlSockets } from '../../../infra/subagent-control/sweep.js'
import { SubagentControlServer } from '../../../infra/subagent-control/control-server.js'
import { makeServer, makeTmpDir, rmTmpDir, waitFor } from './test-helpers.js'

const tmpDirs: string[] = []
const cleanupJobs: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const job of cleanupJobs.splice(0)) {
    await job()
  }
  await Promise.all(tmpDirs.splice(0).map((d) => rmTmpDir(d)))
})

function listenOn(path: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(path, () => {
      server.removeListener('error', reject)
      resolve(server)
    })
  })
}

describe('stale socket 清理（D7：扫 subagent-*.sock 全族）', () => {
  it('死文件（无监听者）删除；活文件（有监听者）保留', { timeout: 20_000 }, async () => {
    const dataDir = await makeTmpDir('ctl-sweep-')
    tmpDirs.push(dataDir)
    const runDir = getControlRunDir(dataDir)
    mkdirSync(runDir, { recursive: true })

    // 死文件：Node 22 起 server.close() 自动 unlink socket 文件——残留死形态用
    // 普通文件模拟（connect 探活报错即死文件判据，sweep unlink 收敛）
    const deadPath = join(runDir, 'subagent-88888.sock')
    writeFileSync(deadPath, '')
    expect(existsSync(deadPath)).toBe(true)

    // 活文件：真监听在场
    const livePath = join(runDir, 'subagent-99999.sock')
    const live = await listenOn(livePath)
    cleanupJobs.push(async () => {
      await new Promise<void>((resolve) => live.close(() => resolve()))
    })

    await sweepStaleControlSockets(dataDir, getControlSocketPath(dataDir))
    expect(existsSync(deadPath)).toBe(false)
    expect(existsSync(livePath)).toBe(true)
  })

  it('server init 触发同款清理：init 前放置的死残留被删，server 正常 listen', { timeout: 20_000 }, async () => {
    const dataDir = await makeTmpDir('ctl-sweep2-')
    tmpDirs.push(dataDir)
    const runDir = getControlRunDir(dataDir)
    mkdirSync(runDir, { recursive: true })
    const deadPath = join(runDir, 'subagent-77777.sock')
    writeFileSync(deadPath, '')

    const server = makeServer(dataDir)
    cleanupJobs.push(() => server.destroy())
    await server.init()
    expect(existsSync(deadPath)).toBe(false)
    expect(existsSync(getControlSocketPath(dataDir))).toBe(true)
  })
})

describe('孤儿引擎 pid 收割（owner runtime 死 → 立即组杀）', () => {
  it('owner 死 + 引擎活 → 组杀 + 删档；owner 活 → 跳过；引擎已死 → 删档不杀', { timeout: 30_000 }, async () => {
    const dataDir = await makeTmpDir('ctl-pid-')
    tmpDirs.push(dataDir)
    const enginesDir = getControlEnginesDir(dataDir)
    mkdirSync(enginesDir, { recursive: true })

    // ① 孤儿：owner runtimePid 死（不可能的 pid），引擎 = 真实长驻 node 进程
    const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    const orphanPid = orphan.pid
    if (orphanPid === null || orphanPid === undefined) throw new Error('spawn pid unavailable')
    expect(orphanPid).toBeGreaterThan(0)
    writeFileSync(join(enginesDir, 'sess-1-fake-1-ch-1.pid'), JSON.stringify({
      pid: orphanPid,
      spawnedAt: Date.now(),
      engineId: 'fake-1',
      rootSessionId: 'sess-1',
      runtimePid: 999_999_999,
      instanceId: '999999999',
      hostKind: 'runtime-sidecar',
    }))

    // ② owner 活着（本测试进程）：跳过
    const guarded = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    const guardedPid = guarded.pid
    if (guardedPid === null || guardedPid === undefined) throw new Error('spawn pid unavailable')
    writeFileSync(join(enginesDir, 'sess-1-fake-2-ch-2.pid'), JSON.stringify({
      pid: guardedPid,
      spawnedAt: Date.now(),
      runtimePid: process.pid,
      instanceId: String(process.pid),
      hostKind: 'runtime-sidecar',
    }))

    // ③ 引擎已死：只删档
    writeFileSync(join(enginesDir, 'sess-1-fake-3-ch-3.pid'), JSON.stringify({
      pid: 999_999_998,
      spawnedAt: Date.now(),
      runtimePid: 999_999_999,
    }))

    await sweepOrphanEnginePids(dataDir)
    await waitFor(() => !isPidAlive(orphanPid), 'orphan engine reaped')
    expect(existsSync(join(enginesDir, 'sess-1-fake-1-ch-1.pid'))).toBe(false)
    expect(isPidAlive(guardedPid)).toBe(true)
    expect(existsSync(join(enginesDir, 'sess-1-fake-2-ch-2.pid'))).toBe(true)
    expect(existsSync(join(enginesDir, 'sess-1-fake-3-ch-3.pid'))).toBe(false)

    orphan.kill('SIGKILL')
    guarded.kill('SIGKILL')
  })
})

describe('pid 判据与失败语义（m-rt-3 / m-rt-4）', () => {
  it('m-rt-3：start time 不可得（Windows/ps 不可用）→ 保守跳过击杀并保留 pid 文件', { timeout: 20_000 }, async () => {
    const dataDir = await makeTmpDir('ctl-pid-nostart-')
    tmpDirs.push(dataDir)
    const enginesDir = getControlEnginesDir(dataDir)
    mkdirSync(enginesDir, { recursive: true })
    const engine = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    const enginePid = engine.pid
    if (enginePid === null || enginePid === undefined) throw new Error('spawn pid unavailable')
    const pidFile = join(enginesDir, 'sess-x-fake-x-ch-x.pid')
    writeFileSync(pidFile, JSON.stringify({
      pid: enginePid,
      spawnedAt: Date.now(),
      runtimePid: 999_999_999,
      instanceId: '999999999',
      hostKind: 'runtime-sidecar',
    }))

    const kill = vi.fn()
    await sweepOrphanEnginePids(dataDir, {
      getProcessStartTimeSec: () => undefined,
      killProcessTree: kill,
    })
    expect(kill).not.toHaveBeenCalled()
    expect(isPidAlive(enginePid)).toBe(true)
    expect(existsSync(pidFile)).toBe(true) // 保留 + warn（宁不杀勿误杀）

    engine.kill('SIGKILL')
  })

  it('m-rt-4：kill 未能杀灭（权限/系统错误）→ 保留 pid 文件供下次 sweep', async () => {
    // 确定性同步化（2026-10-22 测试整治，docs/todo/test-single-layer-cleanup.md）：
    // 原形态 spawn 真实长驻进程 + 真实探活 + 真实 30ms 确认窗，有两处时序脆弱点——
    // ① 探测 start time 用「当前秒」，与 spawnedAt 跨秒边界时 pidStartMatchesRegistered
    //   的降级判据（actual <= floor(spawnedAt/1000)）翻转成「pid 已复用」误删档；
    // ② 探活与断言之间的间隙被 CPU 抢占拉长。
    // 「kill 未杀灭」前提改由注入桩表达：owner 判死 / 引擎判活（恒真桩需按 pid 区分，
    // 否则 ownerRuntimeAlive 提前跳过）、start time 固定同秒、kill 空操作、确认窗 0
    // （waitForProcessDeath 立即判超时 = 未死）。决策逻辑「确认窗过后仍活 → 保留」
    // 纯同步可断言；真进程 kill 失败路径的端到端验收由 CI-only 冒烟承接（todo 文档 1.2 节）。
    const dataDir = await makeTmpDir('ctl-pid-killfail-')
    tmpDirs.push(dataDir)
    const enginesDir = getControlEnginesDir(dataDir)
    mkdirSync(enginesDir, { recursive: true })
    const enginePid = 424_242 // 无真实进程——存活与身份由注入桩表达
    const pidFile = join(enginesDir, 'sess-y-fake-y-ch-y.pid')
    writeFileSync(pidFile, JSON.stringify({
      pid: enginePid,
      spawnedAt: 1_000_000, // epoch ms；秒值 1000，与下方 start time 桩同秒
      runtimePid: 999_999_999, // 非真实进程 → owner 判死（桩下同语义）
      instanceId: '999999999',
    }))

    await sweepOrphanEnginePids(dataDir, {
      isPidAlive: (pid) => pid === enginePid, // owner 死 / 引擎活（kill 未杀灭前提）
      getProcessStartTimeSec: () => 1_000, // 固定同秒：通过身份判定，无跨秒翻转
      killProcessTree: () => {},
      killConfirmTimeoutMs: 0, // 确认窗零等待：立即判「仍活」
    })
    expect(existsSync(pidFile)).toBe(true) // 未能杀灭 → 保留供下次 sweep
  })

  it('不可解析 pid 文件 → 保留 + warn（不静默销账）', { timeout: 20_000 }, async () => {
    const dataDir = await makeTmpDir('ctl-pid-corrupt-')
    tmpDirs.push(dataDir)
    const enginesDir = getControlEnginesDir(dataDir)
    mkdirSync(enginesDir, { recursive: true })
    const pidFile = join(enginesDir, 'sess-z-fake-z-ch-z.pid')
    writeFileSync(pidFile, '{"pid":')
    await sweepOrphanEnginePids(dataDir)
    expect(existsSync(pidFile)).toBe(true)
  })
})

describe('paths 形状门禁', () => {
  it('socket 路径含 pid 唯一；超长路径 fail-fast（104 字节门禁）', () => {
    const p1 = getControlSocketPath('/tmp/dd')
    expect(p1).toContain(`subagent-${process.pid}.sock`)
    expect(assertSocketPathLength(p1)).toBeUndefined()

    const deep = `${'/x'.repeat(60)}/run`
    expect(() => assertSocketPathLength(getControlSocketPath(deep))).toThrow(/socket path too long/)
  })

  it('pid 文件名组件清洗（穿越/异常字符收窄为 _）+ 目录名常量', () => {
    const p = getEnginePidFilePath('../../etc', 'eng/ine', 'ch-1', '/tmp/dd')
    expect(p.startsWith(join('/tmp/dd', 'run', CONTROL_ENGINES_DIR_NAME))).toBe(true)
    // 组件清洗：路径分隔符与穿越序列收窄，文件名不含目录分隔符
    expect(basename(p)).toBe('.._.._etc-eng_ine-ch-1.pid')
  })
})
