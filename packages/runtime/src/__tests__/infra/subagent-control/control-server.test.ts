/**
 * subagent-control server 集成单测（L2，验收 ①）：真 unix socket 环回 + fixture 引擎
 * CLI（真进程组：fixture → 假 pi 子进程）。覆盖 hello/engine_open/frame 双向/
 * engine_closed/engine_close/断连组杀/超时/背压/帧超限/pid 文件形状。
 *
 * 形态：dataDir 注入 mkdtemp、上限与时间窗注入小值、
 * POSIX 组杀断言 skipIf(win32)。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  SUBAGENT_CONTROL_FRAME_KINDS,
  SUBAGENT_CONTROL_CLOSED_REASONS,
} from '@zhushanwen/subagent-engine-sdk'
import { isPidAlive } from '../../../utils/protocol-background-task.js'
import {
  getControlEnginesDir,
  getControlRunDir,
  getEnginePidFilePath,
} from '../../../infra/subagent-control/paths.js'
import { SubagentControlServer, type ControlServerOptions } from '../../../infra/subagent-control/control-server.js'
import {
  TestAgent,
  expectOpened,
  fakeBackpressuredStdin,
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

async function setupServer(overrides: ControlServerOptions = {}): Promise<{ server: SubagentControlServer; dataDir: string }> {
  const dataDir = await makeTmpDir()
  tmpDirs.push(dataDir)
  const server = makeServer(dataDir, overrides)
  servers.push(server)
  await server.init()
  return { server, dataDir }
}

afterEach(async () => {
  vi.restoreAllMocks()
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

  it('背压溢出：下行队列超上限 → error engine_backpressure_overflow + engine_closed killed_by_control + 组杀', { timeout: 60_000 }, async () => {
    // 注入 fake stdin（write 恒 false）制造确定性背压——不再依赖「大帧写满内核缓冲」
    // 的平台行为（Linux 写穿曾致本用例黑盒不可触达而 skip，现移除 skip）。
    const { server } = await setupServer({
      channelQueueMaxBytes: 64 * 1024,
      downStdinForTest: () => fakeBackpressuredStdin(),
    })
    const agent = new TestAgent(server.listeningSocketPath)
    await agent.opened
    agent.hello()
    const { channelId, pid } = expectOpened(await agent.open(launchSpec({ args: ['--no-read-stdin'] }), 1))
    // 70KB 首帧：write 返回 false 但已被 Node 受理 → 只登记 drain 等待、不入队（R3-N1）；
    // 第二帧在背压期真正入队，70KB > 64KB 队列上限 → 显式失败（不丢帧、不静默）。
    agent.sendFrame(channelId, `x${'y'.repeat(70 * 1024)}`)
    agent.sendFrame(channelId, `x${'y'.repeat(70 * 1024)}`)
    const error = await agent.waitForFrame(
      (f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.error && f.code === 'engine_backpressure_overflow',
      'overflow error frame',
    )
    // m-rt-7：recovery 必须是可执行文案（SDK 词表），不能是错误码复读
    expect(String(error.recovery)).toContain('reduce concurrent subagent fan-out')
    expect(String(error.recovery)).not.toBe('engine_backpressure_overflow')
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
    const oversizeError = await agent.waitForFrame(
      (f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.error && f.code === 'engine_frame_too_large',
      'frame_too_large error',
    )
    // m-rt-7：下行超限走 handleOversize，recovery 已是可执行指引（非错误码）
    expect(String(oversizeError.recovery)).toContain('Split the payload')
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
    const upOversizeError = agent.frames.find(
      (f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.error && f.code === 'engine_frame_too_large',
    ) as Record<string, unknown>
    // m-rt-7：recovery 是 SDK 恢复文案（不是错误码复读）
    expect(String(upOversizeError.recovery)).toContain('Shrink the task/result payload')
    await agent.waitForFrame((f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineClosed, 'engine_closed')
    await waitFor(() => !isPidAlive(pid), 'engine killed after up oversize')
    void channelId
  })

  it('down 方向连接级聚合上限：多通道累加越界 → 仅触发通道失败（error + engine_closed），其它通道保持 open', { timeout: 90_000 }, async () => {
    // per-channel 上界放宽到 8MB；连接级 down 聚合上界压到 100KB——两个 70KB
    // 待写帧累加即越界（fake stdin write 恒 false、drain 永不触发，通道确定性地
    // 停在背压态，首帧之后到达的帧才真正入队列）。
    const { server } = await setupServer({
      channelQueueMaxBytes: 8 * 1024 * 1024,
      connectionQueueMaxBytes: 100 * 1024,
      closeGraceMs: 500,
      downStdinForTest: () => fakeBackpressuredStdin(),
    })
    const agent = new TestAgent(server.listeningSocketPath)
    await agent.opened
    agent.hello()
    const a = expectOpened(await agent.open(launchSpec({ engineId: 'fake-engine-a', args: ['--no-read-stdin'] }), 'agg-a'))
    const b = expectOpened(await agent.open(launchSpec({ engineId: 'fake-engine-b', args: ['--no-read-stdin'] }), 'agg-b'))

    const frame = 'x'.repeat(70 * 1024)
    // 每通道首帧 write=false 但已被 Node 受理（不入队）；第二帧才真正入队 —— 聚合
    // 上限判据只看入队帧（R3-N1 + R2-B-U-3 口径）：A 70KB 入队后 B 的 70KB 使
    // 聚合 140KB > 100KB → 仅 B 被判溢出。
    agent.sendFrame(a.channelId, frame) // A 首帧：drain 等待，不入队
    agent.sendFrame(b.channelId, frame) // B 首帧：同上
    agent.sendFrame(a.channelId, frame) // A 第二帧：入队（70KB < 100KB 聚合）
    agent.sendFrame(b.channelId, frame) // B 第二帧：A+B 聚合 140KB > 100KB → 仅 B 被判溢出

    const error = await agent.waitForFrame(
      (f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.error && f.code === 'engine_backpressure_overflow',
      'down aggregate overflow error',
    )
    expect(error.channelId).toBe(b.channelId)
    expect(String(error.message)).toContain('connection aggregate')
    const closed = await agent.waitForFrame(
      (f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineClosed && f.channelId === b.channelId,
      'engine_closed for aggregate-overflow channel',
    )
    expect(closed.reason).toBe(SUBAGENT_CONTROL_CLOSED_REASONS.killedByControl)
    await waitFor(() => !isPidAlive(b.pid), 'aggregate-overflow channel engine reaped')

    // 其它通道不受影响：台账仍 open、进程存活、无 error/engine_closed 帧，且仍可受理下行帧
    expect(server.getChannelForTest(a.channelId)?.state).toBe('open')
    expect(isPidAlive(a.pid)).toBe(true)
    expect(agent.errorFrames().some((f) => f.channelId === a.channelId)).toBe(false)
    expect(agent.closedFrames().some((f) => f.channelId === a.channelId)).toBe(false)
    agent.sendFrame(a.channelId, 'still-accepted')
    await new Promise((r) => setTimeout(r, 150))
    expect(agent.errorFrames().some((f) => f.channelId === a.channelId)).toBe(false)
    agent.destroy()
  })

  it('down 聚合上限只在入队时判定：慢通道积压到上限，健康通道小帧仍写入且不被杀', { timeout: 30_000 }, async () => {
    // 回归 R2-B-U-3 + R3-N1：上限判定只在真正入队时执行；`stdin.write` 返回 false
    // 的帧已被 Node 受理、不入队（drain 时不重写）。慢通道把连接级聚合推到恰好上限
    //（等于上限不算越界），健康通道的小帧写入返回 true → 不得触发聚合溢出。
    // 慢通道首帧取 1MB（远大于任何平台管道缓冲）确保 write 必然返回 false、进入
    // drain 等待而不入队；随后两帧（1MB + 4KB）真正入队把聚合顶到恰好上限。
    const limit = 1024 * 1024 + 4096
    const { server } = await setupServer({
      channelQueueMaxBytes: 8 * 1024 * 1024,
      connectionQueueMaxBytes: limit,
      closeGraceMs: 500,
    })
    const agent = new TestAgent(server.listeningSocketPath)
    await agent.opened
    agent.hello()
    const slow = expectOpened(
      await agent.open(launchSpec({ engineId: 'fake-engine-slow', args: ['--no-read-stdin'] }), 'slow'),
    )
    const healthy = expectOpened(
      await agent.open(launchSpec({ engineId: 'fake-engine-healthy', args: [] }), 'healthy'),
    )

    // 慢通道：1MB 首帧 write=false（已被 Node 受理、不入队）；再用 1MB 帧入队、
    // 4KB 帧把聚合顶到恰好上限（入队判据为 > limit；等于上限不算越界）
    agent.sendFrame(slow.channelId, 'x'.repeat(1024 * 1024 - 1))
    agent.sendFrame(slow.channelId, 'x'.repeat(1024 * 1024 - 1))
    agent.sendFrame(slow.channelId, 'x'.repeat(4096 - 1))
    // 同一连接上的下一帧：健康通道（读 stdin）小帧——写返回 true，不入队
    agent.sendFrame(healthy.channelId, JSON.stringify({ id: 'healthy-ping' }))

    // 健康通道仍能正常往返（真正写入 + 引擎回包），而非仅被静默丢帧
    await agent.waitFor(
      (f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineFrame
        && String(f.line).includes('healthy-ping'),
      'healthy channel still writes through',
    )
    expect(server.getChannelForTest(healthy.channelId)?.state).toBe('open')
    expect(server.getChannelForTest(slow.channelId)?.state).toBe('open')
    expect(agent.errorFrames().some((f) => f.channelId === healthy.channelId)).toBe(false)
    expect(agent.errorFrames().some((f) => f.channelId === slow.channelId)).toBe(false)
    agent.destroy()
  })

  it('背压 down 方向每帧恰好投递一次：慢读者恢复后不重写已受理帧（R3-N1）', { timeout: 30_000 }, async () => {
    // 回归 R3-N1：write 返回 false 只表示内核缓冲已满（数据已被受理），旧实现把它
    // 同时入队，drain 时重写 → 背压下的 run/cancel/dispose 帧双投。这里让引擎前
    // 600ms 不读 stdin（管道写满 → 进入背压），随后恢复读取并逐帧回 response；
    // 断言 120 个 id 全部且仅出现一次、顺序保持（FIFO）、无 error 帧。
    const { server } = await setupServer({ closeGraceMs: 1_000 })
    const agent = new TestAgent(server.listeningSocketPath)
    await agent.opened
    agent.hello()
    const { channelId } = expectOpened(
      await agent.open(launchSpec({ engineId: 'fake-engine-paused', args: ['--stdin-pause-ms', '600'] }), 1),
    )

    const total = 120
    const ids = Array.from({ length: total }, (_, i) => `bp-${String(i)}`)
    for (const id of ids) {
      agent.sendFrame(channelId, JSON.stringify({ id, payload: 'p'.repeat(4096) }))
    }

    const responseIds = (): string[] => agent.engineFrameLines().flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>
        return parsed.type === 'response' && typeof parsed.id === 'string' && parsed.id.startsWith('bp-')
          ? [parsed.id]
          : []
      } catch {
        return []
      }
    })

    await waitFor(() => new Set(responseIds()).size === total, 'all backpressured frames echoed')
    // 观察窗：重复投递的 response 紧随同一次 drain 到达；给重写帧留出到达余量。
    await new Promise((r) => setTimeout(r, 300))
    const received = responseIds()
    expect(received).toHaveLength(total)
    expect(new Set(received).size).toBe(total)
    expect(received).toEqual(ids)
    expect(agent.errorFrames()).toEqual([])
    agent.destroy()
  })

  it('engine_close 窗内正常退出 → 不打「exited unexpectedly」warn（intentional 路径日志口径）', { timeout: 20_000 }, async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { server } = await setupServer({ closeGraceMs: 2_000 })
    const agent = new TestAgent(server.listeningSocketPath)
    await agent.opened
    agent.hello()
    const { channelId, pid } = expectOpened(
      await agent.open(launchSpec({ args: ['--exit-on', 'dispose-now', '--exit-delay-ms', '150'] }), 1),
    )
    // dispose 帧送达（引擎 150ms 后退出）→ engine_close 先受理（intentionalClose）
    agent.sendFrame(channelId, 'dispose-now')
    agent.send({ v: 1, kind: SUBAGENT_CONTROL_FRAME_KINDS.engineClose, channelId })

    const closed = await agent.waitForFrame(
      (f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineClosed && f.channelId === channelId,
      'engine_closed after intentional close',
    )
    expect(closed.reason).toBe(SUBAGENT_CONTROL_CLOSED_REASONS.engineExit)
    await waitFor(() => !isPidAlive(pid), 'engine exited in close grace window')

    const warned = warnSpy.mock.calls.map((args) => args.map(String).join(' ')).join('\n')
    expect(warned).not.toContain('exited unexpectedly')
    const logged = logSpy.mock.calls.map((args) => args.map(String).join(' ')).join('\n')
    expect(logged).toContain(`engine closed channelId=${channelId}`)
    expect(logged).toContain('reason=engine_exit')
    agent.destroy()
  })

  it('engine_close 受理 + 引擎带子进程自行退出 → 组杀兜底仍收割残留子进程，且日志不误报', { timeout: 20_000 }, async () => {
    // 回归 R2-B-U-2：intentionalClose 曾同时抑制 exit 后的 killEngineGroup，
    // engine_close 窗内引擎自行退出时残留子进程失去孤儿兜底。现在两判据解耦：
    // 日志按 intentional 口径（不报意外），组杀按「exit 且未 killRequested」照常执行。
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { server } = await setupServer({ closeGraceMs: 2_000 })
    const agent = new TestAgent(server.listeningSocketPath)
    await agent.opened
    agent.hello()
    const { channelId, pid } = expectOpened(
      await agent.open(launchSpec({ args: ['--spawn-child', '--exit-on', 'dispose-now', '--exit-delay-ms', '200'] }), 1),
    )
    await agent.waitFor((f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineFrame, 'childPid event')
    const childPid = parseChildPid(agent.engineFrameLines())
    if (childPid === null) throw new Error('fixture did not report childPid')
    expect(isPidAlive(childPid)).toBe(true)

    // dispose 帧送达（引擎 200ms 后自行退出）→ engine_close 先受理（intentionalClose）
    agent.sendFrame(channelId, 'dispose-now')
    agent.send({ v: 1, kind: SUBAGENT_CONTROL_FRAME_KINDS.engineClose, channelId })

    const closed = await agent.waitForFrame(
      (f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineClosed && f.channelId === channelId,
      'engine_closed after intentional close',
    )
    expect(closed.reason).toBe(SUBAGENT_CONTROL_CLOSED_REASONS.engineExit)
    await waitFor(() => !isPidAlive(pid), 'engine exited in close grace window')
    // 关键断言：组杀兜底不被日志分类豁免
    await waitFor(() => !isPidAlive(childPid), 'orphan child reaped by group kill on intentional exit')

    const warned = warnSpy.mock.calls.map((args) => args.map(String).join(' ')).join('\n')
    expect(warned).not.toContain('exited unexpectedly')
    const logged = logSpy.mock.calls.map((args) => args.map(String).join(' ')).join('\n')
    expect(logged).toContain(`engine closed channelId=${channelId}`)
    expect(logged).toContain('reason=engine_exit')
    agent.destroy()
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

  // ── D5 修复组 G2（m-rt-1 / m-rt-2 / planner②/③/④ / A8）──────────────

  it('m-rt-1：C→R 多字节 UTF-8 跨 chunk 边界不被撕裂（汉字拆两块 → 引擎收到原字）', { timeout: 20_000 }, async () => {
    const { server } = await setupServer()
    const agent = new TestAgent(server.listeningSocketPath)
    await agent.opened
    agent.hello()
    const { channelId } = expectOpened(await agent.open(launchSpec({ args: ['--echo-line'] }), 1))

    const frame = {
      v: 1,
      kind: SUBAGENT_CONTROL_FRAME_KINDS.engineFrame,
      channelId,
      line: '前中后',
    }
    const buf = Buffer.from(`${JSON.stringify(frame)}\n`, 'utf8')
    const markerIndex = buf.indexOf(Buffer.from('中', 'utf8'))
    expect(markerIndex).toBeGreaterThan(0)
    // 在「中」的 3 字节序列内部切开：逐 chunk toString 会得到 U+FFFD
    await agent.sendBuffers([buf.subarray(0, markerIndex + 1), buf.subarray(markerIndex + 1)])

    const echoed = await agent.waitForFrame(
      (f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineFrame && String(f.line).includes('"echo"'),
      'engine echo line',
    )
    const outer = JSON.parse(String(echoed.line)) as { type: string; line: string }
    expect(outer.type).toBe('echo')
    // control server 把 engine_frame.line 的**内层载荷**写入引擎 stdin（信封不透明）
    expect(outer.line).toBe('前中后')
    agent.destroy()
  })

  it('m-rt-1：R→C stdout 多字节 UTF-8 跨 chunk 边界不被撕裂（fixture 拆分「中」）', { timeout: 20_000 }, async () => {
    const { server } = await setupServer()
    const agent = new TestAgent(server.listeningSocketPath)
    await agent.opened
    agent.hello()
    await agent.open(launchSpec({ args: ['--emit-split-utf8', '--hang'] }), 1)
    await agent.waitFor(
      (f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineFrame && f.line === '中',
      'split UTF-8 stdout reassembled',
    )
    agent.destroy()
  })

  it('A8：200KB 正向 prompt 经 control 通道完整送达引擎 stdin（字节数一致）', { timeout: 30_000 }, async () => {
    const { server } = await setupServer()
    const agent = new TestAgent(server.listeningSocketPath)
    await agent.opened
    agent.hello()
    const { channelId } = expectOpened(await agent.open(launchSpec({ args: ['--ack-stdin-bytes'] }), 1))
    // 200KB（含多字节 CJK）：既验证大帧完整送达，又覆盖大帧下的 UTF-8 解码
    const prompt = '中'.repeat(50_000) + 'a'.repeat(200 * 1024 - 150_000)
    expect(Buffer.byteLength(prompt, 'utf8')).toBe(200 * 1024)
    agent.sendFrame(channelId, prompt)
    const ack = await agent.waitForFrame(
      (f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineFrame && String(f.line).includes('"ack"'),
      'engine stdin byte ack',
    )
    expect((JSON.parse(String(ack.line)) as { bytes: number }).bytes).toBe(Buffer.byteLength(prompt, 'utf8'))
    agent.destroy()
  })

  it('m-rt-2：背压期控制帧不越过已排队数据帧（engine_closed 在全部 engine_frame 之后）', { timeout: 30_000 }, async () => {
    const { server } = await setupServer({
      channelQueueMaxBytes: 16 * 1024 * 1024,
      connectionQueueMaxBytes: 64 * 1024 * 1024,
      closeGraceMs: 2_000,
    })
    const agent = new TestAgent(server.listeningSocketPath)
    await agent.opened
    agent.hello()
    const { channelId, pid } = expectOpened(await agent.open(
      launchSpec({ args: ['--emit-lines-on', 'emit-now', '8', String(1024 * 1024), '--exit-on', 'die-now'] }),
      1,
    ))

    // 客户端停止读取 → 服务端 socket 背压；引擎此时发 8MB 帧，全部进入 up 队列
    agent.pause()
    agent.sendFrame(channelId, 'emit-now')
    await new Promise((r) => setTimeout(r, 300))
    agent.sendFrame(channelId, 'die-now') // 引擎退出 → engine_closed 必须在已排队帧之后
    await new Promise((r) => setTimeout(r, 300))
    agent.resume()

    await agent.waitForFrame(
      (f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineClosed && f.channelId === channelId,
      'engine_closed after backpressure drained',
    )
    const closedIndex = agent.frames.findIndex(
      (f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineClosed && f.channelId === channelId,
    )
    const lastDataIndex = agent.lastIndexOfKind(SUBAGENT_CONTROL_FRAME_KINDS.engineFrame, channelId)
    expect(lastDataIndex).toBeGreaterThanOrEqual(0)
    expect(lastDataIndex).toBeLessThan(closedIndex)
    const dataFrames = agent.frames.filter(
      (f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineFrame && f.channelId === channelId,
    )
    expect(dataFrames).toHaveLength(8)
    await waitFor(() => !isPidAlive(pid), 'engine exited after die-now')
    agent.destroy()
  })

  it('m-rt-2：连接级溢出先 flush error 再 end（暂停读取后恢复仍收到 error 帧）', { timeout: 30_000 }, async () => {
    const { server } = await setupServer({
      channelQueueMaxBytes: 64 * 1024 * 1024,
      connectionQueueMaxBytes: 512 * 1024,
    })
    const agent = new TestAgent(server.listeningSocketPath)
    await agent.opened
    agent.hello()
    const { channelId } = expectOpened(await agent.open(
      // 3 × 300KB：首帧直接写（write=false → awaitingDrain），第二帧入队，第三帧使
      // 连接级聚合 600KB > 512KB → overflow 裁决时队列非空（error 排在数据帧之后）。
      launchSpec({ args: ['--emit-lines-on', 'emit-now', '3', String(300 * 1024)] }),
      1,
    ))
    agent.pause()
    agent.sendFrame(channelId, 'emit-now')
    await new Promise((r) => setTimeout(r, 300)) // 第二帧使连接级聚合越界 → overflow 裁决
    // m-rt-2 关键断言：overflow 后不得立即 destroy——error 帧需先 flush（有界等待），
    // 客户端暂停读取期间连接必须仍登记（回退成「写完即 destroy」时这里已为 0）。
    expect(server.getConnectionCountForTest()).toBe(1)
    agent.resume()

    const error = await agent.waitForFrame(
      (f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.error && f.code === 'engine_backpressure_overflow',
      'connection overflow error delivered after flush',
    )
    expect(String(error.message)).toContain('connection queue overflow')
    // m-rt-7：connection-level 成因标注必须在 recovery 文案里（不是错误码复读）
    expect(String(error.recovery)).toContain('Connection-level overflow')
    expect(String(error.recovery)).toContain('reduce concurrent subagent fan-out')
    // error 是关闭前最后可依赖的失败信号：连接随后被 end（FIN）而非无痕 destroy
    await agent.closed
  })

  it('planner②：opening 占位计入每连接 channel 上限（并发 open 不能绕过）', { timeout: 20_000 }, async () => {
    const { server } = await setupServer({
      maxChannelsPerConnection: 2,
      openTimeoutMs: 60_000,
      resolveLaunch: () => new Promise(() => {}), // 两个 open 都停在 opening 占位
    })
    const agent = new TestAgent(server.listeningSocketPath)
    await agent.opened
    agent.hello()
    agent.send({ v: 1, kind: SUBAGENT_CONTROL_FRAME_KINDS.engineOpen, id: 'p1', launch: launchSpec() })
    agent.send({ v: 1, kind: SUBAGENT_CONTROL_FRAME_KINDS.engineOpen, id: 'p2', launch: launchSpec() })
    await waitFor(() => server.channelCount === 2, 'two pending openings counted')

    const third = await agent.openExpectFailed(launchSpec(), 'p3')
    expect(third.code).toBe('channel_limit')
    expect(server.channelCount).toBe(2)
    agent.destroy()
  })

  it.skipIf(isWin32)('planner③：存量 run/ 与 subagent-engines/ 0755 → init 收敛为 0700', { timeout: 20_000 }, async () => {
    const dataDir = await makeTmpDir('ctl-perm-')
    tmpDirs.push(dataDir)
    const runDir = getControlRunDir(dataDir)
    const enginesDir = getControlEnginesDir(dataDir)
    mkdirSync(runDir, { recursive: true })
    mkdirSync(enginesDir, { recursive: true })
    chmodSync(runDir, 0o755) // 旧 relay 时代形态（mkdirSync mode 对已存在目录不生效）
    chmodSync(enginesDir, 0o755)
    expect(statSync(runDir).mode & 0o777).toBe(0o755)

    const server = makeServer(dataDir)
    servers.push(server)
    await server.init()
    expect(statSync(runDir).mode & 0o777).toBe(0o700)
    expect(statSync(enginesDir).mode & 0o777).toBe(0o700)
  })

  it('planner④：pid 文件 tmp+rename 原子写（可解析、无 tmp 残留、0600）', { timeout: 20_000 }, async () => {
    const { server, dataDir } = await setupServer()
    const agent = new TestAgent(server.listeningSocketPath)
    await agent.opened
    agent.hello()
    const { channelId } = expectOpened(await agent.open(launchSpec({ args: ['--hang'] }), 1))

    const enginesDir = getControlEnginesDir(dataDir)
    const entries = readdirSync(enginesDir)
    expect(entries.some((name) => name.includes('.tmp-'))).toBe(false)
    const pidFiles = entries.filter((name) => name.endsWith('.pid'))
    expect(pidFiles).toHaveLength(1)
    const pidFile = join(enginesDir, pidFiles[0])
    const record = JSON.parse(await readFile(pidFile, 'utf-8')) as Record<string, unknown>
    expect(record.pid).toBeGreaterThan(0)
    expect(record.engineId).toBe('fake-engine')
    expect(record.rootSessionId).toBe('sess-root-1')
    if (!isWin32) expect(statSync(pidFile).mode & 0o777).toBe(0o600)
    void channelId
    agent.destroy()
  })

  it('m-rt-8：open 超时后迟到 resolveLaunch 失败 → 只回一帧 engine_open_failed', { timeout: 20_000 }, async () => {
    let rejectLaunch!: (reason?: unknown) => void
    const { server } = await setupServer({
      openTimeoutMs: 100,
      resolveLaunch: () => new Promise((_resolve, reject) => { rejectLaunch = reject }),
    })
    const agent = new TestAgent(server.listeningSocketPath)
    await agent.opened
    agent.hello()
    const result = await agent.open(launchSpec(), 'late-open')
    expect(result.failed?.code).toBe('engine_open_timeout')

    rejectLaunch(new Error('late resolve failure'))
    await new Promise((r) => setTimeout(r, 200))
    const failures = agent.frames.filter(
      (f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineOpenFailed && String(f.id) === 'late-open',
    )
    expect(failures).toHaveLength(1)
    agent.destroy()
  })

  it('planner①：Windows 树杀兜底 — 引擎已死后按 childSpawned 登记的 pid 逐个树杀', { timeout: 30_000 }, async () => {
    const killed: number[] = []
    const { server } = await setupServer({
      killPlatform: 'win32',
      // 注入树杀观察桩（不真杀）：验证 Windows 分支对 pidSet 的消费
      killGroup: (pid: number | null | undefined) => { if (typeof pid === 'number') killed.push(pid) },
    })
    const agent = new TestAgent(server.listeningSocketPath)
    await agent.opened
    agent.hello()
    const { channelId } = expectOpened(await agent.open(
      launchSpec({ args: ['--spawn-child', '--emit-host-child-frames', '--exit-on', 'die-parent'] }),
      1,
    ))
    // 等 host/childSpawned 反向信封被 runtime 读出并转发（pidSet 已登记）
    await agent.waitFor(
      (f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineFrame && String(f.line).includes('host/childSpawned'),
      'host/childSpawned envelope forwarded',
    )
    const childPid = parseChildPid(agent.engineFrameLines())
    if (childPid === null) throw new Error('fixture did not report childPid')
    expect(isPidAlive(childPid)).toBe(true)

    try {
      agent.sendFrame(channelId, 'die-parent') // 引擎退出，taskkill 树根已死
      await agent.waitForFrame(
        (f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineClosed && f.channelId === channelId,
        'engine_closed after parent exit',
      )
      await waitFor(() => killed.includes(childPid), 'child pid individually tree-killed on win32')
    } finally {
      try {
        process.kill(childPid, 'SIGKILL')
      } catch {
        // 已死（正常分支）
      }
    }
    agent.destroy()
  })
})
