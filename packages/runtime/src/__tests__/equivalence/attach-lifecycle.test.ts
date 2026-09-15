/**
 * W2 生命周期等价测试（restore-fork-attach-fix F4，不变量 I3 持久性屏障）。
 *
 * 被测不变量：附着正式文件后，会话进程退出/切换前，**登记文件必须包含 pi 已写的全部
 * entry**；重新 spawn 附着同一文件，状态（entry 数 / 最后 assistant 消息 / sessionId）
 * 与退出前一致。这正是 P0 根因（附着 tmp 文件 + unlink，pi 每轮 append 按路径重建孤儿，
 * 登记文件永不更新，重启全部丢失）的回归网。
 *
 * 覆盖边界（如实声明，ADR-0063 I3）：本测试族直接驱动 switchSession + attach 断言，
 * 不经过生产 restoreSession/forkSession 全管线——生产管线整段回退 tmp 附着时本测试族
 * 不红；该形态的运行时守卫是 I1 断言（接线在生产管线内，tmp 附着瞬间 mismatch 即
 * throw）+ 第三用例（mismatch-throw 行为锁定）。
 *
 * 三用例：
 * - restore 路径：真实会话文件 switchSession 附着 → 一轮真实 prompt → kill（dispose，
 *   SIGTERM→2s→SIGKILL，与 RpcClient.kill / ProcessManager.destroySession 同语义）→
 *   文件断言（逐 entry 类型：user message + 其后 assistant message，非只断言行数）→
 *   重新 spawn 附着同一文件断言状态一致。
 * - fork 路径：同构（createForkedSessionFile 生产函数产出 fork 文件 → attach → 真实轮次
 *   → kill → 文件含该轮 + 继承历史 → 重附着一致）。
 * - attach 断言行为（C2）：真实 switchSession(A) 成功后以期望路径 B 调生产 helper
 *   assertPiSessionFile → throw 且错误信息含 A/B/恢复指引；resolve 词法归一与
 *   /var vs /private/var symlink 形态均以真实附着实测（pi 侧不展开 symlink，探针定论
 *   见 process-manager.ts assertPiSessionFile 注释）。
 *
 * 环境约定照抄先例（live-reload.test.ts / pi-protocol-contract.test.ts）：真实 spawn
 * `pi --mode rpc`（fixture，禁 mock 子进程）。faux LLM 轨（L2.5 翻轨）：被测语义是
 * 附着/持久化屏障/断言行为（pi 自身机制），非模型智能——各轮 turn 响应由 fauxResponses
 * 脚本固定（marker 即脚本文本），断言语义与翻轨前一致；门控 FAUX_PI_READY（只判
 * binary，凭证无关、CI 可跑）。P1 模型恢复用例的演员替换：CLI 默认 = faux/faux-1、
 * 切换目标 = faux/faux-1-reasoning（被测语义「CLI model 恒优先于 entry 恢复」不变）。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import {
  spawnPiFixture,
  FAUX_PI_READY,
  FAUX_PI_SKIP_REASON,
  type PiFixture,
} from './pi-fixture.js'
import { assertPiSessionFile } from '../../infra/pi/session-attach-assert.js'
import { createForkedSessionFile } from '../../services/session/session-fork.js'
// applyHeaderCwdFallback 自 session-lifecycle 迁出（max-lines 行数合规），权威源在 restore-seeding。
import { applyHeaderCwdFallback } from '../../services/session/restore-seeding.js'

/**
 * 等 turn 完成的上限（真实 LLM 调用）。本文件用例最重（双冷启动 + 双轮 turn 等待），
 * 单独高于其余 equivalence 文件的 120s 口径。
 * [HISTORICAL] 两次放宽史（120 → 180 → 300；均因满并行全量测试 + 系统余载下真实 LLM
 * 轮次饿死——事件流证明轮次在推进、只是被拖慢，纯环境饿死非代码问题；断言强度不变，
 * 仅放宽等待上限）：
 * - 120 → 180（2026-08-20 PR #185 全量两连绿实测）：305 文件并行挤占 CPU/网络，LLM 轮次
 *   120s 内未完成（隔离跑全文件仅 27s 全绿）。
 * - 180 → 300（2026-08-20 PR #185 测试收尾）：满载全量下 180s 仍 2/4 概率超时，主 agent
 *   裁决对齐该目录 equivalence 文件 300-420s 用例口径。
 */
// 预算校准 [HISTORICAL]：满载环境单轮可超 300s（premerge 832s vs 144s ≈ 5.8× 实测），
// 对齐 tool-call-index beforeAll「冷启动+轮次+余量」口径上调至 420s；用例级同步
const TURN_TIMEOUT_MS = 420_000
/** switch_session 慢 RPC 上限（对齐生产 rpc-client SLOW_TIMEOUT_MS） */
const SWITCH_TIMEOUT_MS = 120_000
/** 用例总超时 = 多次冷启动 + 多轮 LLM turn + 多次 RPC + dispose 的和再留余量（2× TURN 裕度） */
const TEST_TIMEOUT_MS = 900_000

/** 文件层 entry 最小形态（loadEntriesFromFile 的 taiji 侧等价读取：逐行 JSON.parse） */
interface SessionFileEntry {
  type: string
  id?: string
  parentId?: string | null
  cwd?: string
  parentSession?: string
  message?: { role?: string; [key: string]: unknown }
  [key: string]: unknown
}

/** 等价读取（验收口径：loadEntriesFromFile 或等价读取）——pi 侧为逐行 parseSessionEntryLine */
function readSessionEntries(filePath: string): SessionFileEntry[] {
  return readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as SessionFileEntry)
}

/** message entry 的原文序列化（user 提交原文必然逐字落盘，暗号匹配用） */
function messageText(entry: SessionFileEntry): string {
  return JSON.stringify(entry.message ?? {})
}

/** get_entries → entry 列表（kill 前的 pi 内存态快照） */
async function fetchEntries(fx: PiFixture): Promise<SessionFileEntry[]> {
  const resp = await fx.sendCommand('get_entries')
  const raw: unknown = resp.data?.entries
  if (!Array.isArray(raw)) throw new Error('get_entries reply has no entries array')
  return raw
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map((e) => e as unknown as SessionFileEntry)
}

/** 最后一条 assistant message entry（kill 前/重附着后的状态一致性对比对象） */
function lastAssistantMessage(entries: SessionFileEntry[]): SessionFileEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.type === 'message' && e.message?.role === 'assistant') return e
  }
  return undefined
}

/** 生产 helper 的 fixture 适配（真实 get_state RPC，非 mock 返回值） */
function fixtureStateClient(fx: PiFixture): { getState(): Promise<Record<string, unknown> | undefined> } {
  return {
    getState: async () => {
      const resp = await fx.sendCommand('get_state')
      return resp.data
    },
  }
}

/**
 * 生成一个真实会话文件到 workDir（阶段 1 公共流程）：
 * spawn fixture → 真实 prompt 一轮（含暗号）→ agent_end（pi 已 flush 落盘）→
 * 复制到 workDir 并把 header cwd 归一到 workDir（fixture sessionDir 即将被 dispose 删除，
 * 死 cwd 会使下一次附着 throw MissingSessionCwdError——变换用生产纯函数
 * applyHeaderCwdFallback，与 restoreSession F3 管线同款）→ dispose。
 *
 * header 落盘竞态兜底（2026-08-22 sm-e2e cw verify 连续红定位）：agent_end 后立即
 * readFileSync(srcFile)，冷缓存/高负载环境（verify 干净 checkout 的 tmp 目录）下 pi 的
 * session header entry 可能晚于 message entry flush——首条读到 message entry，下游
 * header?.type === 'session' 断言假失败。copy 前轮询等待 header 落盘；超时仍无
 * header 按现状继续，交由调用方断言给出可诊断失败（不弱化断言）。
 */
function waitSessionHeaderFlushed(filePath: string, timeoutMs = 15_000): void {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const entries = readSessionEntries(filePath)
    if (entries.length > 0 && entries[0]?.type === 'session') return
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
  }
}

async function seedSessionFile(workDir: string, fileName: string, marker: string): Promise<string> {
  // faux 轨：种子轮回复由脚本固定（marker 即脚本文本，prompt 原文逐字落盘的断言锚不变）
  let fx = await spawnPiFixture({ fauxResponses: [{ text: marker }] })
  try {
    await fx.runTurn({ message: `Reply with exactly the word: ${marker}` }, TURN_TIMEOUT_MS)
    const state = await fx.sendCommand('get_state')
    const srcFile = state.data?.sessionFile
    if (typeof srcFile !== 'string') throw new Error(`get_state.sessionFile missing after seeded turn (marker: ${marker})`)
    waitSessionHeaderFlushed(srcFile)
    const target = join(workDir, fileName)
    const raw = readFileSync(srcFile, 'utf-8')
    writeFileSync(target, applyHeaderCwdFallback(raw, workDir))
    return target
  } finally {
    await fx.dispose()
  }
}

/**
 * 附着指定文件并跑一轮真实 prompt。返回 kill 前快照（双基线，口径实测定论）：
 * - beforeTurnMem：附着完成（switchSession 成功 + attach 断言过）后、prompt 前的
 *   get_entries 快照——pi 内存基线；
 * - beforeTurnFileCount：附着完成后登记文件的 entry 行数——文件基线。**必须在附着后取**：
 *   附着瞬间 pi 即向登记文件写入 entry（实测：2 条 custom entry，附着 = 立即绑定写目标的
 *   直接自证），附着前基线会把这批写入误计入 turn 增长；
 * - beforeKill：agent_end 后、kill 前的 get_entries 快照（pi 已全量持久化）。
 * 口径差异（实测定论）：文件含 session header entry，get_entries 不含——两侧各自相减
 * （afterFile − beforeTurnFileCount ↔ beforeKillMem − beforeTurnMem）口径差抵消。
 */
async function attachAndRunTurn(targetFile: string, marker: string): Promise<{ fx: PiFixture; beforeTurnMem: SessionFileEntry[]; beforeTurnFileCount: number; beforeKill: SessionFileEntry[] }> {
  // faux 轨同款：附着后一轮 turn 的回复 = marker（脚本固定）
  const fx = await spawnPiFixture({ fauxResponses: [{ text: marker }] })
  await fx.sendCommand('switch_session', { sessionPath: targetFile }, SWITCH_TIMEOUT_MS)
  // attach 断言（I1）：真实正式文件天然通过——本行同时是 C3「withEphemeralPi/附着天然通过」
  // 语义在真实 pi 上的直接证据。
  await assertPiSessionFile(fixtureStateClient(fx), targetFile, `attach-lifecycle(${basename(targetFile)})`)
  const beforeTurnMem = await fetchEntries(fx)
  const beforeTurnFileCount = readSessionEntries(targetFile).length
  // prompt→等本轮 end 改走 runTurn 原语（fixture 护栏 + since 游标，替代裸全量匹配）
  await fx.runTurn({ message: `Reply with exactly the word: ${marker}` }, TURN_TIMEOUT_MS)
  const beforeKill = await fetchEntries(fx)
  return { fx, beforeTurnMem, beforeTurnFileCount, beforeKill }
}

describe.skipIf(!FAUX_PI_READY)(
  `equivalence: attach 生命周期（faux-pi 子进程，W2${FAUX_PI_SKIP_REASON ? `｜skip：${FAUX_PI_SKIP_REASON}` : ''}）`,
  () => {
  let fixture: PiFixture | null = null

  afterEach(async () => {
    if (fixture) {
      await fixture.dispose()
      fixture = null
    }
  })

  it(
    'restore 路径：附着正式文件 → 真实轮次 → kill → 文件含该轮（逐 entry 类型）→ 重附着状态一致',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const workDir = mkdtempSync(join(tmpdir(), 'attach-equiv-restore-'))
      try {
        // ── 阶段 1：真实生成既有会话文件（= sessions 目录内的正式文件 / 登记路径）──
        const targetFile = await seedSessionFile(workDir, 'restored-session.jsonl', 'attach-seed')
        const header = readSessionEntries(targetFile)[0]
        expect(header?.type).toBe('session')
        const seedCount = readSessionEntries(targetFile).length
        expect(seedCount).toBeGreaterThan(0)

        // ── 阶段 2：restore 形态附着 + 一轮真实对话 ──
        const { fx, beforeTurnMem, beforeTurnFileCount, beforeKill } = await attachAndRunTurn(targetFile, 'attach-round-2')
        fixture = fx

        // 附着写入时机基线校准 [HISTORICAL]：pi 0.84.1 实测附着（switch_session）不再立即
        // 向目标文件写 entry，首个真实 turn 落盘时才写入（探针实测 5s 零增长、turn 后
        // message 正常追加）。旧断言「附着瞬间写 ≥2 条 entry」已过期删除；写目标绑定的
        // 即时自证由 assertPiSessionFile（get_state().sessionFile）覆盖，文件层由阶段 3
        // 增长守恒断言（afterKill − beforeTurnFileCount ≡ beforeKill − beforeTurnMem）承接。

        // ── 阶段 3：kill（dispose ≈ destroySession：SIGTERM → 2s → SIGKILL）──
        await fx.dispose()
        fixture = null

        // ── 阶段 4：持久性屏障（I3）——登记文件包含 pi 已写的全部 entry ──
        const afterKill = readSessionEntries(targetFile)
        // 增长量守恒（I3 精确表述）：pi 内存新增 N 条（beforeKill − beforeTurnMem）⇒ 文件
        // 新增 N 条（afterKill − beforeTurnFileCount）。两侧基线都在附着后取，口径差
        //（文件含 header、get_entries 不含）相减抵消。tmp 附着回退形态下此处必红：登记文件零增长。
        expect(afterKill.length - beforeTurnFileCount).toBe(beforeKill.length - beforeTurnMem.length)
        // 逐 entry 类型可指认（非只断言行数）：本轮 user message entry——用户提交原文必然
        // 逐字落盘，暗号匹配是强断言
        const round2UserIdx = afterKill.findIndex(
          (e) => e.type === 'message' && e.message?.role === 'user' && messageText(e).includes('attach-round-2'),
        )
        expect(round2UserIdx).toBeGreaterThan(-1)
        // 其后（同轮）assistant message entry——LLM 回复落盘
        const tail = afterKill.slice(round2UserIdx + 1)
        expect(tail.filter((e) => e.type === 'message' && e.message?.role === 'assistant').length).toBeGreaterThanOrEqual(1)
        // 继承的历史未被破坏：种子轮次的 user entry 仍在
        expect(afterKill.some((e) => e.type === 'message' && e.message?.role === 'user' && messageText(e).includes('attach-seed'))).toBe(true)
        // 新轮次确实发生在文件上：行数较附着前增长
        expect(afterKill.length).toBeGreaterThan(seedCount)

        // ── 阶段 5：重附着等价——重新 spawn 附着同一文件，状态一致 ──
        // （faux 轨：重附着无 LLM turn，空队列即意外 turn 的 fail-fast）
        let fx2: PiFixture | null = await spawnPiFixture({ fauxResponses: [] })
        fixture = fx2
        try {
          await fx2.sendCommand('switch_session', { sessionPath: targetFile }, SWITCH_TIMEOUT_MS)
          await assertPiSessionFile(fixtureStateClient(fx2), targetFile, 'restore-reattach')
          // 附着语义完整：pi 的 sessionId = 文件 header 的会话 id（附着的就是这个文件的那个会话）
          const state = await fx2.sendCommand('get_state')
          expect(state.data?.sessionId).toBe(header.id)
          const afterReattach = await fetchEntries(fx2)
          // 同口径等价（get_entries ↔ get_entries）：重附着后 pi 读到的**历史**与 kill 前
          // 逐条一致——以 kill 前最后一条 entry id 为界，界前 deep equal（无丢失/重复/篡改）；
          // 界后仅允许 pi 附着行为自身的追加（实测每次附着写 ~2 条 custom entry，写方是
          // pi、落在登记文件，属合法），不得改写历史。
          const lastKillId = beforeKill[beforeKill.length - 1]?.id
          if (typeof lastKillId !== 'string') throw new Error('beforeKill last entry has no id')
          const cutIdx = afterReattach.findIndex((e) => e.id === lastKillId)
          expect(cutIdx).toBe(beforeKill.length - 1)
          expect(afterReattach.slice(0, cutIdx + 1)).toEqual(beforeKill)
          expect(lastAssistantMessage(afterReattach)).toEqual(lastAssistantMessage(afterKill))
        } finally {
          await fx2.dispose()
          fixture = null
          fx2 = null
        }
      } finally {
        rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    },
  )

  it(
    'fork 路径：fork 文件 attach → 真实轮次 → kill → 文件含该轮 + 继承历史 → 重附着状态一致',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const workDir = mkdtempSync(join(tmpdir(), 'attach-equiv-fork-'))
      try {
        // ── 阶段 1：真实源会话 ──
        const sourceFile = await seedSessionFile(workDir, 'fork-source.jsonl', 'attach-fork-seed')
        const sourceEntries = readSessionEntries(sourceFile)
        // fork 点 = 源文件最后一条 message entry（includeFrom=true 保留全历史）
        let forkEntryId: string | undefined
        for (let i = sourceEntries.length - 1; i >= 0; i--) {
          const e = sourceEntries[i]
          if (e.type === 'message' && typeof e.id === 'string') { forkEntryId = e.id; break }
        }
        if (typeof forkEntryId !== 'string') throw new Error('fork source has no message entry with id')

        // ── 阶段 2：生产 fork 链路产出 fork 文件（登记表 §4 ⑥ 创建型合法形态）──
        const forked = await createForkedSessionFile(sourceFile, forkEntryId, true, workDir, forkEntryId)
        expect(existsSync(forked.filePath)).toBe(true)
        // 血缘指针未断（V3 语义的文件层断言）：header.parentSession 指回源文件
        const forkHeader = readSessionEntries(forked.filePath)[0]
        expect(forkHeader?.type).toBe('session')
        expect(forkHeader?.parentSession).toBe(sourceFile)
        // ── 阶段 3：fork 文件附着 + 一轮真实对话 ──
        // 附着写入时机基线校准同 restore 用例 [HISTORICAL]：不再要求附着即写盘
        const { fx, beforeTurnMem, beforeTurnFileCount, beforeKill } = await attachAndRunTurn(forked.filePath, 'attach-fork-round')

        // ── 阶段 4：kill ──
        await fx.dispose()
        fixture = null

        // ── 阶段 5：持久性屏障——fork 文件包含该轮 + 继承历史 ──
        const afterKill = readSessionEntries(forked.filePath)
        // 附着写入时机基线校准同 restore 用例 [HISTORICAL]：不再要求附着即写盘
        expect(afterKill.length - beforeTurnFileCount).toBe(beforeKill.length - beforeTurnMem.length)
        const roundUserIdx = afterKill.findIndex(
          (e) => e.type === 'message' && e.message?.role === 'user' && messageText(e).includes('attach-fork-round'),
        )
        expect(roundUserIdx).toBeGreaterThan(-1)
        const tail = afterKill.slice(roundUserIdx + 1)
        expect(tail.filter((e) => e.type === 'message' && e.message?.role === 'assistant').length).toBeGreaterThanOrEqual(1)
        // fork 继承的源历史在文件内（树过滤保留）
        expect(afterKill.some((e) => e.type === 'message' && e.message?.role === 'user' && messageText(e).includes('attach-fork-seed'))).toBe(true)

        // ── 阶段 6：重附着等价 ──（faux 轨同款：空队列）
        let fx2: PiFixture | null = await spawnPiFixture({ fauxResponses: [] })
        fixture = fx2
        try {
          await fx2.sendCommand('switch_session', { sessionPath: forked.filePath }, SWITCH_TIMEOUT_MS)
          await assertPiSessionFile(fixtureStateClient(fx2), forked.filePath, 'fork-reattach')
          const state = await fx2.sendCommand('get_state')
          expect(state.data?.sessionId).toBe(forked.sessionId)
          const afterReattach = await fetchEntries(fx2)
          // 同口径等价（get_entries ↔ get_entries）：历史逐条一致（同 restore 用例，以 kill
          // 前最后 entry id 为界 deep equal，界后仅附着型追加）
          const lastKillId = beforeKill[beforeKill.length - 1]?.id
          if (typeof lastKillId !== 'string') throw new Error('beforeKill last entry has no id')
          const cutIdx = afterReattach.findIndex((e) => e.id === lastKillId)
          expect(cutIdx).toBe(beforeKill.length - 1)
          expect(afterReattach.slice(0, cutIdx + 1)).toEqual(beforeKill)
          expect(lastAssistantMessage(afterReattach)).toEqual(lastAssistantMessage(afterKill))
        } finally {
          await fx2.dispose()
          fixture = null
          fx2 = null
        }
      } finally {
        rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    },
  )

  it(
    'attach 断言行为：真实附着后错误期望必 throw（含双路径与恢复指引）；resolve 词法归一 / symlink 形态实测',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const workDir = mkdtempSync(join(tmpdir(), 'attach-equiv-assert-'))
      try {
        // 空文件（0 字节）可被 pi 附着：setSessionFile 对 size===0 文件初始化 session header
        //（pi-mono session-manager.ts:817-826 loadEntriesFromFile 空文件分支）
        const fileA = join(workDir, 'case-a.jsonl')
        writeFileSync(fileA, '')
        let fx: PiFixture | null = await spawnPiFixture({ fauxResponses: [] })
        fixture = fx
        await fx.sendCommand('switch_session', { sessionPath: fileA }, SWITCH_TIMEOUT_MS)
        const client = fixtureStateClient(fx)

        // 自洽基线：真实 switchSession(A) 后以 A 断言 → pass（双侧同源，resolve 归一后相等）
        await assertPiSessionFile(client, fileA, 'c2-self')

        // 真实附着 A 后以错误期望 B 调 helper → throw；错误信息含 A（pi 原样回报）、B、恢复指引
        const fileB = join(workDir, 'case-b.jsonl')
        const mismatch: unknown = await assertPiSessionFile(client, fileB, 'c2-mismatch').then(
          () => null,
          (e: unknown) => e,
        )
        expect(mismatch).toBeInstanceOf(Error)
        const msg = mismatch instanceof Error ? mismatch.message : String(mismatch)
        expect(msg).toContain(fileA)
        expect(msg).toContain(fileB)
        expect(msg).toContain('恢复指引')

        // resolve 词法归一实测：同文件的冗余段变体（/x/../x/...）resolve 后与 A 相等 → pass
        const dir = dirname(fileA)
        const redundant = join(dir, '..', basename(dir), basename(fileA))
        expect(resolve(redundant)).toBe(resolve(fileA))
        await assertPiSessionFile(client, redundant, 'c2-lexical-normalize')

        // /var vs /private/var 实测（macOS tmpdir 天然 /var/folders/... 形态）：pi 侧
        // resolvePath 不展开 symlink、原样回报 /var 形态；以 realpath（/private/var 形态）
        // 作期望 → resolve 归一后仍不等 → throw（symlink 视角分裂就是要 fail loud 的路径
        // 管理分裂，不误归一）。非 macOS（无此 symlink 形态差异）跳过本断言。
        const realPath = realpathSync(fileA)
        if (realPath !== fileA) {
          await expect(assertPiSessionFile(client, realPath, 'c2-symlink-split')).rejects.toThrow('[attach-mismatch]')
        }

        await fx.dispose()
        fixture = null
        fx = null
      } finally {
        rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    },
  )

  it(
    'I1 契约报警器：附着成功后 get_state().sessionFile 必为非空 string（pi 改字段形态时先红）',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      // 背景（W3 遗留 1）：session-attach-assert 的跳过分支 2——get_state 无 sessionFile
      // 字段时 console.warn 后跳过断言。护栏有效性依赖 pi 持续提供该字段；本用例在契约层
      // 锁定「附着成功 ⇒ sessionFile 为非空 string」，未来 pi 升级改字段名/形态时此处先红，
      // 静默跳过分支的前提被拦截（护栏失效的报警器）。
      const workDir = mkdtempSync(join(tmpdir(), 'attach-equiv-contract-'))
      try {
        // 空文件可被 pi 附着并初始化 header（同第三用例的先例口径）
        const fileA = join(workDir, 'contract.jsonl')
        writeFileSync(fileA, '')
        let fx: PiFixture | null = await spawnPiFixture({ fauxResponses: [] })
        fixture = fx
        try {
          await fx.sendCommand('switch_session', { sessionPath: fileA }, SWITCH_TIMEOUT_MS)
          const state = await fx.sendCommand('get_state')
          // 断言强度刻意非 truthy：''（空串）或非 string 形态（null/undefined/对象）都要红
          const sessionFile: unknown = state.data?.sessionFile
          expect(typeof sessionFile).toBe('string')
          expect((sessionFile as string).length).toBeGreaterThan(0)
          // 附着绑定语义自证：回报路径就是附着目标（resolve 词法归一口径，同 assertPiSessionFile）
          expect(resolve(sessionFile as string)).toBe(resolve(fileA))
        } finally {
          await fx.dispose()
          fixture = null
          fx = null
        }
      } finally {
        rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    },
  )

  it(
    'restore 模型恢复（P1）：无 CLI --model 附着 → pi 从 model_change entry 恢复切换终态；带 --model 附着压过（bug 形态锁定）',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      // 背景（pi-assumption final gate V1⑤）：restoreSession 曾把全局默认 --model 拼进
      // spawn args，pi 的 CLI model 恒优先于 entry 恢复（main.js buildSessionOptions），
      // 用户切换过的模型重启重开后被静默压回默认。生产修复 = RpcClientOptions.
      // inheritSessionModel（不拼 --model）。本用例在真实 pi 上锁定两侧行为：
      // 无 CLI model 附着 → entry 终态生效；带 CLI model 附着 → CLI 压过 entry
      //（后者同时是差异归因对照：证明恢复差异源于 CLI flag 本身，而非附着其他副作用）。
      // faux 轨演员（L2.5 翻轨）：CLI 默认 = faux/faux-1（spawnPiFixture faux 通道强制），
      // 切换目标 = 同 provider 兄弟 faux/faux-1-reasoning（原真实模型 mimo-v2.5 的
      // 确定性等价演员；被测优先级语义不变）。set_model 参数 = 裸 provider + 裸 modelId
      //（broadcast-getstate.test.ts 同款口径）
      const [defProvider, defModelId] = ['faux', 'faux-1']
      const targetProvider = 'faux'
      const targetModelId = 'faux-1-reasoning'
      const workDir = mkdtempSync(join(tmpdir(), 'attach-equiv-model-'))
      try {
        // ── 阶段 1：默认模型会话 + 一轮真实对话（session 落盘）+ set_model 切换 ──
        let targetFile: string | undefined
        let fx1: PiFixture | null = await spawnPiFixture({ fauxResponses: [{ text: 'model-seed' }] })
        fixture = fx1
        try {
          await fx1.runTurn({ message: 'Reply with exactly the word: model-seed' }, TURN_TIMEOUT_MS)
          await fx1.sendCommand('set_model', { provider: targetProvider, modelId: targetModelId })
          const state1 = await fx1.sendCommand('get_state')
          const model1 = state1.data?.model as { provider?: string; id?: string } | undefined
          expect(model1?.provider).toBe(targetProvider)
          expect(model1?.id).toBe(targetModelId)
          const srcFile = state1.data?.sessionFile
          if (typeof srcFile !== 'string') throw new Error('get_state.sessionFile missing after set_model')
          // model_change 原生 entry 已落盘（W1a：pi setModel 自写；附着恢复的数据源）
          const changeEntries = readSessionEntries(srcFile).filter((e) => e.type === 'model_change')
          expect(changeEntries.length).toBeGreaterThanOrEqual(1)
          expect(JSON.stringify(changeEntries)).toContain(targetModelId)
          // 复制到 workDir + cwd 归一（seedSessionFile 同款：fixture sessionDir 即将被删）
          targetFile = join(workDir, 'model-restore-session.jsonl')
          writeFileSync(targetFile, applyHeaderCwdFallback(readFileSync(srcFile, 'utf-8'), workDir))
        } finally {
          await fx1.dispose()
          fixture = null
          fx1 = null
        }

        // ── 阶段 2：无 CLI --model 附着（= P1 修复后的生产 spawn 形态）→ entry 终态恢复 ──
        // （faux 轨 model:null = 不拼 --model——空 agentDir 下 pi 以 model=unknown 占位
        // 冷启动，附着后由 model_change entry 恢复真值；全程无 LLM turn，队列空）
        let fx2: PiFixture | null = await spawnPiFixture({ model: null, fauxResponses: [] })
        fixture = fx2
        try {
          await fx2.sendCommand('switch_session', { sessionPath: targetFile! }, SWITCH_TIMEOUT_MS)
          const state2 = await fx2.sendCommand('get_state')
          const model2 = state2.data?.model as { provider?: string; id?: string } | undefined
          expect(model2?.provider).toBe(targetProvider)
          expect(model2?.id).toBe(targetModelId)
        } finally {
          await fx2.dispose()
          fixture = null
          fx2 = null
        }

        // ── 阶段 3：对照（bug 形态锁定）——带 CLI --model 附着同一文件 → CLI 压过 entry ──
        // pi 优先级语义的行为级锚：未来 pi 改变「CLI model 恒优先」语义时此处先红，
        // 提示重验 inheritSessionModel 的前提。faux 轨默认 CLI model = faux/faux-1。
        let fx3: PiFixture | null = await spawnPiFixture({ fauxResponses: [] })
        fixture = fx3
        try {
          await fx3.sendCommand('switch_session', { sessionPath: targetFile! }, SWITCH_TIMEOUT_MS)
          const state3 = await fx3.sendCommand('get_state')
          const model3 = state3.data?.model as { provider?: string; id?: string } | undefined
          expect(model3?.provider).toBe(defProvider)
          expect(model3?.id).toBe(defModelId)
        } finally {
          await fx3.dispose()
          fixture = null
          fx3 = null
        }
      } finally {
        rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    },
  )
})
