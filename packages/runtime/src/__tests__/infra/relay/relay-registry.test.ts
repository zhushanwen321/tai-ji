/**
 * relay server + registry 集成单测（E-2，验收 1 的握手/转发/杀链/pid 文件部分）。
 *
 * 形态：真 unix socket 环回（initRelayServer 带注入 dataDir + 假 pi 命令）+ 测试内
 * 写临时可执行脚本模拟 pi 的 stdin/stdout 行为（spawn 经 process.execPath 跑 .mjs）。
 * message-bus topic 登记断言（验收 3）也在本文件。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as net from 'node:net'
import { mkdtemp, mkdir, writeFile, readFile, rm, writeFile as writeFileAsync } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initRelayServer, deinitRelayServer, isRelayServerActive, getActiveRelaySocketPath, getActiveRelayRegistry } from '../../../infra/relay/relay-server.js'
import { RelayRegistry } from '../../../infra/relay/relay-registry.js'
import { getRelaySocketPath, getRelayPidFilePath, getRelayChildrenDir } from '../../../infra/relay/relay-paths.js'
import { topicOf } from '../../../services/message-bus/message-bus.js'
import { RELAY_PROTOCOL_VERSION, RELAY_ENV_SOCKET, RELAY_ENV_SESSION_ID, RELAY_ENV_RECORD_ID, RELAY_ENV_NODE, RELAY_ENV_SCRIPT } from '@zhushanwen/subagent-core/relay-env'
import type { ServerMessage } from '@taiji/shared'

/** 轮询等待条件成立（进程间时序）。 */
// 默认 30s：CI 2 核 runner 上 vitest 并行 worker 抢占下，spawn 假 pi → SIGTERM →
// marker 写盘链路可显著慢于本地（8s 预算曾连续两轮 CI 超时红，同代码第三轮又绿，
// 纯调度噪声）；断言语义不变，只放宽时序预算
async function waitFor(cond: () => boolean, timeoutMs = 30_000, what = 'condition'): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** socket 客户端：握手 + 收集 runtime → 代理方向的所有帧行。 */
class TestAgent {
  readonly frames: Array<Record<string, unknown>> = []
  private conn!: net.Socket
  private buffer = ''
  readonly opened: Promise<void>

  constructor(private readonly socketPath: string) {
    this.opened = new Promise((resolve, reject) => {
      this.conn = net.connect({ path: socketPath })
      this.conn.once('connect', resolve)
      this.conn.once('error', reject)
    })
    this.conn.on('data', (d: Buffer) => {
      this.buffer += d.toString('utf-8')
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

  /** 对端主动 FIN（半关闭）：只关发送侧，接收侧保持——模拟代理进程退出后 socket 半关闭。 */
  halfClose(): void {
    this.conn.end()
  }

  dataUp(): Array<Buffer> {
    return this.frames
      .filter((f) => f.kind === 'data' && f.dir === 'up')
      .map((f) => Buffer.from(String(f.b64), 'base64'))
  }

  dataUpStderr(): Array<Buffer> {
    return this.frames
      .filter((f) => f.kind === 'data' && f.dir === 'up-stderr')
      .map((f) => Buffer.from(String(f.b64), 'base64'))
  }

  exitFrames(): Array<{ code: unknown; signal: unknown }> {
    return this.frames.filter((f) => f.kind === 'exit') as Array<{ code: unknown; signal: unknown }>
  }

  rejectFrames(): Array<{ reason: unknown }> {
    return this.frames.filter((f) => f.kind === 'reject') as Array<{ reason: unknown }>
  }

  destroy(): void {
    this.conn.destroy()
  }

  get closed(): boolean {
    return this.conn.destroyed
  }

  async waitForClosed(): Promise<void> {
    await waitFor(() => this.closed, 30_000, 'agent connection closed')
  }
}

function validHandshake(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: RELAY_PROTOCOL_VERSION,
    kind: 'handshake',
    mainSessionId: 'main-1',
    recordId: 'rec-1',
    argv: ['--mode', 'rpc'],
    env: {
      [RELAY_ENV_SESSION_ID]: 'main-1',
      [RELAY_ENV_RECORD_ID]: 'rec-1',
      [RELAY_ENV_SOCKET]: '/fake/socket/path.sock',
      [RELAY_ENV_NODE]: '/fake/node',
      [RELAY_ENV_SCRIPT]: '/fake/relay.mjs',
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      PI_SUBAGENT_ROOT_SESSION_ID: 'main-1',
    },
    cwd: tmpdir(),
    ...overrides,
  }
}

describe('relay server + registry（真 socket 环回 + 假 pi）', () => {
  // 本文件全部用例涉及真实子进程 + 杀链（SIGTERM → 3s grace → SIGKILL），满并行下
  // 5s 默认 testTimeout 不够（全量 347 文件满并行时杀链用例曾超时）——统一放宽。
  // 60s：waitFor 内部预算 30s（见 waitFor 注释），用例超时必须大于其最长等待。
  const PROCESS_TEST_TIMEOUT_MS = 60_000
  const t = (name: string, fn: () => void | Promise<void>): void => { it(name, fn, PROCESS_TEST_TIMEOUT_MS) }
  let dataDir: string
  let workDir: string
  let fakePi: string
  let published: Array<{ sid: string; msg: ServerMessage }>
  let publish: (sid: string, msg: ServerMessage) => void

  beforeEach(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    dataDir = await mkdtemp(join(tmpdir(), 'relay-registry-'))
    workDir = await mkdtemp(join(tmpdir(), 'relay-pi-'))
    fakePi = join(workDir, 'fake-pi.mjs')
    // 假 pi：dump argv/cwd/relay-env 剥离结果；events 模式输出事件流；echo 模式回显
    // stdin；exit7 模式即退；SIGTERM 写 marker（断连即杀断言）。
    await writeFile(fakePi, [
      "import { writeFileSync } from 'node:fs'",
      "const mode = process.argv[2] ?? 'hang'",
      "if (process.env.TAIJI_TEST_ENV_DUMP) {",
      "  const relayKeys = Object.keys(process.env).filter((k) => k.startsWith('TAIJI_SUBAGENT_RELAY_')).sort()",
      "  writeFileSync(process.env.TAIJI_TEST_ENV_DUMP, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), relayEnv: relayKeys.map((k) => [k, process.env[k]]) }))",
      '}',
      "if (mode === 'events') {",
      "  process.stderr.write('pi boot noise\\n')",
      "  process.stdout.write(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } }) + '\\n')",
      "  process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: Date.now() } }) + '\\n')",
      '}',
      "if (mode === 'exit7') process.exit(7)",
      "if (mode === 'echo') {",
      "  process.stdin.setEncoding('utf-8')",
      "  let buf = ''",
      "  process.stdin.on('data', (d) => { buf += d; const nl = buf.indexOf('\\n'); if (nl !== -1) { process.stdout.write('ECHO:' + buf.slice(0, nl) + '\\n'); buf = buf.slice(nl + 1) } })",
      '}',
      "// stream 模式：持续向 stdout 吐数据（半关闭容错测试——子进程在连接死亡后仍输出）",
      "if (mode === 'stream') {",
      "  let i = 0",
      "  const timer = setInterval(() => { process.stdout.write(`chunk-${i++}\\n`) }, 10)",
      "  process.on('SIGTERM', () => { clearInterval(timer); process.exit(0) })",
      '}',
      "// hang/events 模式挂住事件循环：立即退出会与 stdout pipe flush 竞态丢数据",
      "if (mode === 'hang' || mode === 'events') setTimeout(() => {}, 60000)",
      "process.on('SIGTERM', () => {",
      "  if (process.env.TAIJI_TEST_SIGTERM_MARKER) writeFileSync(process.env.TAIJI_TEST_SIGTERM_MARKER, 'sigterm')",
      '  process.exit(0)',
      '})',
      "// handler 注册完才写 ready：CI 2 核饱和下 node 冷启动可达数秒，杀链若在",
      "// 注册前发 SIGTERM 走默认终止，marker 永不出现（间歇红 CI 的根因）",
      "if (process.env.TAIJI_TEST_READY_MARKER) writeFileSync(process.env.TAIJI_TEST_READY_MARKER, 'ready')",
      '',
    ].join('\n'))
    published = []
    publish = (sid: string, msg: ServerMessage) => {
      published.push({ sid, msg })
    }
  })

  afterEach(async () => {
    await deinitRelayServer().catch(() => {})
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }).catch(() => {})
    await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }).catch(() => {})
    vi.restoreAllMocks()
  })

  async function startServer(): Promise<void> {
    await initRelayServer({ projectRoot: workDir, dataDir, publish, piCommand: process.execPath })
  }

  t('init：listen + socket 文件创建 + active 状态', async () => {
    await startServer()
    expect(isRelayServerActive()).toBe(true)
    const socketPath = getActiveRelaySocketPath()
    expect(socketPath).toBe(getRelaySocketPath(dataDir))
    if (process.platform !== 'win32') {
      expect(existsSync(socketPath!)).toBe(true)
    }
  })

  t('deinit：socket 文件删除 + active false', async () => {
    await startServer()
    const socketPath = getActiveRelaySocketPath()!
    await deinitRelayServer()
    expect(isRelayServerActive()).toBe(false)
    if (process.platform !== 'win32') {
      expect(existsSync(socketPath)).toBe(false)
    }
  })

  t('残留 socket 探活：连不上（死文件）→ 删除重建，init 成功', async () => {
    // 先造一个无监听者的 socket 文件（模拟上次崩溃残留）
    await startServer()
    const socketPath = getActiveRelaySocketPath()!
    await deinitRelayServer()
    // deinit 已删文件；手动重造一个同名文件模拟「删除失败的崩溃残留」
    const { writeFileSync } = await import('node:fs')
    writeFileSync(socketPath, '')
    expect(existsSync(socketPath)).toBe(true)
    await startServer()
    expect(isRelayServerActive()).toBe(true)
  })

  t('残留 socket 探活：连得上（活实例）→ init 报实例冲突', async () => {
    await startServer()
    const socketPath = getActiveRelaySocketPath()!
    // 占住同名路径的第二个 server（pid 相同路径——直接 net.createServer listen 同路径
    // 会 EADDRINUSE，改用「保持第一个实例活着，模拟第二个 init」）：deinit 不调，
    // 直接再 init 会命中 already initialized；改为构造残留场景——先 deinit 拿到路径、
    // 起占位 server 监听该路径、再 init 同 dataDir。
    await deinitRelayServer()
    const squatter = net.createServer(() => {})
    await new Promise<void>((resolve) => squatter.listen(socketPath, resolve))
    await expect(initRelayServer({ projectRoot: workDir, dataDir, publish, piCommand: process.execPath }))
      .rejects.toThrow(/held by a live runtime instance/)
    await new Promise<void>((resolve) => squatter.close(() => resolve()))
  })

  t('握手校验：v 超前 → reject reason=version + 断连', async () => {
    await startServer()
    const agent = new TestAgent(getActiveRelaySocketPath()!)
    await agent.opened
    agent.send(validHandshake({ v: RELAY_PROTOCOL_VERSION + 1 }))
    await agent.waitForClosed()
    expect(agent.rejectFrames().map((r) => r.reason)).toContain('version')
  })

  t('握手校验：归属缺失（空 mainSessionId）→ reject reason=identity + 断连', async () => {
    await startServer()
    const agent = new TestAgent(getActiveRelaySocketPath()!)
    await agent.opened
    agent.send(validHandshake({ mainSessionId: '' }))
    await agent.waitForClosed()
    expect(agent.rejectFrames().map((r) => r.reason)).toContain('identity')
  })

  t('握手校验：env 缺 TAIJI_SUBAGENT_RELAY_*（归属 env 与帧不一致）→ reject identity', async () => {
    await startServer()
    const agent = new TestAgent(getActiveRelaySocketPath()!)
    await agent.opened
    agent.send(validHandshake({
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
      },
    }))
    await agent.waitForClosed()
    expect(agent.rejectFrames().map((r) => r.reason)).toContain('identity')
  })

  t('握手校验：非 handshake 第一帧 → reject malformed', async () => {
    await startServer()
    const agent = new TestAgent(getActiveRelaySocketPath()!)
    await agent.opened
    agent.send({ v: 1, kind: 'data', dir: 'down', b64: '' })
    await agent.waitForClosed()
    expect(agent.rejectFrames().map((r) => r.reason)).toContain('malformed')
  })

  t('合法握手 → spawn 假 pi：argv/cwd 透传 + TAIJI_SUBAGENT_RELAY_* 剥离 + pid 文件写入', async () => {
    await startServer()
    const envDump = join(workDir, 'env-dump.json')
    const childCwd = join(workDir, 'wt')
    await mkdir(childCwd)
    const agent = new TestAgent(getActiveRelaySocketPath()!)
    await agent.opened
    const hs = validHandshake({ argv: [fakePi, 'hang'], cwd: childCwd })
    ;(hs.env as Record<string, string>).TAIJI_TEST_ENV_DUMP = envDump
    agent.send(hs)
    await waitFor(() => existsSync(envDump), 30_000, 'env dump written')
    const dump = JSON.parse(await readFile(envDump, 'utf-8')) as { argv: string[]; cwd: string; relayEnv: Array<[string, string]> }
    // runtime spawn 的 argv = [fakePi, 'hang']（握手 argv 原样），pi 视角 userArgs = slice(2)
    expect(dump.argv).toEqual(['hang'])
    // macOS tmpdir 是 /var symlink，子进程 cwd() 返回 realpath —— 按 realpath 比对
    const { realpath } = await import('node:fs/promises')
    expect(dump.cwd).toBe(await realpath(childCwd))
    // 剥离全部 5 个 relay env（防孙进程嵌套误导）
    expect(dump.relayEnv).toEqual([])
    // pid 文件存在且内容含 pid + 时间戳
    const pidFile = getRelayPidFilePath('rec-1', dataDir)
    expect(existsSync(pidFile)).toBe(true)
    const pidInfo = JSON.parse(await readFile(pidFile, 'utf-8')) as { pid: number; spawnedAt: number }
    expect(typeof pidInfo.pid).toBe('number')
    expect(typeof pidInfo.spawnedAt).toBe('number')
    agent.destroy()
  })

  t('down 帧 → child stdin；child stdout → up 帧（字节级保真）', async () => {
    await startServer()
    const agent = new TestAgent(getActiveRelaySocketPath()!)
    await agent.opened
    agent.send(validHandshake({ argv: [fakePi, 'echo'] }))
    agent.send({ v: 1, kind: 'data', dir: 'down', b64: Buffer.from('PING\n').toString('base64') })
    await waitFor(() => agent.dataUp().some((b) => b.includes(Buffer.from('ECHO:PING'))), 30_000, 'echo round-trip')
    agent.destroy()
  })

  t('畸形 data 帧（缺 b64 / b64 非 string / null）→ 静默丢弃不炸服务，首帧 warn 显形，后续合法帧仍转发', async () => {
    // review round1 MUST_FIX：修复前 Buffer.from(undefined, 'base64') 在 readline 回调内
    // 抛未捕获 TypeError 可击穿 relay 服务；修复后按 malformed 丢弃（不断连），连接存活。
    // 加固轮补显形：首个畸形帧 warn（连接级去重），后续畸形帧只计数不再 warn。
    await startServer()
    const agent = new TestAgent(getActiveRelaySocketPath()!)
    await agent.opened
    // warn spy 挂在 startServer 之后（同断连即杀用例：spy 替换的是 logger patch 后的版本）
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      agent.send(validHandshake({ argv: [fakePi, 'echo'] }))
      agent.send({ v: 1, kind: 'data', dir: 'down' })
      agent.send({ v: 1, kind: 'data', dir: 'down', b64: 123 })
      agent.send({ v: 1, kind: 'data', dir: 'down', b64: null })
      agent.send({ v: 1, kind: 'data', dir: 'down', b64: Buffer.from('PING\n').toString('base64') })
      await waitFor(() => agent.dataUp().some((b) => b.includes(Buffer.from('ECHO:PING'))), 30_000, 'echo round-trip after malformed frames')
      // 畸形帧全部丢弃（未进 child stdin）：echo 只回合法帧那一次
      expect(Buffer.concat(agent.dataUp()).toString('utf-8').match(/ECHO:/g)?.length).toBe(1)
      // 连接未被断开（服务存活；畸形帧只丢帧不 reject）
      expect(agent.closed).toBe(false)
      // 数据阶段畸形帧显形：3 个畸形帧只首帧 1 条 warn（连接级去重防刷屏），含 recordId
      const malformedWarns = warnSpy.mock.calls.filter(([msg]) => String(msg).includes('malformed data frame dropped'))
      expect(malformedWarns).toHaveLength(1)
      expect(String(malformedWarns[0]![0])).toContain('recordId=rec-1')
    } finally {
      warnSpy.mockRestore()
    }
    agent.destroy()
  })

  t('child stderr → up-stderr 帧（不进 tee）', async () => {
    await startServer()
    const agent = new TestAgent(getActiveRelaySocketPath()!)
    await agent.opened
    agent.send(validHandshake({ argv: [fakePi, 'events'] }))
    await waitFor(() => agent.dataUpStderr().length > 0, 30_000, 'stderr forwarded')
    expect(agent.dataUpStderr()[0].toString('utf-8')).toContain('pi boot noise')
    agent.destroy()
  })

  t('tee 分支：stdout 事件 → session.subagentEntriesAppended + stream_delta（归属虚拟分区）', async () => {
    await startServer()
    const agent = new TestAgent(getActiveRelaySocketPath()!)
    await agent.opened
    agent.send(validHandshake({ argv: [fakePi, 'events'] }))
    await waitFor(() => published.some((p) => p.msg.type === 'session.subagentEntriesAppended'), 30_000, 'entries frame')
    const entriesFrame = published.find((p) => p.msg.type === 'session.subagentEntriesAppended')!
    expect(entriesFrame.sid).toBe('main-1')
    expect((entriesFrame.msg.payload as { subagentId: string }).subagentId).toBe('rec-1')
    const deltas = published.filter((p) => p.msg.type === 'subagent.stream_delta')
    expect(deltas.length).toBeGreaterThan(0)
    expect((deltas[0].msg.payload as { sessionId: string }).sessionId).toBe('subagent:main-1:rec-1')
    // 编排通路同字节保真：up 帧拼接与假 pi 原始输出一致（两次 write 可能合并为单 chunk，
    // 断言按内容不按帧数）
    await waitFor(() => {
      const joined = Buffer.concat(agent.dataUp()).toString('utf-8')
      return joined.includes('text_delta') && joined.includes('message_end')
    }, 30_000, 'up frames with both events')
    agent.destroy()
  })

  t('stdout 字节镜像落盘：pi-relay-<date>-<recordId>.jsonl 出现且含原始输出字节', async () => {
    // 镜像写入器走 logger 模块（未 init 时 no-op）——本用例先 initLogger(dataDir)，
    // finally closeLogger 复位（后续用例恢复无 logger 状态）
    const { initLogger, closeLogger } = await import('../../../infra/logger.js')
    initLogger(dataDir)
    try {
      await startServer()
      const agent = new TestAgent(getActiveRelaySocketPath()!)
      await agent.opened
      agent.send(validHandshake({ argv: [fakePi, 'events'] }))
      const logsDir = join(dataDir, 'logs')
      const mirrorName = () => readdirSync(logsDir).find((f) => /^pi-relay-\d{4}-\d{2}-\d{2}-rec-1\.jsonl$/.test(f))
      // 文件在首次镜像写入时惰性创建（date 前缀 + recordId 命名对齐 pi-<date>-<sessionId> 模式）
      await waitFor(() => existsSync(logsDir) && mirrorName() !== undefined, 30_000, 'mirror log file created')
      // 内容含假 pi 原始输出字节（轮询等 WriteStream 缓冲 flush，不依赖时序）
      await waitFor(() => {
        const content = readFileSync(join(logsDir, mirrorName()!), 'utf-8')
        return content.includes('text_delta') && content.includes('message_end')
      }, 30_000, 'mirror content flushed')
      const content = readFileSync(join(logsDir, mirrorName()!), 'utf-8')
      // 逐字节保真：假 pi 两行 JSONL 各带换行，镜像原样保留（不补/不吞换行）
      expect(content.match(/text_delta/g)?.length).toBe(1)
      expect(content.match(/message_end/g)?.length).toBe(1)
      expect(content.endsWith('\n')).toBe(true)
      agent.destroy()
    } finally {
      await closeLogger()
    }
  })

  t('exit 帧传播：child exit 7 → 代理收 exit {code:7} + pid 文件删除', async () => {
    await startServer()
    const agent = new TestAgent(getActiveRelaySocketPath()!)
    await agent.opened
    agent.send(validHandshake({ argv: [fakePi, 'exit7'] }))
    await waitFor(() => agent.exitFrames().length > 0, 30_000, 'exit frame')
    expect(agent.exitFrames()[0].code).toBe(7)
    expect(agent.exitFrames()[0].signal).toBeNull()
    await waitFor(() => !existsSync(getRelayPidFilePath('rec-1', dataDir)), 30_000, 'pid file removed')
    await agent.waitForClosed()
  })

  t('断连即杀：客户端断开 → 伪 child 收到 SIGTERM（marker 文件）+ 结构化决策日志', async () => {
    await startServer()
    const marker = join(workDir, 'sigterm-marker')
    const agent = new TestAgent(getActiveRelaySocketPath()!)
    await agent.opened
    const hs = validHandshake({ argv: [fakePi, 'hang'] })
    const ready = join(workDir, 'ready-marker')
    ;(hs.env as Record<string, string>).TAIJI_TEST_SIGTERM_MARKER = marker
    ;(hs.env as Record<string, string>).TAIJI_TEST_READY_MARKER = ready
    agent.send(hs)
    await waitFor(() => existsSync(getRelayPidFilePath('rec-1', dataDir)), 30_000, 'pid file written')
    // 等 handler 注册完再触发杀链：否则 SIGTERM 打进 node 启动期走默认终止，marker 永不出现
    await waitFor(() => existsSync(ready), 30_000, 'fake-pi ready (SIGTERM handler registered)')
    // 杀链决策日志（crash-resilience §3.3 D6-⑥）：spy 必须在 initLogger patch console
    // 之后挂（spy 替换的是 patched 版本，调用路径经过 spy）；close handler 同步落行
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      agent.destroy()
      await waitFor(() => existsSync(marker), 30_000, 'SIGTERM marker (kill-on-disconnect)')
      await waitFor(() => !existsSync(getRelayPidFilePath('rec-1', dataDir)), 30_000, 'pid file cleaned after kill')
      // 决策行：动作 / 主 session（哪个主 session 死）/ recordId + 子进程 pid（连带杀谁）/ 原因
      const decisionCall = warnSpy.mock.calls.find(([msg]) => msg === '[relay] kill decision')
      expect(decisionCall).toBeDefined()
      const meta = decisionCall![1] as Record<string, unknown>
      expect(meta.action).toBe('kill_on_disconnect')
      expect(meta.mainSessionId).toBe('main-1')
      expect(meta.recordId).toBe('rec-1')
      expect(typeof meta.childPid).toBe('number')
      expect(String(meta.reason)).toContain('socket closed')
    } finally {
      warnSpy.mockRestore()
    }
  })

  // goodbye 预告（2026-09-24 事故取证修复）：宿主正常收割（agent_settled 后杀代理）
  // 先发 goodbye 再断开——runtime 侧把 close 判定为正常 teardown：child 照常收割
  // （marker 仍出现），但不产生 warn 级 kill-on-disconnect 与 kill decision 决策行
  // （正常路径不污染故障统计）。无预告断连的 warn 语义由上例锁定。
  t('goodbye 预告：断开前发 goodbye → child 仍被收割，但无 warn 级 kill-on-disconnect 日志', async () => {
    await startServer()
    const marker = join(workDir, 'sigterm-marker-goodbye')
    const agent = new TestAgent(getActiveRelaySocketPath()!)
    await agent.opened
    const hs = validHandshake({ argv: [fakePi, 'hang'] })
    const ready = join(workDir, 'ready-marker-goodbye')
    ;(hs.env as Record<string, string>).TAIJI_TEST_SIGTERM_MARKER = marker
    ;(hs.env as Record<string, string>).TAIJI_TEST_READY_MARKER = ready
    agent.send(hs)
    await waitFor(() => existsSync(getRelayPidFilePath('rec-1', dataDir)), 30_000, 'pid file written')
    await waitFor(() => existsSync(ready), 30_000, 'fake-pi ready (SIGTERM handler registered)')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      agent.send({ v: 1, kind: 'goodbye' })
      agent.destroy()
      await waitFor(() => existsSync(marker), 30_000, 'SIGTERM marker (reaped after goodbye)')
      await waitFor(() => !existsSync(getRelayPidFilePath('rec-1', dataDir)), 30_000, 'pid file cleaned after reap')
      // 无 warn 级断连告警与 kill decision 决策行（正常收割不产生故障噪声）
      expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('kill-on-disconnect'))).toBe(false)
      expect(warnSpy.mock.calls.some(([msg]) => msg === '[relay] kill decision')).toBe(false)
      // 正常 teardown 的 info 级留痕（goodbye received + reaped）
      expect(logSpy.mock.calls.some(([msg]) => String(msg).includes('goodbye received recordId=rec-1'))).toBe(true)
      expect(logSpy.mock.calls.some(([msg]) => String(msg).includes('reaping child (normal teardown) recordId=rec-1'))).toBe(true)
    } finally {
      warnSpy.mockRestore()
      logSpy.mockRestore()
    }
  })

  // 2026-09-04 runtime 整机崩溃事故回归：对端 FIN 后本端 conn 自动 end()
  // （allowHalfOpen=false 默认）——destroyed=false 但 writableEnded=true，子进程
  // stdout 后续 data 回调里 writeFrame 同步抛 writeAfterFIN（EPIPE），逃逸即
  // uncaughtException → 整机 graceful shutdown。修复：writeFrame guard + 吞异常。
  t('半关闭容错：对端 FIN 后子进程持续输出，writeFrame 不逃逸、进程存活（事故回归）', async () => {
    await startServer()
    const socketPath = getActiveRelaySocketPath()!
    const agent = new TestAgent(socketPath)
    await agent.opened
    const ready = join(workDir, 'ready-marker-halfclose')
    const hs = validHandshake({ argv: [fakePi, 'stream'] })
    ;(hs.env as Record<string, string>).TAIJI_TEST_READY_MARKER = ready
    agent.send(hs)
    await waitFor(() => agent.frames.some((f) => f.kind === 'accept'), 30_000, 'accept frame')
    await waitFor(() => existsSync(ready), 30_000, 'fake-pi streaming')
    // 收到若干流帧证明字节泵在转发，再半关闭
    await waitFor(() => agent.dataUp().length > 0, 30_000, 'stream frames flowing')
    agent.halfClose()
    // 修复前：writeFrame 在此处同步抛 EPIPE → uncaughtException → 测试 worker 崩溃；
    // 修复后：帧被丢弃，进程存活。等足够多 chunk 走过半关闭窗口。
    await new Promise((r) => setTimeout(r, 500))
    // 存活断言：新连接仍可握手注册（进程未崩、注册表未坏）；recordId 覆盖需同步 env 归属键
    const probe = new TestAgent(socketPath)
    await probe.opened
    // env 归属键同步 recordId（isHandshakeEnvOwnershipValid 校验 env 与帧一致）；
    // spread 断言：validHandshake 自建 env 对象，形状自证
    const probeEnv = { ...(validHandshake().env as Record<string, string>), [RELAY_ENV_RECORD_ID]: 'rec-probe' }
    probe.send(validHandshake({ argv: [fakePi, 'hang'], recordId: 'rec-probe', env: probeEnv }))
    await waitFor(() => probe.frames.some((f) => f.kind === 'accept'), 30_000, 'probe accepted after half-close')
    probe.destroy()
    agent.destroy()
  })

  // 同族事故面：对端 RST（非正常 close）→ conn 'error' ECONNRESET，无 listener 时
  // EventEmitter emit 直接 throw → uncaughtException。真实 RST 无法在 unix socket
  // 环回模拟（resetAndDestroy 仅支持 TCP），改为单元级直验 handleConnection 的
  // error 挂载：emit('error') 无 listener 同步 throw 是逃逸机制本身，not.toThrow
  // 即守护「listener 已挂 + 吞掉」。
  t('RST 容错（单元级）：conn error 事件不逃逸（error listener 吞掉并 destroy）', async () => {
    const registry = new RelayRegistry({ projectRoot: workDir, dataDir, publish, piCommand: process.execPath })
    const sock = new net.Socket() // 未连接实例：仅验证事件挂载行为，不涉及 IO
    registry.handleConnection(sock)
    const rst = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    // 修复前：无 error listener → emit('error') 同步 throw（测试进程即崩）；
    // 修复后：listener 接住 → warn + destroy，不抛
    expect(() => sock.emit('error', rst)).not.toThrow()
    expect(sock.destroyed).toBe(true)
    sock.destroy()
  })

  t('deinitRelayServer：running 子进程全部杀链收割', async () => {
    await startServer()
    const marker = join(workDir, 'sigterm-marker-deinit')
    const agent = new TestAgent(getActiveRelaySocketPath()!)
    await agent.opened
    const hs = validHandshake({ argv: [fakePi, 'hang'] })
    const ready = join(workDir, 'ready-marker-deinit')
    ;(hs.env as Record<string, string>).TAIJI_TEST_SIGTERM_MARKER = marker
    ;(hs.env as Record<string, string>).TAIJI_TEST_READY_MARKER = ready
    agent.send(hs)
    await waitFor(() => existsSync(getRelayPidFilePath('rec-1', dataDir)), 30_000, 'pid file written')
    await waitFor(() => existsSync(ready), 30_000, 'fake-pi ready (SIGTERM handler registered)')
    await deinitRelayServer()
    await waitFor(() => existsSync(marker), 30_000, 'SIGTERM marker (deinit kill chain)')
  })

  t('重复 recordId → 第二个连接 reject duplicate', async () => {
    await startServer()
    const a1 = new TestAgent(getActiveRelaySocketPath()!)
    await a1.opened
    a1.send(validHandshake({ argv: [fakePi, 'hang'] }))
    await waitFor(() => existsSync(getRelayPidFilePath('rec-1', dataDir)), 30_000, 'first registered')
    const a2 = new TestAgent(getActiveRelaySocketPath()!)
    await a2.opened
    a2.send(validHandshake({ argv: [fakePi, 'hang'] }))
    await waitFor(() => a2.rejectFrames().length > 0, 30_000, 'duplicate reject')
    expect(a2.rejectFrames()[0].reason).toBe('duplicate')
    a1.destroy()
    a2.destroy()
  })

  // idle pi reclamation D2 #3：hasByMainSessionId 真值表（reaper「在途 relay 子进程」
  // 豁免判定的读面）。真注册/真清理链覆盖三态：无条目 false → 握手注册后 true →
  // 条目清理（断连即杀 → child exit → cleanupEntry）后 false。注册完成信号 = pid 文件
  // 落盘、清理完成信号 = pid 文件删除（与重复 recordId / 断连即杀用例同款信号，避免
  // 探测私有 Map）。
  t('hasByMainSessionId 真值表：无条目 false → 注册后 true → 条目清理后 false', async () => {
    await startServer()
    const registry = getActiveRelayRegistry()!
    expect(registry).toBeDefined()
    // 注册前：目标 mainSessionId 无任何在册条目
    expect(registry.hasByMainSessionId('main-1')).toBe(false)
    const agent = new TestAgent(getActiveRelaySocketPath()!)
    await agent.opened
    agent.send(validHandshake({ argv: [fakePi, 'hang'] }))
    await waitFor(() => existsSync(getRelayPidFilePath('rec-1', dataDir)), 30_000, 'relay registered (pid file)')
    expect(registry.hasByMainSessionId('main-1')).toBe(true)
    // per-sid 精度：其他 mainSessionId 仍无条目
    expect(registry.hasByMainSessionId('main-other')).toBe(false)
    // 断连即杀 → kill 链 → child exit → cleanupEntry 注销（pid 文件删除为完成信号）
    agent.destroy()
    await waitFor(() => !existsSync(getRelayPidFilePath('rec-1', dataDir)), 30_000, 'entry cleaned up after disconnect kill')
    expect(registry.hasByMainSessionId('main-1')).toBe(false)
  })

  // idle pi reclamation D3 第 5 步尾扫读面（u3a）：listTargetsByMainSessionId 真值表。
  // kill 可调且有效 = SIGTERM marker 落盘（假 pi hang 模式注册 SIGTERM handler 后写
  // ready，防杀链跑在 handler 注册前）；「杀完走注册表清理」断言 = pid 文件删除
  // （child 'exit' → cleanupEntry 的既有事件链，与 hasByMainSessionId 用例同款完成
  // 信号，不探测私有 Map）。
  t('listTargetsByMainSessionId 真值表：无条目空数组 → 注册后含目标且 kill 可调 → 清理后空', async () => {
    await startServer()
    const registry = getActiveRelayRegistry()!
    // 注册前：空数组
    expect(registry.listTargetsByMainSessionId('main-1')).toEqual([])
    const agent = new TestAgent(getActiveRelaySocketPath()!)
    await agent.opened
    const marker = join(workDir, 'sigterm-marker-list-targets')
    const ready = join(workDir, 'ready-marker-list-targets')
    const hs = validHandshake({ argv: [fakePi, 'hang'] })
    ;(hs.env as Record<string, string>).TAIJI_TEST_SIGTERM_MARKER = marker
    ;(hs.env as Record<string, string>).TAIJI_TEST_READY_MARKER = ready
    agent.send(hs)
    await waitFor(() => existsSync(getRelayPidFilePath('rec-1', dataDir)), 30_000, 'relay registered (pid file)')
    await waitFor(() => existsSync(ready), 30_000, 'fake-pi ready (SIGTERM handler registered)')
    const targets = registry.listTargetsByMainSessionId('main-1')
    expect(targets).toHaveLength(1)
    // per-sid 精度：其他 mainSessionId 仍为空
    expect(registry.listTargetsByMainSessionId('main-other')).toEqual([])
    // kill 可调且有效：kill 链发出 SIGTERM（假 pi 写 marker 后退出）
    await targets[0]!.kill()
    await waitFor(() => existsSync(marker), 30_000, 'SIGTERM marker (kill chain fired)')
    // 杀完无需手工注销：child 'exit' handler 自动 cleanupEntry（pid 文件删除为完成信号）
    await waitFor(() => !existsSync(getRelayPidFilePath('rec-1', dataDir)), 30_000, 'entry cleaned after kill')
    expect(registry.listTargetsByMainSessionId('main-1')).toEqual([])
    agent.destroy()
  })

  describe('重启残留扫描（伪造 stale pid 文件 + 时间戳）', () => {
    // pid 文件先于 server 写入（模拟崩溃残留），children 目录需预建（生产由 registry 构造建）
    beforeEach(async () => {
      await mkdir(getRelayChildrenDir(dataDir), { recursive: true })
    })

    t('死 pid → 删除 stale 文件', async () => {
      const pidFile = getRelayPidFilePath('rec-stale', dataDir)
      await writeFileAsync(pidFile, JSON.stringify({ pid: 999_999_999, spawnedAt: Date.now() }))
      await startServer()
      await waitFor(() => !existsSync(pidFile), 30_000, 'stale pid file removed')
    })

    t('畸形 pid 文件 → 删除', async () => {
      const pidFile = getRelayPidFilePath('rec-bad', dataDir)
      await writeFileAsync(pidFile, 'not json')
      await startServer()
      await waitFor(() => !existsSync(pidFile), 30_000, 'malformed pid file removed')
    })

    t('pid 复用防护：活进程但启动时间晚于 spawn 记录 → 不杀，仅删记录', async () => {
      // 起一个长睡进程（现在的启动时间）
      const sleeper = join(workDir, 'sleeper.mjs')
      await writeFile(sleeper, 'setTimeout(() => {}, 60000)\n')
      const { spawn } = await import('node:child_process')
      const child = spawn(process.execPath, [sleeper], { stdio: 'ignore' })
      await waitFor(() => typeof child.pid === 'number', 4_000, 'sleeper pid')
      // pid 文件伪造「很久以前 spawn」（进程实际刚启动 → procStart > spawnedAt+容差 → 判复用）
      const pidFile = getRelayPidFilePath('rec-reuse', dataDir)
      await writeFileAsync(pidFile, JSON.stringify({ pid: child.pid, spawnedAt: Date.now() - 10 * 60_000 }))
      await startServer()
      await waitFor(() => !existsSync(pidFile), 30_000, 'reused pid record removed')
      // 无辜进程未被杀
      expect(child.exitCode === null && child.signalCode === null).toBe(true)
      child.kill('SIGKILL')
    })

    t('活孤儿（启动时间不晚于 spawn 记录）→ 收割（SIGTERM）', async () => {
      const marker = join(workDir, 'orphan-marker')
      const orphan = join(workDir, 'orphan.mjs')
      await writeFile(orphan, [
        "import { writeFileSync } from 'node:fs'",
        `writeFileSync(${JSON.stringify(join(workDir, 'orphan-boot.json'))}, 'booted')`,
        "process.on('SIGTERM', () => {",
        `  writeFileSync(${JSON.stringify(marker)}, 'reaped')`,
        '  process.exit(0)',
        '})',
        'setTimeout(() => {}, 60000)',
        '',
      ].join('\n'))
      const { spawn } = await import('node:child_process')
      const child = spawn(process.execPath, [orphan], { stdio: 'ignore' })
      await waitFor(() => existsSync(join(workDir, 'orphan-boot.json')), 30_000, 'orphan booted')
      // 孤儿形态：spawn 在「现在」（进程已启动后写记录），runtime 已死（无注册表）
      const pidFile = getRelayPidFilePath('rec-orphan', dataDir)
      await writeFileAsync(pidFile, JSON.stringify({ pid: child.pid, spawnedAt: Date.now() }))
      await startServer()
      await waitFor(() => existsSync(marker), 30_000, 'orphan reaped by sweep')
      await waitFor(() => !existsSync(pidFile), 30_000, 'orphan pid file removed')
    })

    // 分级处置（2026-09-24 事故修复）：孤儿判定保持，处置按 tee 活跃度分级——
    // 静默孤儿（无 tee 证据含）立即收割（上一用例锁定）；仍在产出的活跃孤儿
    // 登记 pending 延迟收割，tee 静默到期后补杀。
    t('活跃孤儿（tee 近期有写入）→ defer（pendingSince 登记，不杀）；tee 静默后 → 补杀', async () => {
      const marker = join(workDir, 'orphan-marker-active')
      const orphan = join(workDir, 'orphan-active.mjs')
      await writeFile(orphan, [
        "import { writeFileSync } from 'node:fs'",
        `writeFileSync(${JSON.stringify(join(workDir, 'orphan-active-boot.json'))}, 'booted')`,
        "process.on('SIGTERM', () => {",
        `  writeFileSync(${JSON.stringify(marker)}, 'reaped')`,
        '  process.exit(0)',
        '})',
        'setTimeout(() => {}, 60000)',
        '',
      ].join('\n'))
      const { spawn } = await import('node:child_process')
      const child = spawn(process.execPath, [orphan], { stdio: 'ignore' })
      await waitFor(() => existsSync(join(workDir, 'orphan-active-boot.json')), 30_000, 'orphan booted')
      // 活跃形态：tee 镜像文件刚写入（mtime = 现在 → idleMs ≈ 0 < 阈值）
      const recordId = 'rec-active'
      const pidFile = getRelayPidFilePath(recordId, dataDir)
      await writeFileAsync(pidFile, JSON.stringify({ pid: child.pid, spawnedAt: Date.now() }))
      const logsDir = join(dataDir, 'logs')
      mkdirSync(logsDir, { recursive: true })
      const teeFile = join(logsDir, `pi-relay-${new Date().toISOString().slice(0, 10)}-${recordId}.jsonl`)
      writeFileSync(teeFile, '{"type":"message_update"}\n')
      await startServer()
      const registry = getActiveRelayRegistry()
      if (registry === null || registry === undefined) throw new Error('registry not active')
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        await registry.sweepOrphanChildren()
        // 活跃孤儿被 defer：未杀（marker 不出现）+ pendingSince 已登记 + warn 留痕
        expect(existsSync(marker)).toBe(false)
        const pending = JSON.parse(readFileSync(pidFile, 'utf-8')) as { pendingSince?: number }
        expect(typeof pending.pendingSince).toBe('number')
        expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('deferred reap'))).toBe(true)
      } finally {
        warnSpy.mockRestore()
      }
      // tee 静默到期（mtime 回拨到 10 分钟前）→ 再次 sweep 补杀
      const stale = new Date(Date.now() - 10 * 60_000)
      utimesSync(teeFile, stale, stale)
      await registry.sweepOrphanChildren()
      await waitFor(() => existsSync(marker), 30_000, 'deferred orphan reaped after going idle')
      await waitFor(() => !existsSync(pidFile), 30_000, 'deferred orphan pid file removed')
    })

    t('children 目录读不到（readdir 失败）→ warn 出声 + 不抛（本轮 sweep 跳过）', async () => {
      // 权限位方案在 owner 运行下不可靠，用「目录被常规文件占位」构造 readdir ENOTDIR
      await startServer()
      const registry = getActiveRelayRegistry()!
      const childrenPath = getRelayChildrenDir(dataDir)
      rmSync(childrenPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      writeFileSync(childrenPath, 'occupied by regular file (readdir ENOTDIR)')
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        await expect(registry.sweepOrphanChildren()).resolves.toBeUndefined()
        expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('orphan sweep skipped'))).toBe(true)
        expect(warnSpy.mock.calls.some(([, detail]) => String(detail).includes('ENOTDIR'))).toBe(true)
      } finally {
        warnSpy.mockRestore()
        // 还原为空位（afterEach rm 递归清理 dataDir 时文件/目录皆可删，这里显式删防残留形态）
        rmSync(childrenPath, { force: true })
      }
    })
  })

  t('message-bus topic 登记：session.subagentEntriesAppended 是 state 类（验收 3）', () => {
    expect(topicOf('session.subagentEntriesAppended')).toBe('state')
    // stream_delta 维持 transient（tee 续用既有帧，不改变 topic 分类）
    expect(topicOf('subagent.stream_delta')).toBe('transient')
  })
})
