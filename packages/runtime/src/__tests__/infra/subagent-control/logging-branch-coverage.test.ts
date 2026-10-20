/**
 * 日志迁移分支覆盖补测（d244809d2 增量行门禁）：错误/降级分支的 logger 站点此前无测试
 * 路径（正常流不触发）。本文件只验证这些分支的降级语义成立——不抛错、流程继续、状态
 * 可预期；不追日志内容（logger 在单测为 no-op）。
 * 覆盖点：down-queue stdin 不可用/写抛错；sweep stale socket 删除失败 / instanceId 失配 /
 * pid 复用不杀只删 / pid 文件删除失败；control-server 连接 error / 畸形帧丢弃 /
 * destroy 时 socket 文件删除失败 / pid 文件写失败 / pid 文件清理失败 / spawn ENOENT。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, afterEach, vi } from 'vitest'

import { isPidAlive } from '../../../utils/protocol-background-task.js'
import { ChannelDownQueue, type DownStdin } from '../../../infra/subagent-control/down-queue.js'
import {
  SUBAGENT_CONTROL_CLOSED_REASONS,
  SUBAGENT_CONTROL_FRAME_KINDS,
} from '../../../infra/subagent-control/frames.js'
import {
  getControlEnginesDir,
  getControlRunDir,
} from '../../../infra/subagent-control/paths.js'
import { sweepOrphanEnginePids, sweepStaleControlSockets } from '../../../infra/subagent-control/sweep.js'
import {
  byeAndExpectClosed,
  cleanupTestServers,
  connectAgent,
  expectOpened,
  launchSpec,
  makeRegisteredTmpDir,
  setupServer,
  waitFor,
} from './test-helpers.js'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeDownQueue(stdin: DownStdin | null): ChannelDownQueue {
  return new ChannelDownQueue({
    channelId: 'ch-logcov',
    getStdin: () => stdin,
    channelMaxBytes: 1024,
    channelMaxFrames: 16,
    getConnectionBytes: () => 0,
    setConnectionBytes: () => {},
    connectionMaxBytes: 4096,
    onOverflow: () => {},
  })
}

/** 起一个长睡子进程并收窄 pid（pid 复用用例的观测对象；调用方持 engine 负责 finally kill）。 */
function spawnSleeperEngine(): { engine: ChildProcess; enginePid: number } {
  const engine = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const pid = engine.pid
  if (pid === null || pid === undefined) throw new Error('spawn pid unavailable')
  return { engine, enginePid: pid }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await cleanupTestServers()
})

describe('down-queue 降级分支', () => {
  it('stdin 不可用（null）：push 静默丢帧不抛错', () => {
    const queue = makeDownQueue(null)
    expect(() => queue.push('frame-1')).not.toThrow()
  })

  it('stdin.write 抛错（EPIPE 族）：push 吞错降级不外抛', () => {
    const throwingStdin: DownStdin = {
      destroyed: false,
      write: () => {
        throw new Error('EPIPE: broken pipe')
      },
      once: () => undefined,
    }
    const queue = makeDownQueue(throwingStdin)
    expect(() => queue.push('frame-1')).not.toThrow()
  })
})

describe('sweep 降级分支', () => {
  it('stale socket 删除失败（socket 名被目录占位）：保留不阻塞、不抛错', async () => {
    const dataDir = await makeRegisteredTmpDir('ctl-sweepfail-')
    const runDir = getControlRunDir(dataDir)
    mkdirSync(runDir, { recursive: true })
    const blockedPath = join(runDir, 'subagent-77777.sock')
    mkdirSync(blockedPath) // 目录占 socket 名 → unlinkSync 必失败（EISDIR/EPERM）

    await expect(sweepStaleControlSockets(dataDir, '')).resolves.toBeUndefined()
    expect(existsSync(blockedPath)).toBe(true) // best-effort：单项失败保留待下次扫
  })

  it('pid 文件 instanceId 与 runtimePid 不一致 → 判活告警并保守跳过', async () => {
    const dataDir = await makeRegisteredTmpDir('ctl-mirror-id-')
    const enginesDir = getControlEnginesDir(dataDir)
    mkdirSync(enginesDir, { recursive: true })
    const pidFile = join(enginesDir, 'sess-m-fake-m-ch-m.pid')
    writeFileSync(pidFile, JSON.stringify({
      pid: process.pid, // owner = 本测试进程（活）
      spawnedAt: Date.now(),
      runtimePid: process.pid,
      instanceId: 'not-my-instance-id', // 与 String(runtimePid) 不匹配
      hostKind: 'runtime-sidecar',
    }))

    await sweepOrphanEnginePids(dataDir)
    expect(existsSync(pidFile)).toBe(true) // owner 活 → 跳过（身份不可核实只告警）
  })

  it('pid 复用（start 晚于登记）→ 不杀只删；目录只读时删除失败降级保留', { timeout: 20_000 }, async () => {
    const dataDir = await makeRegisteredTmpDir('ctl-reuse-')
    const enginesDir = getControlEnginesDir(dataDir)
    mkdirSync(enginesDir, { recursive: true })
    const { engine, enginePid } = spawnSleeperEngine()
    const pidFile = join(enginesDir, 'sess-r-fake-r-ch-r.pid')
    writeFileSync(pidFile, JSON.stringify({
      pid: enginePid,
      spawnedAt: Date.now(), // 登记 = 现在；注入的 start = 2h 后 → start 晚于登记 = 已复用
      runtimePid: 999_999_999, // owner 死（不可能的 pid）
      instanceId: '999999999',
      hostKind: 'runtime-sidecar',
    }))
    chmodSync(enginesDir, 0o555) // 只读 → removeQuietly 的 unlink 必失败（叠加第二个降级点）
    try {
      await sweepOrphanEnginePids(dataDir, {
        getProcessStartTimeSec: () => Math.floor(Date.now() / 1000) + 7200,
      })
      expect(isPidAlive(enginePid)).toBe(true) // 复用判定 → 不杀
      expect(existsSync(pidFile)).toBe(true) // 删除失败 → 保留（warn 留痕）
    } finally {
      chmodSync(enginesDir, 0o755)
      engine.kill('SIGKILL')
    }
  })
})

describe('control-server 降级分支', () => {
  it('spawn ENOENT（resolveLaunch 注入不可执行 command）→ engine process error → engine_closed(127)', { timeout: 20_000 }, async () => {
    const { agent } = await connectAgent({
      resolveLaunch: async () => ({
        command: '/nonexistent/pi-runner-for-test',
        args: ['--flag'],
        env: { PATH: process.env.PATH ?? '' },
        electronRunAsNode: false,
      }),
    })
    // spawn error 路径没有 engine_opened/engine_open_failed 回执——open 永远等不到应答，
    // 只挂 catch 防 unhandled rejection，终态断言走 engine_closed 帧
    void agent.open(launchSpec(), 'open-spawn-err').catch(() => {})
    const closed = await agent.waitForFrame(
      (f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineClosed,
      'engine_closed(spawn error)',
    )
    // SPAWN_FAILURE_EXIT_CODE（127，command not found 惯例）
    expect(closed.code).toBe(127)
    expect(closed.reason).toBe(SUBAGENT_CONTROL_CLOSED_REASONS.engineExit)
  })

  it('hello 后畸形帧：丢弃并保持连接可用', { timeout: 20_000 }, async () => {
    const { agent } = await connectAgent()
    await agent.waitFor((f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.helloOk, 'hello_ok')
    agent.sendRaw('not-json {{{') // 解析失败 → 丢弃、连接保持

    // 连接仍可用：合法 open 照常走通
    const { channelId } = expectOpened(await agent.open(launchSpec({ args: ['--hang'] }), 'open-after-bad'))
    expect(channelId).toBeTruthy()
  })

  it('destroy 时 socket 文件被目录占位：unlink 失败降级，关停不阻断', { timeout: 20_000 }, async () => {
    const { server } = await setupServer()
    const socketPath = server.listeningSocketPath
    rmSync(socketPath)
    mkdirSync(socketPath) // 目录占位 → unlinkSync 必失败

    await expect(server.destroy()).resolves.toBeUndefined()
    expect(existsSync(socketPath)).toBe(true)
    // maxRetries+retryDelay（教训 d9ad39cb8）：teardown 递归删除与在途异步写竞争防瞬态失败
    rmSync(socketPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('引擎目录只读：pid 文件写失败降级，open 照常成功', { timeout: 20_000 }, async () => {
    const { agent, dataDir } = await connectAgent()
    const enginesDir = getControlEnginesDir(dataDir)
    mkdirSync(enginesDir, { recursive: true })
    chmodSync(enginesDir, 0o555)
    try {
      const { channelId } = expectOpened(await agent.open(launchSpec({ args: ['--hang'] }), 'open-pidfail'))
      expect(channelId).toBeTruthy() // pid 文件写失败不阻塞（退出走清理）
    } finally {
      chmodSync(enginesDir, 0o755)
    }
  })

  it('引擎目录只读 + 引擎退出：pid 文件清理失败降级，closed 照常送达', { timeout: 20_000 }, async () => {
    const { agent, dataDir } = await connectAgent()
    const { channelId, pid } = expectOpened(
      await agent.open(launchSpec({ args: ['--exit-on', 'bye', '--exit-code', '7'] }), 'open-cleanup'),
    )
    const enginesDir = getControlEnginesDir(dataDir)
    chmodSync(enginesDir, 0o555)
    const closed = await byeAndExpectClosed(agent, channelId, 7)
    expect(closed.reason).toBe(SUBAGENT_CONTROL_CLOSED_REASONS.engineExit)
    chmodSync(enginesDir, 0o755) // 恢复写权限：降级残留的 pid 文件随 tmp 清理
    await waitFor(() => !isPidAlive(pid), 'engine reaped')
  })
})
