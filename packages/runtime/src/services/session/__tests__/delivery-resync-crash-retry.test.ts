/**
 * 崩溃断连后 manual retry 恢复支线单测（remote-use-mobile-v2 §6.22 failed 重试语义 / A5
 * 缺陷修复；mock 层，零 pi 进程零 token）。
 *
 * 缺陷背景：pi 意外死亡（SIGKILL）的销毁收敛链（onSessionExit → removeSessionEntry →
 * delivery.dispose）把 failed 留守条目连同运行时态一并丢弃，UI 仍持 failed 行快照可点
 * 重试——修复前 resync 对 `!rt` 一律返回空 = 静默 no-op，「发送未确认」无限滞留。
 *
 * 修复语义：resync `!rt` 时查磁盘 outbox 未终局记录（受理前 persist 的耐久承诺），命中 =
 * 未送达事实在案 → deps.ensureActive 惰性恢复（respawn.ensureRestored 单源 join）→
 * ensureRuntime 重建 → 'pi-restored' 对账尾部 replayUndelivered 以原 id 重投（transcript
 * 判重防双发）。未命中保持只读（不复活被 idle 回收的 session，既有裁决边界）。
 *
 * 场景矩阵：
 * 1. 崩溃后重试未送达条目：dispose 丢弃运行时态（磁盘 record 留存）→ resync → 恢复 +
 *    重投（原 id in-flight、prompt 收到原文）→ 回执 deduped=[]（条目未确认送达，权威状态
 *    以 session.delivery 快照为单源）；
 * 2. 崩溃后重试已送达条目（首败歧义：文本已进 transcript 未及回执）：不重投，补 delivered
 *    记账，回执 deduped 含该 id（renderer 据此隐去该行）；
 * 3. 未命中不拉起：磁盘无未终局记录 → resync 零恢复动作（ensureActive 不被调用）；
 * 4. 恢复失败降级：ensureActive 拒绝 → 返回空不炸，条目留守 renderer 可再试。
 *
 * 装配 = 真 SessionDeliveryRegistry + 真磁盘 store（mkdtemp 自建自删）+ MockPiClient，
 * 与 delivery-outbox-crash-recovery.test.ts 同款形态。
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
const UUID_A = 'u-aaaaaa01-0000-4000-8000-000000000001'
const UUID_UNKNOWN = 'u-ffffff01-0000-4000-8000-00000000ffff'
const BARE_A = UUID_A.slice(2)

const TEXT_A = 'queued message killed mid-flight'

/** MockPiClient：registry 消费的 IPiEngine 窄接口替身（prompt / onEvent / getEntries / getCommands / clearQueue）。 */
class MockPiClient {
  eventListener: ((event: unknown) => void) | undefined
  transcriptEntries: unknown[] = []
  cleared: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] }
  promptCalls: Array<{ text: string }> = []

  async prompt(text: string): Promise<unknown> {
    this.promptCalls.push({ text })
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
    bashRunToken: undefined,
  }
}

/** 装配套件：mkdtemp outbox 目录 + 可换装的 client 表 + ensureActive 调用计数。 */
function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'delivery-resync-crash-'))
  const clients = new Map<string, MockPiClient>()
  const views = new Map<string, IManagedSessionView>()
  const ensureActiveCalls: string[] = []
  const deps: SessionDeliveryDeps = {
    getSession: (sid) => views.get(sid),
    ensureActive: async (sid) => {
      ensureActiveCalls.push(sid)
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
    ensureActiveCalls,
    /** transcript user entry 构造（已送达证据：文本 + 尾附裸标记，与出站形态同构）。 */
    userEntry(text: string): unknown {
      return { type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } }
    },
  }
}

type Harness = ReturnType<typeof makeHarness>

describe('崩溃断连后 resync manual retry 恢复（§6.22 failed 重试 / A5）', () => {
  const harnesses: Harness[] = []
  function harness(): Harness {
    const h = makeHarness()
    harnesses.push(h)
    return h
  }
  afterEach(() => {
    for (const h of harnesses.splice(0)) rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** 崩溃现场构造：受理落盘 → in-flight（模拟 SIGKILL 前形态）→ dispose 丢弃运行时态。 */
  async function crashedWithPersistedEntry(h: Harness, registry: ReturnType<typeof createSessionDeliveryRegistry>): Promise<MockPiClient> {
    const client1 = new MockPiClient()
    h.clients.set('s1', client1)
    registry.submit('s1', { content: TEXT_A, clientUuid: UUID_A })
    await until(
      () => (registry.entries('s1')?.active.some((e) => e.id === UUID_A && e.state === 'in-flight') ? true : undefined),
      'A in-flight before crash',
    )
    // 销毁收敛链等价（onSessionExit → removeSessionEntry → delivery.dispose）：failed 留守
    // 条目随运行时态丢弃，磁盘 outbox record 行留存（persistBeforeAccept 的耐久承诺）。
    registry.dispose('s1')
    // 清崩溃前基线（submit 受理路径的 ensureActive 调用不属于被测行为）
    h.ensureActiveCalls.length = 0
    return client1
  }

  it('场景 1 崩溃后重试未送达条目：resync 触发恢复 + 原 id 重投，回执 deduped 为空', async () => {
    const h = harness()
    h.viewOf('s1')
    const r1 = createSessionDeliveryRegistry(h.deps)
    await crashedWithPersistedEntry(h, r1)

    // 「崩溃后」：新 pi 进程（transcript 空 = 文本随进程蒸发未进 transcript）
    const client2 = new MockPiClient()
    h.clients.set('s1', client2)

    // UI 点重试：delivery.resync（混合一个内核不认识的 uuid，验证不干扰恢复判定）
    const deduped = await r1.resync('s1', [UUID_A, UUID_UNKNOWN])

    // 回执 = []：条目未确认送达（重投在途），权威状态以 session.delivery 快照为单源
    expect(deduped).toEqual([])
    // 恢复触发证据：ensureActive 被调用（惰性恢复拉起 pi + 注册 session）
    expect(h.ensureActiveCalls).toContain('s1')
    // 重投证据：原 id 条目恢复在册（in-flight）+ prompt 收到原文
    await until(
      () => (r1.entries('s1')?.active.some((e) => e.id === UUID_A && e.state === 'in-flight') ? true : undefined),
      'A requeued in-flight after resync recovery',
    )
    expect(client2.promptCalls.some((c) => c.text.includes(TEXT_A))).toBe(true)
  })

  it('场景 2 崩溃后重试已送达条目：不重投补 delivered 记账，回执 deduped 含该 id', async () => {
    const h = harness()
    h.viewOf('s1')
    const r1 = createSessionDeliveryRegistry(h.deps)
    await crashedWithPersistedEntry(h, r1)

    // 「崩溃后」：transcript 已有该条目出站文本（首败歧义形态——文本已进 transcript 未及回执）
    const client2 = new MockPiClient()
    client2.transcriptEntries = [h.userEntry(`${TEXT_A}\n${markerLiteral(BARE_A)}`)]
    h.clients.set('s1', client2)

    const deduped = await r1.resync('s1', [UUID_A])

    // 已送达：不重投（prompt 零调用）+ delivered 终态记账 + deduped 应答（renderer 隐去该行）
    expect(deduped).toContain(UUID_A)
    const full = r1.entries('s1')
    expect(full?.active.some((e) => e.id === UUID_A)).toBe(false)
    expect(full?.tombstones.some((t) => t.id === UUID_A && t.state === 'delivered')).toBe(true)
    expect(client2.promptCalls.length).toBe(0)
  })

  it('场景 3 未命中不拉起：磁盘无未终局记录时 resync 零恢复动作', async () => {
    const h = harness()
    h.viewOf('s1')
    const r1 = createSessionDeliveryRegistry(h.deps)
    await crashedWithPersistedEntry(h, r1)

    // 未知 id：磁盘 outbox 无对应未终局记录（idle 回收 / 已 ack 终局形态）——保持只读，
    // 不复活 session（既有「resync 不拉起 pi」裁决边界）
    const deduped = await r1.resync('s1', [UUID_UNKNOWN])

    expect(deduped).toEqual([])
    expect(h.ensureActiveCalls).toEqual([])
  })

  it('场景 4 恢复失败降级：ensureActive 拒绝 → 返回空不炸，条目留守可再试', async () => {
    const h = harness()
    h.viewOf('s1')
    const r1 = createSessionDeliveryRegistry(h.deps)
    await crashedWithPersistedEntry(h, r1)

    // 恢复通道故障（session 文件损坏 / spawn 失败等）：ensureActive 拒绝
    h.clients.delete('s1')
    const deduped = await r1.resync('s1', [UUID_A])

    expect(deduped).toEqual([])
    // 保持现状：运行时态仍缺席（非创建性查询返回 undefined），renderer 侧 failed 行留存可再试
    expect(r1.entries('s1')).toBeUndefined()
  })
})
