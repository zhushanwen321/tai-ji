/**
 * subagent-control server 集成单测（L2，验收 ①）：真 unix socket 环回 + fixture 引擎
 * CLI（真进程组：fixture → 假 pi 子进程）。覆盖 hello/engine_open/frame 双向/
 * engine_closed/engine_close/断连组杀/超时/背压/帧超限/pid 文件形状。
 *
 * 形态：dataDir 注入 mkdtemp、上限与时间窗注入小值、
 * POSIX 组杀断言 skipIf(win32)。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  SUBAGENT_CONTROL_FRAME_KINDS,
  SUBAGENT_CONTROL_CLOSED_REASONS,
} from '@zhushanwen/subagent-engine-sdk'
import { isPidAlive } from '../../../utils/protocol-background-task.js'
import { getEnginePidFilePath } from '../../../infra/subagent-control/paths.js'
import { SubagentControlServer } from '../../../infra/subagent-control/control-server.js'
import {
  TestAgent,
  expectOpened,
  launchSpec,
  makeServer,
  makeTmpDir,
  parseChildPid,
  rmTmpDir,
  waitFor,
} from './test-helpers.js'

const isWin32 = process.platform === 'win32'

const tmpDirs: string[] = []
const servers: SubagentControlServer[] = []

async function setupServer(overrides = {}): Promise<{ server: SubagentControlServer; dataDir: string }> {
  const dataDir = await makeTmpDir()
  tmpDirs.push(dataDir)
  const server = makeServer(dataDir, overrides)
  servers.push(server)
  await server.init()
  return { server, dataDir }
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.destroy()
  }
  await Promise.all(tmpDirs.splice(0).map((d) => rmTmpDir(d)))
})

describe('subagent-control server（真 socket 环回 + fixture 引擎）', () => {
  it('hello：合法 → hello_ok（runtimePid/protocolVersion）；版本不匹配 → hello_reject version + 断连', { timeout: 20_000 }, async () => {
    const { server } = await setupServer()

    const ok = new TestAgent(server.listeningSocketPath)
    await ok.opened
    ok.hello('h-ok')
    await ok.waitFor((f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.helloOk, 'hello_ok')
    const helloOk = ok.frames[0]
    expect(helloOk.id).toBe('h-ok')
    expect(helloOk.runtimePid).toBe(process.pid)
    expect(helloOk.protocolVersion).toBe(1)
    ok.destroy()

    const bad = new TestAgent(server.listeningSocketPath)
    await bad.opened
    bad.hello('h-bad', { v: 99 })
    await bad.waitFor((f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.helloReject, 'hello_reject')
    const reject = bad.frames[0]
    expect(reject.reason).toBe('version')
    expect(reject.supported).toEqual([1])
    await bad.closed // 拒绝后断连
  })

  it('首帧非 hello → hello_reject expected_hello + 断连；hello 前沉默超过窗 → 连接被断', { timeout: 20_000 }, async () => {
    const { server } = await setupServer({ helloTimeoutMs: 300 })

    const nonHello = new TestAgent(server.listeningSocketPath)
    await nonHello.opened
    nonHello.send({ v: 1, kind: SUBAGENT_CONTROL_FRAME_KINDS.engineOpen, id: 1, launch: launchSpec() })
    await nonHello.waitFor((f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.helloReject, 'hello_reject expected_hello')
    expect(nonHello.frames[0].reason).toBe('expected_hello')
    await nonHello.closed

    const silent = new TestAgent(server.listeningSocketPath)
    await silent.opened
    await silent.closed // hello 窗 300ms 内无 hello → 服务端断连
  })

  it('engine_open → spawn fixture → engine_opened{pid}；pid 文件形状（runtimePid/instanceId/hostKind）', { timeout: 20_000 }, async () => {
    const { server, dataDir } = await setupServer()
    const agent = new TestAgent(server.listeningSocketPath)
    await agent.opened
    agent.hello()
    const { channelId, pid } = expectOpened(await agent.open(launchSpec(), 'open-1'))
    expect(channelId).toBeTruthy()
    expect(pid).toBeGreaterThan(0)
    expect(isPidAlive(pid)).toBe(true)

    const pidFile = getEnginePidFilePath('sess-root-1', 'fake-engine', channelId, dataDir)
    expect(existsSync(pidFile)).toBe(true)
    const record = JSON.parse(await readFile(pidFile, 'utf-8')) as Record<string, unknown>
    expect(record.pid).toBe(pid)
    expect(record.runtimePid).toBe(process.pid)
    expect(record.instanceId).toBe(String(process.pid))
    expect(record.hostKind).toBe('runtime-sidecar')
    expect(record.engineId).toBe('fake-engine')
    expect(record.rootSessionId).toBe('sess-root-1')

    // 引擎帧双向：下行 request → fixture 回 response（缺省形态：逐帧回 response）
    agent.sendFrame(channelId, JSON.stringify({ id: 'req-1', method: 'ping' }))
    await agent.waitFor((f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineFrame, 'engine_frame up')
    expect(agent.engineFrameLines()).toContain(JSON.stringify({ type: 'response', id: 'req-1', ok: true }))
  })

  it('unsolicited 上行：引擎启动即 emit 的行照常封装 engine_frame 下发', { timeout: 20_000 }, async () => {
    const { server } = await setupServer()
    const agent = new TestAgent(server.listeningSocketPath)
    await agent.opened
    agent.hello()
    const emitted = JSON.stringify({ type: 'event', name: 'started' })
    await agent.open(launchSpec({ args: ['--emit', emitted, '--hang'] }), 1)
    await agent.waitFor(
      (f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineFrame && f.line === emitted,
      'unsolicited engine_frame',
    )
  })

  it('engine 正常退出（--exit-on）→ engine_closed{code, reason engine_exit} + pid 文件删除', { timeout: 20_000 }, async () => {
    const { server, dataDir } = await setupServer()
    const agent = new TestAgent(server.listeningSocketPath)
    await agent.opened
    agent.hello()
    const { channelId, pid } = expectOpened(await agent.open(launchSpec({ args: ['--exit-on', 'bye', '--exit-code', '7'] }), 1))
    agent.sendFrame(channelId, 'bye')
    const closed = await agent.waitForFrame(
      (f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineClosed && f.channelId === channelId,
      'engine_closed',
    )
    expect(closed.code).toBe(7)
    expect(closed.signal).toBeNull()
    expect(closed.reason).toBe(SUBAGENT_CONTROL_CLOSED_REASONS.engineExit)
    await waitFor(() => !isPidAlive(pid), 'engine process reaped')
    const pidFile = getEnginePidFilePath('sess-root-1', 'fake-engine', channelId, dataDir)
    await waitFor(() => !existsSync(pidFile), 'pid file removed after exit confirmed')
  })

  it('stderr 采集：engine_closed.stderrTail 携带有界尾部', { timeout: 20_000 }, async () => {
    const { server } = await setupServer()
    const agent = new TestAgent(server.listeningSocketPath)
    await agent.opened
    agent.hello()
    const { channelId } = expectOpened(await agent.open(launchSpec({ args: ['--stderr', 'boom-tail-marker', '--exit-on', 'bye'] }), 1))
    agent.sendFrame(channelId, 'bye')
    const closed = await agent.waitForFrame((f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineClosed, 'engine_closed')
    expect(String(closed.stderrTail)).toContain('boom-tail-marker')
  })

  it.skipIf(isWin32)('engine 意外退出留假 pi 子进程 → runtime 组杀收割（POSIX 负 pid 覆盖已死组长）', { timeout: 30_000 }, async () => {
    const { server } = await setupServer()
    const agent = new TestAgent(server.listeningSocketPath)
    await agent.opened
    agent.hello()
    const { channelId, pid } = expectOpened(await agent.open(launchSpec({ args: ['--spawn-child', '--exit-on', 'die-parent'] }), 1))
    // 等子进程 pid 上报（fixture stdout 首事件行）
    await agent.waitFor((f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineFrame, 'childPid event')
    const childPid = parseChildPid(agent.engineFrameLines())
    if (childPid === null) throw new Error('fixture did not report childPid')
    expect(childPid).toBeGreaterThan(0)
    expect(isPidAlive(childPid)).toBe(true)

    agent.sendFrame(channelId, 'die-parent') // fixture 父进程 exit 0，子进程残活
    const closed = await agent.waitForFrame((f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineClosed, 'engine_closed')
    expect(closed.reason).toBe(SUBAGENT_CONTROL_CLOSED_REASONS.engineExit)
    // 组杀兜底：残活子进程被收割（无孤儿）
    await waitFor(() => !isPidAlive(childPid), 'orphan fake-pi reaped by group kill')
    await waitFor(() => !isPidAlive(pid), 'engine leader gone')
  })

  it('engine_close 有界等待：引擎在窗内退出 → engine_closed 真实 code（reason engine_exit）；只关本通道', { timeout: 20_000 }, async () => {
    const { server } = await setupServer({ closeGraceMs: 500 })
    const agent = new TestAgent(server.listeningSocketPath)
    await agent.opened
    agent.hello()
    const first = expectOpened(await agent.open(launchSpec({ args: ['--exit-on', 'dispose-now'] }), 1))
    const second = expectOpened(await agent.open(launchSpec({ engineId: 'fake-engine-2' }), 2))
    // dispose 帧（扩展先发 dispose 再发 engine_close 的语义）；fixture 见 dispose-now 即退
    agent.sendFrame(first.channelId, 'dispose-now')
    agent.send({ v: 1, kind: SUBAGENT_CONTROL_FRAME_KINDS.engineClose, channelId: first.channelId })
    const closed = await agent.waitForFrame(
      (f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineClosed && f.channelId === first.channelId,
      'engine_closed for first channel',
    )
    expect(closed.reason).toBe(SUBAGENT_CONTROL_CLOSED_REASONS.engineExit)
    // engine_close 只影响该 channel：第二通道不受波及（响应形态 fixture，可回帧验证存活）
    await waitFor(() => !isPidAlive(first.pid), 'first engine gone')
    expect(isPidAlive(second.pid)).toBe(true)
    agent.sendFrame(second.channelId, JSON.stringify({ id: 'still-alive' }))
    await agent.waitFor((f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineFrame, 'second channel still frames')
  })

  it('engine_close 超时（--hang 不退）→ 有界等待后组杀（reason killed_by_control）', { timeout: 20_000 }, async () => {
    const { server } = await setupServer({ closeGraceMs: 300 })
    const agent = new TestAgent(server.listeningSocketPath)
    await agent.opened
    agent.hello()
    const { channelId, pid } = expectOpened(await agent.open(launchSpec({ args: ['--hang'] }), 1))
    agent.send({ v: 1, kind: SUBAGENT_CONTROL_FRAME_KINDS.engineClose, channelId })
    const closed = await agent.waitForFrame((f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineClosed, 'engine_closed')
    expect(closed.reason).toBe(SUBAGENT_CONTROL_CLOSED_REASONS.killedByControl)
    await waitFor(() => !isPidAlive(pid), 'engine killed after grace')
  })

  it.skipIf(isWin32)('断连组杀（kill-on-disconnect）：socket 断开 → 该连接引擎 + 假 pi 子进程全灭', { timeout: 30_000 }, async () => {
    const { server } = await setupServer()
    const agent = new TestAgent(server.listeningSocketPath)
    await agent.opened
    agent.hello()
    const { pid } = expectOpened(await agent.open(launchSpec({ args: ['--spawn-child', '--hang'] }), 1))
    await agent.waitFor((f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineFrame, 'childPid event')
    const childPid = parseChildPid(agent.engineFrameLines())
    if (childPid === null) throw new Error('fixture did not report childPid')
    expect(childPid).toBeGreaterThan(0)

    agent.destroy()
    await waitFor(() => !isPidAlive(pid) && !isPidAlive(childPid), 'engine group reaped on disconnect')
  })

  it('engine_open 失败面：相对路径 invalid_launch / 根会话不一致 session / 重复 id duplicate', { timeout: 20_000 }, async () => {
    const { server } = await setupServer()
    const agent = new TestAgent(server.listeningSocketPath)
    await agent.opened
    agent.hello()

    const rel = await agent.open(launchSpec({ entryPath: 'relative/engine.mjs' }), 'r1')
    expect(rel.failed?.code).toBe('invalid_launch')

    const mismatch = await agent.open(launchSpec({ rootSessionId: 'sess-other' }), 'r2')
    expect(mismatch.failed?.code).toBe('session')

    const dup = expectOpened(await agent.open(launchSpec({ args: ['--hang'] }), 'dup'))
    expect(dup.channelId).toBeTruthy()
    const dup2 = await agent.openExpectFailed(launchSpec({ args: ['--hang'] }), 'dup')
    expect(dup2.code).toBe('duplicate')
  })

  it('open 超时：launch 解析挂起 → engine_open_failed engine_open_timeout（占位被超时覆盖）', { timeout: 20_000 }, async () => {
    const { server } = await setupServer({
      openTimeoutMs: 200,
      resolveLaunch: () => new Promise(() => {}), // 永不 resolve：模拟执行器解析挂起
    })
    const agent = new TestAgent(server.listeningSocketPath)
    await agent.opened
    agent.hello()
    const result = await agent.open(launchSpec(), 'slow')
    expect(result.failed?.code).toBe('engine_open_timeout')
  })

  it('背压溢出：下行队列超上限 → error engine_backpressure_overflow + engine_closed killed_by_control + 组杀', { timeout: 20_000 }, async () => {
    const { server } = await setupServer({ channelQueueMaxBytes: 64 * 1024 })
    const agent = new TestAgent(server.listeningSocketPath)
    await agent.opened
    agent.hello()
    const { channelId, pid } = expectOpened(await agent.open(launchSpec({ args: ['--hang'] }), 1))
    // 单帧 70KB > 64KB 队列上限：首帧即触发前置检查（不写内核、不丢帧、显式失败）
    agent.sendFrame(channelId, `x${'y'.repeat(70 * 1024)}`)
    await agent.waitForFrame(
      (f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.error && f.code === 'engine_backpressure_overflow',
      'overflow error frame',
    )
    const closed = await agent.waitForFrame((f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineClosed, 'engine_closed')
    expect(closed.reason).toBe(SUBAGENT_CONTROL_CLOSED_REASONS.killedByControl)
    await waitFor(() => !isPidAlive(pid), 'engine killed after overflow')
  })

  it('下行帧超限：maxFrameBytes 小值 → error frame_too_large + 关通道（连接保持）', { timeout: 20_000 }, async () => {
    const { server } = await setupServer({ maxFrameBytes: 1024 })
    const agent = new TestAgent(server.listeningSocketPath)
    await agent.opened
    agent.hello()
    const { channelId, pid } = expectOpened(await agent.open(launchSpec({ args: ['--hang'] }), 1))
    agent.sendFrame(channelId, 'z'.repeat(2048))
    await agent.waitForFrame(
      (f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.error && f.code === 'engine_frame_too_large',
      'frame_too_large error',
    )
    const closed = await agent.waitForFrame((f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineClosed, 'engine_closed')
    expect(closed.reason).toBe(SUBAGENT_CONTROL_CLOSED_REASONS.killedByControl)
    await waitFor(() => !isPidAlive(pid), 'engine killed after oversize frame')
    // 通道已关：后续该通道帧回 unknown_channel error（连接未被销毁——hello 后畸形/未知通道不升连）
    agent.sendFrame(channelId, 'after-close')
    await agent.waitForFrame((f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.error && f.code === 'unknown_channel', 'unknown_channel error')
    // 连接仍活：500ms 观察窗内 closed promise 不 settle
    const outcome = await Promise.race([
      agent.closed.then(() => 'closed'),
      new Promise((r) => setTimeout(() => r('open'), 500)),
    ])
    expect(outcome).toBe('open')
  })

  it('上行帧超限：引擎 stdout 巨行 → error + 杀组关通道', { timeout: 20_000 }, async () => {
    const { server } = await setupServer({ maxFrameBytes: 1024 })
    const agent = new TestAgent(server.listeningSocketPath)
    await agent.opened
    agent.hello()
    const { channelId, pid } = expectOpened(await agent.open(launchSpec({ args: ['--emit-size', '2048', '--hang'] }), 1))
    await agent.waitForFrame(
      (f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.error && f.code === 'engine_frame_too_large',
      'up-direction frame_too_large',
    )
    await agent.waitForFrame((f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineClosed, 'engine_closed')
    await waitFor(() => !isPidAlive(pid), 'engine killed after up oversize')
    void channelId
  })

  it('destroy（deinit）：全通道组杀 + socket 文件删除', { timeout: 20_000 }, async () => {
    const { server, dataDir } = await setupServer()
    const agent = new TestAgent(server.listeningSocketPath)
    await agent.opened
    agent.hello()
    const { pid } = expectOpened(await agent.open(launchSpec({ args: ['--hang'] }), 1))
    await server.destroy()
    await waitFor(() => !isPidAlive(pid), 'engine killed by destroyAll')
    expect(existsSync(join(dataDir, 'run', `subagent-${process.pid}.sock`))).toBe(false)
  })
})
