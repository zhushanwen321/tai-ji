/**
 * 磁盘 outbox 崩溃恢复全链单测（统一投递波 4，设计 §3.8 文本行 / impl-plan A9；mock 轨，
 * 零 pi 进程零 token——真进程轨归 e2e-map E2E-DELIVERY-02）。
 *
 * 场景矩阵（任务书验收四项）：
 * 1. 崩溃恢复：受理落盘 → 进程「重启」（新 registry + 新 pi client 实例）→ reattach 对账
 *    （'pi-restored'）尾接 outbox 重放 → 未送达消息重新入队（on-accept 立即出站）/ 已送达的
 *    （transcript 裸标记命中）只记账不重投；
 * 2. ack 终局行：message_end 送达回执 → 磁盘终局行写入 → 重启后 loadUndelivered 不含（防复活）；
 * 3. 撤销 cancelled 终局 + segments 回填：重启重入队条目的撤销走 clear_queue 收回路径写
 *    cancelled 终局，且返回磁盘 meta 行回填的原始 segments；
 * 4. 文件损坏容错：损坏行（坏 JSON）跳过，不炸内核播种与重放。
 *
 * 磁盘写目标 = mkdtempSync 自建自删（测试禁触真实数据目录红线）；装配 = 真 SessionDeliveryRegistry
 * + 真磁盘 store + MockPiClient（IPiEngine 窄接口替身）。等待用短轮询 until（事件同步链无
 * timer 逻辑断言，真 timers；与 equivalence 族 STEP_TIMEOUT 同款形态）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendFileSync as fsAppend,
  existsSync as fsExists,
  mkdirSync as fsMkdir,
  readFileSync as fsRead,
  mkdtempSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionDeliveryRegistry, type SessionDeliveryDeps } from '../session-delivery-registry.js'
import { createDiskDeliveryStore } from '@zhushanwen/session-delivery'
import type { DeliveryStore } from '@zhushanwen/session-delivery'
import { markerLiteral } from '@taiji/shared'
import type { IManagedSessionView } from '../types.js'
import type { IPiEngine } from '../../ports/pi-engine.js'

/** 短轮询等待（谓词命中即返；超时 2s 显式失败，防静默悬挂）。 */
async function until<T>(predicate: () => T | undefined | null, label: string): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = predicate()
    if (value !== undefined && value !== null) return value
    if (Date.now() - start > 2_000) throw new Error(`until timeout: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** 固定 uuid（裸标记判据只认 `u-<uuid>` 形态）；出站文本尾附标记由 registry 构造。 */
const UUID_A = 'u-aaaaaaa1-0000-4000-8000-000000000001'
const UUID_B = 'u-bbbbbbb2-0000-4000-8000-000000000002'
const UUID_C = 'u-ccccccc3-0000-4000-8000-000000000003'
const UUID_D = 'u-ddddddd4-0000-4000-8000-000000000004'
const BARE_A = UUID_A.slice(2)
const BARE_B = UUID_B.slice(2)
const BARE_C = UUID_C.slice(2)

const TEXT_A = 'undelivered crash msg'
const TEXT_B = 'already delivered msg'
const TEXT_C = 'revoke after restart msg'

/** MockPiClient：registry 消费的 IPiEngine 窄接口替身（prompt / onEvent / getEntries / getCommands / clearQueue）。 */
class MockPiClient {
  eventListener: ((event: unknown) => void) | undefined
  transcriptEntries: unknown[] = []
  cleared: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] }
  promptCalls: Array<{ text: string; behavior?: string }> = []

  async prompt(text: string, _images?: unknown, streamingBehavior?: 'steer' | 'followUp'): Promise<unknown> {
    this.promptCalls.push({ text, ...(streamingBehavior !== undefined ? { behavior: streamingBehavior } : {}) })
    return { data: {} }
  }

  async getEntries(): Promise<unknown> {
    return { data: { entries: this.transcriptEntries } }
  }

  async getCommands(): Promise<unknown[]> {
    return []
  }

  onEvent(listener: (event: unknown) => void): () => void {
    this.eventListener = listener
    return () => {}
  }

  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    return this.cleared
  }

  /** 派 user message_end（送达回执：文本命中裸标记 → delivered 终局）。 */
  emitMessageEnd(text: string): void {
    this.eventListener?.({
      type: 'message_end',
      message: { role: 'user', content: [{ type: 'text', text }] },
    })
  }
}

/** registry 内存 view（holdReason/lane 判定宿主；occupancy 缺省 = idle）。 */
function makeView(id: string): IManagedSessionView {
  return {
    id,
    cwd: '/tmp/fake-cwd',
    label: id,
    modelId: 'test-model',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    tokenCount: 0,
    inputTokens: 0,
    isGenerating: false,
    isCompacting: false,
    isBashRunning: false,
    bashRunToken: undefined,
  }
}

/** 装配套件：mkdtemp outbox 目录 + 可换装的 client 表 + 真 store 工厂。 */
function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'delivery-outbox-crash-'))
  const clients = new Map<string, MockPiClient>()
  const views = new Map<string, IManagedSessionView>()
  const deps: SessionDeliveryDeps = {
    getSession: (sid) => views.get(sid),
    ensureActive: async (sid) => {
      const client = clients.get(sid)
      if (!client) throw new Error(`mock client missing for ${sid}`)
      return client as unknown as IPiEngine
    },
    subscribeAgentSettled: () => () => {},
    recordWorkspace: () => {},
    getMessageBus: () => null,
    createDeliveryStore: (sid) =>
      createDiskDeliveryStore({
        fs: { existsSync: fsExists, mkdirSync: fsMkdir, readFileSync: fsRead, appendFileSync: fsAppend },
        dir,
        file: join(dir, `${sid}.jsonl`),
      }),
  }
  const viewOf = (sid: string): IManagedSessionView => {
    let view = views.get(sid)
    if (!view) {
      view = makeView(sid)
      views.set(sid, view)
    }
    return view
  }
  return {
    dir,
    deps,
    clients,
    viewOf,
    /** transcript user entry 构造（已送达证据：文本 + 尾附裸标记，与出站形态同构）。 */
    userEntry(text: string): unknown {
      return { type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } }
    },
    readFile(): string {
      return fsRead(join(dir, 's1.jsonl'), 'utf8')
    },
    /** 独立 store 实例直读磁盘（重启语义：不经 registry）。 */
  }
}

type Harness = ReturnType<typeof makeHarness>

/** 便捷断言：磁盘文件含指定行型 + id。 */
function expectLine(file: string, lineType: string, id: string): void {
  expect(file).toContain(`"t":"${lineType}"`)
  expect(file).toContain(id)
}

describe('磁盘 outbox 崩溃恢复（波 4，mock 全链）', () => {
  const harnesses: Harness[] = []
  function harness(): Harness {
    const h = makeHarness()
    harnesses.push(h)
    return h
  }
  afterEach(() => {
    for (const h of harnesses.splice(0)) rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('场景 1 崩溃恢复：受理落盘 → 重启 → 未送达重新入队、已送达只记账不重投', async () => {
    const h = harness()
    h.viewOf('s1')
    const client1 = new MockPiClient()
    h.clients.set('s1', client1)
    const r1 = createSessionDeliveryRegistry(h.deps)

    // 受理即落盘（内核 persistBeforeAccept 在 sendChecked 同步段）
    r1.submit('s1', { content: TEXT_A, clientUuid: UUID_A })
    r1.submit('s1', { content: TEXT_B, clientUuid: UUID_B })
    const persisted = until(() => (h.readFile().match(/"t":"record"/g) ?? []).length >= 2 ? h.readFile() : undefined, 'two record lines')
    await persisted
    // 两条都受理出站（on-accept：mock prompt 立即受理 → in-flight，未送达即「崩溃」）
    // 谓词内每次重取 entries（视图为调用时点快照，闭包持有会冻结旧态）
    await until(
      () => ((r1.entries('s1')?.active.filter((e) => e.state === 'in-flight').length ?? 0) === 2 ? true : undefined),
      'both in-flight',
    )
    expect(client1.promptCalls.length).toBe(2)
    r1.disposeAll()

    // 「重启」：新 registry + 新 pi 进程；transcript：A 未进（未送达）、B 已进（已送达）
    const client2 = new MockPiClient()
    client2.transcriptEntries = [h.userEntry(`${TEXT_B}\n${markerLiteral(BARE_B)}`)]
    h.clients.set('s1', client2)
    const r2 = createSessionDeliveryRegistry(h.deps)
    r2.getOrCreateDelivery('s1') // = reattach 包装的 ensureDeliveryRuntime
    await r2.reconcile('s1', 'pi-restored') // restore 后对账 → outbox 重放

    // A：未送达 → 重新入队（on-accept 立即出站 → in-flight）
    await until(
      () => (r2.entries('s1')?.active.some((e) => e.id === UUID_A && e.state === 'in-flight') ? true : undefined),
      'A requeued',
    )
    // B：已送达 → 不重投（active 无 B、tombstones delivered）
    const r2Full = r2.entries('s1')
    expect(r2Full?.active.some((e) => e.id === UUID_B)).toBe(false)
    expect(r2Full?.tombstones.some((t) => t.id === UUID_B && t.state === 'delivered')).toBe(true)
    // 重投证据：重启后 prompt 恰 1 次且为 A 文本（B 零投递）
    expect(client2.promptCalls.length).toBe(1)
    expect(client2.promptCalls[0]?.text).toContain(TEXT_A)
  })

  it('场景 2 ack 终局行：message_end 送达回执写磁盘终局行，重启后不复活', async () => {
    const h = harness()
    h.viewOf('s1')
    const client1 = new MockPiClient()
    h.clients.set('s1', client1)
    const r1 = createSessionDeliveryRegistry(h.deps)
    r1.submit('s1', { content: TEXT_A, clientUuid: UUID_A })
    await until(
      () => (r1.entries('s1')?.active.some((e) => e.id === UUID_A && e.state === 'in-flight') ? true : undefined),
      'A in-flight',
    )

    // 送达回执：message_end(user) 命中裸标记 → delivered 终局 → store.ack
    client1.emitMessageEnd(`${TEXT_A}\n${markerLiteral(BARE_A)}`)
    await until(
      () => (r1.entries('s1')?.tombstones.some((t) => t.id === UUID_A && t.state === 'delivered') ? true : undefined),
      'A delivered',
    )
    expectLine(h.readFile(), 'ack', UUID_A)

    // 重启语义：独立 store 实例读同一文件——终局行挡复活
    const revived: DeliveryStore = createDiskDeliveryStore({
      fs: { existsSync: fsExists, mkdirSync: fsMkdir, readFileSync: fsRead, appendFileSync: fsAppend },
      dir: h.dir,
      file: join(h.dir, 's1.jsonl'),
    })
    expect(revived.loadUndelivered().map((r) => r.id)).toEqual([])
    expect(revived.hasTerminal(UUID_A)).toBe(true)
  })

  it('场景 3 撤销 cancelled 终局 + segments 回填：重启后撤销返回磁盘回填的原始 segments', async () => {
    const h = harness()
    h.viewOf('s1')
    const client1 = new MockPiClient()
    h.clients.set('s1', client1)
    const r1 = createSessionDeliveryRegistry(h.deps)
    r1.submit('s1', { content: TEXT_C, clientUuid: UUID_C })
    await until(
      () => (r1.entries('s1')?.active.some((e) => e.id === UUID_C && e.state === 'in-flight') ? true : undefined),
      'C in-flight',
    )
    // segments 快照补记（meta 行跨重启存活）
    r1.attachSegments('s1', UUID_C, [
      { type: 'text', text: 'seg-alpha' },
      { type: 'image', id: 'img-1', path: '/tmp/seg.png', fileName: 'seg.png', displayName: 'seg' },
    ])
    expectLine(h.readFile(), 'meta', UUID_C)
    // 不撤销直接「崩溃」（in-flight 留磁盘）
    r1.disposeAll()

    // 重启：transcript 空（未送达）→ 重放重入队
    const client2 = new MockPiClient()
    h.clients.set('s1', client2)
    const r2 = createSessionDeliveryRegistry(h.deps)
    r2.getOrCreateDelivery('s1')
    await r2.reconcile('s1', 'pi-restored')
    await until(
      () => (r2.entries('s1')?.active.some((e) => e.id === UUID_C && e.state === 'in-flight') ? true : undefined),
      'C requeued',
    )

    // 重启后撤销：clear_queue 收回路径 → cancelled 终局 + 磁盘回填的 segments 随全文返回
    const outboundText = `${TEXT_C}\n${markerLiteral(BARE_C)}`
    client2.cleared = { steering: [outboundText], followUp: [] }
    const outcome = await r2.cancel('s1', UUID_C)
    expect(outcome.cancelled).toBe(true)
    expect(outcome.content).toBe(outboundText)
    expect(outcome.segments).toEqual([
      { type: 'text', text: 'seg-alpha' },
      { type: 'image', id: 'img-1', path: '/tmp/seg.png', fileName: 'seg.png', displayName: 'seg' },
    ])
    expectLine(h.readFile(), 'ack', UUID_C)

    // cancelled 终局挡复活：再次重启 → 重放后 active 无 C
    const client3 = new MockPiClient()
    h.clients.set('s1', client3)
    const r3 = createSessionDeliveryRegistry(h.deps)
    r3.getOrCreateDelivery('s1')
    await r3.reconcile('s1', 'pi-restored')
    expect(r3.entries('s1')?.active.some((e) => e.id === UUID_C)).toBe(false)
    expect(client3.promptCalls.length).toBe(0)
  })

  it('场景 4 文件损坏容错：损坏行跳过，不炸内核判重播种与重放', async () => {
    const h = harness()
    // 手写损坏文件：合法 record 行 + 坏 JSON 半行 + 纯垃圾行
    fsAppend(
      join(h.dir, 's1.jsonl'),
      [
        JSON.stringify({
          t: 'record',
          r: {
            id: UUID_D,
            lane: 'direct',
            payload: { kind: 'text', content: `${TEXT_A}\n${markerLiteral(UUID_D.slice(2))}` },
            intent: 'interrupt-at-turn-boundary',
            recordedAt: 1,
            receiptAnchor: 'marker',
          },
        }),
        '{"t":"record","r":{"id":"trunca', // 崩溃写入的中途半行
        'garbage-not-json',
      ].join('\n') + '\n',
    )
    h.viewOf('s1')
    const client1 = new MockPiClient()
    h.clients.set('s1', client1)
    const r1 = createSessionDeliveryRegistry(h.deps)
    // 内核构造（loadTerminalIds 播种）不炸
    expect(() => r1.getOrCreateDelivery('s1')).not.toThrow()
    // 重放只处理合法行（UUID_D 重入队），坏行静默跳过
    await r1.reconcile('s1', 'pi-restored')
    await until(
      () => (r1.entries('s1')?.active.some((e) => e.id === UUID_D) ? true : undefined),
      'D requeued from corrupted file',
    )
    expect(r1.entries('s1')?.active.some((e) => e.id === 'trunca')).toBe(false)
  })
})
