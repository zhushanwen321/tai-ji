/**
 * subagent-control 测试共享件：socket 客户端（讲 control 协议的伪 extension 侧）+
 * 公共等待/装配工具。 fixture 引擎 CLI = __tests__/fixtures/fake-engine-cli.mjs。
 */
import * as net from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { SUBAGENT_CONTROL_PROTOCOL_VERSION, SUBAGENT_CONTROL_FRAME_KINDS } from '@zhushanwen/subagent-engine-sdk'
import { SubagentControlServer, type ControlServerOptions } from '../../../infra/subagent-control/control-server.js'

export const FAKE_ENGINE_CLI = resolve(process.cwd(), 'src/__tests__/fixtures/fake-engine-cli.mjs')

/** 轮询等待条件成立（跨进程时序；30s 预算对齐 relay 集成测试的 CI 调度噪声口径）。 */
export async function waitFor(cond: () => boolean, what = 'condition', timeoutMs = 30_000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

export async function makeTmpDir(prefix = 'ctl-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

export async function rmTmpDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
}

/** 测试 server 装配（dataDir 隔离 + 执行器走当前 node；时间窗/上限按用例覆盖）。 */
export function makeServer(dataDir: string, overrides: ControlServerOptions = {}): SubagentControlServer {
  return new SubagentControlServer({
    dataDir,
    projectRoot: process.cwd(),
    piCommand: process.execPath,
    piAgentDir: join(dataDir, 'agent'),
    engineNodeEnv: {},
    runtimeEnv: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
    },
    ...overrides,
  })
}

/** 合法 engine_open 的 launch 载荷（fixture CLI；用例按需覆盖字段）。 */
export function launchSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    engineId: 'fake-engine',
    entryPath: FAKE_ENGINE_CLI,
    args: [],
    cwd: tmpdir(),
    envPrefixes: [],
    rootSessionId: 'sess-root-1',
    ...overrides,
  }
}

/**
 * control socket 客户端：hello + 收集 runtime → 客户端方向的所有帧行。
 * sendOpen 封装 engine_open（launch 权威形态）并等待 engine_opened。
 */
export class TestAgent {
  readonly frames: Array<Record<string, unknown>> = []
  private conn!: net.Socket
  private buffer = ''
  readonly opened: Promise<void>
  readonly closed: Promise<void>

  constructor(socketPath: string) {
    this.opened = new Promise((resolveOpen, rejectOpen) => {
      this.conn = net.connect({ path: socketPath })
      this.conn.once('connect', resolveOpen)
      this.conn.once('error', rejectOpen)
    })
    this.closed = new Promise((resolveClose) => {
      this.conn.once('close', resolveClose)
    })
    this.conn.on('data', (d: Buffer) => {
      this.buffer += d.toString('utf8')
      let nl = this.buffer.indexOf('\n')
      while (nl !== -1) {
        const line = this.buffer.slice(0, nl)
        this.buffer = this.buffer.slice(nl + 1)
        if (line.trim()) this.frames.push(JSON.parse(line) as Record<string, unknown>)
        nl = this.buffer.indexOf('\n')
      }
    })
  }

  send(frame: Record<string, unknown>): void {
    this.conn.write(`${JSON.stringify(frame)}\n`)
  }

  /** 发送任意原始行（畸形帧/超长帧用例）。 */
  sendRaw(line: string): void {
    this.conn.write(`${line}\n`)
  }

  hello(id: string | number = 'h1', overrides: Record<string, unknown> = {}): void {
    this.send({ v: SUBAGENT_CONTROL_PROTOCOL_VERSION, kind: SUBAGENT_CONTROL_FRAME_KINDS.hello, id, hostPid: process.pid, hostKind: 'test', ...overrides })
  }

  /**
   * engine_open（launch 权威形态：engineId/rootSessionId/... 在 launch 内）+ 等待
   * engine_opened / engine_open_failed。
   */
  async open(
    launch: Record<string, unknown>,
    id: string | number = 1,
  ): Promise<{ channelId?: string; pid?: number; failed?: Record<string, unknown> }> {
    this.send({ v: SUBAGENT_CONTROL_PROTOCOL_VERSION, kind: SUBAGENT_CONTROL_FRAME_KINDS.engineOpen, id, launch })
    // 按 requestId 过滤应答（同连接多次 open 时旧 engine_opened 不得冒充本次应答）
    const isReplyForThisOpen = (f: Record<string, unknown>): boolean =>
      (f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineOpened || f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineOpenFailed)
      && String(f.id) === String(id)
    await this.waitFor(isReplyForThisOpen, `engine_open reply id=${String(id)}`)
    const reply = [...this.frames].reverse().find(isReplyForThisOpen) as Record<string, unknown>
    if (reply.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineOpened) {
      return { channelId: String(reply.channelId), pid: Number(reply.pid) }
    }
    return { failed: reply }
  }

  /** engine_open 且只等 engine_open_failed（同 id 已有成功 open 的重复用例——open() 会被旧 engine_opened 帧抢先满足）。 */
  async openExpectFailed(launch: Record<string, unknown>, id: string | number): Promise<Record<string, unknown>> {
    this.send({ v: SUBAGENT_CONTROL_PROTOCOL_VERSION, kind: SUBAGENT_CONTROL_FRAME_KINDS.engineOpen, id, launch })
    const isFailReply = (f: Record<string, unknown>): boolean =>
      f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineOpenFailed && String(f.id) === String(id)
    await this.waitFor(isFailReply, `engine_open_failed id=${String(id)}`)
    return [...this.frames].reverse().find(isFailReply) as Record<string, unknown>
  }

  sendFrame(channelId: string, line: string): void {
    this.send({ v: SUBAGENT_CONTROL_PROTOCOL_VERSION, kind: SUBAGENT_CONTROL_FRAME_KINDS.engineFrame, channelId, line })
  }

  engineFrameLines(): string[] {
    return this.frames
      .filter((f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineFrame)
      .map((f) => String(f.line))
  }

  closedFrames(): Array<Record<string, unknown>> {
    return this.frames.filter((f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.engineClosed)
  }

  errorFrames(): Array<Record<string, unknown>> {
    return this.frames.filter((f) => f.kind === SUBAGENT_CONTROL_FRAME_KINDS.error)
  }

  async waitForFrame(pred: (f: Record<string, unknown>) => boolean, what: string): Promise<Record<string, unknown>> {
    await this.waitFor(() => this.frames.some(pred), what)
    return this.frames.find(pred) as Record<string, unknown>
  }

  waitFor(pred: (f: Record<string, unknown>) => boolean, what: string): Promise<void> {
    return waitFor(() => this.frames.some(pred), what)
  }

  destroy(): void {
    this.conn.destroy()
  }
}

/** 从 fixture 的 childPid 事件行取假 pi 子进程 pid（组杀收割对象）。 */
export function parseChildPid(lines: string[]): number | null {
  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed !== null && typeof parsed === 'object' && (parsed as Record<string, unknown>).childPid !== undefined) {
        return Number((parsed as Record<string, unknown>).childPid)
      }
    } catch {
      // 非 JSON 行跳过
    }
  }
  return null
}

/** engine_open 结果断言：opened 则收窄非空类型；failed 则用失败载荷抛错（失败面用例自行断言 failed）。 */
export function expectOpened(
  result: { channelId?: string; pid?: number; failed?: Record<string, unknown> },
): { channelId: string; pid: number } {
  if (result.channelId === undefined || result.pid === undefined) {
    throw new Error(`engine_open failed: ${JSON.stringify(result.failed)}`)
  }
  return { channelId: result.channelId, pid: result.pid }
}
