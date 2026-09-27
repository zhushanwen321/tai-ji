/**
 * P-1 行为锚（探针 P-1 结论固化）：pi `buildContextEntries` 消费 `compaction.firstKeptEntryId`
 * 切上下文的行为断言 + U4 converter 级用例（D2 合并产物 / ⛔ 悬空门 / 三级锚 / 1:N 合并 /
 * 孤儿二分 / summary.body 缺失退化 / 真实形态锚）。
 * 来源注记：自 runtime test/zcode-compaction-firstkept.test.ts 移植（git 可追溯）——
 * P-1 锚用例零改动；U4 用例语义零改动，产物构造适配本包 canonical 契约
 * （convertZcodeTranscript 产 Entry[]，序列化后逐行断言）；「真实形态回放锚」describe
 * 原经 runtime 消费链（mapSessionEntries → convertPiHistory）重放，本包不跨包 import
 * runtime（会成环，先例见 converter.test 头注），改产物 entries 级断言——runtime 消费链
 * 侧重放覆盖保留在 runtime 侧测试。pi dist 定位 = 包内轻量实现（pi-reader-invariant.test
 * 同款，注释见其头注）。
 *
 * P-1 权威源 = @earendil-works/pi-coding-agent 0.84.4 实装 dist/core/session-manager.js
 * （`npm ls` 口径见 AGENTS.md「pi 语义断言的权威源 = node_modules 实装版」）。实装语义
 * （d.ts 签名 `buildContextEntries(entries, leafId?, byId?): SessionEntry[]`）：
 *   - path = leafId（缺省取末条 entry）沿 parentId 链回溯到根的线性路径；
 *   - path 内取**最后一条** compaction entry 为压缩点；
 *   - context = [compaction] + path 中「firstKeptEntryId 首次命中处 .. 压缩点之前」
 *     + 压缩点之后的全部 entry；
 *   - firstKeptEntryId 在压缩点之前无命中（悬空 id / 空串 / 字段物理缺失）→
 *     压缩点之前的 entry **全部静默丢弃**（无告警）。
 * 设计文档 §6-D2 / §7.5-P-1 据此裁决：任何情况不发射悬空 firstKeptEntryId（⛔ 拒发门），
 * 不可解时走三级降级路径。本文件把上述行为固化为断言，pi 升级若改变切片语义即红。
 *
 * 实装加载：动态 import dist JS；dist 不可达 = 语义权威缺失，硬失败而非 skipIf——
 * skip 会让锚静默失效。纯内存构造，零 fs 写（不触真实数据目录）。
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { serializeSession } from '@zhushanwen/session-core'

import {
  convertZcodeTranscript,
  resolveFirstKeptEntryId,
  type ZcodeMessageInput,
  type ZcodeSessionInput,
} from '../converter.ts'

/** 包内轻量版 cwd 上溯定位（机制与用途见 pi-reader-invariant.test 同名函数注释）。 */
function locatePiCodingAgentDist(): string | null {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist')
    if (existsSync(join(candidate, 'config.js'))) return candidate
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return null
}

const PI_DIST = locatePiCodingAgentDist()
if (!PI_DIST) {
  throw new Error(
    'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）：' +
      '行为锚的语义权威缺失，不 skip、直接红。先 `pnpm install` 或核对 pi 版本。',
  )
}

/** pi SessionEntry 的树形状最小结构（本地声明——本包不声明 pi 依赖，仅消费 dist 运行时）。 */
interface PiEntryShape {
  type: string
  id: string
  parentId: string | null
}

/** d.ts 精确签名（dist/core/session-manager.d.ts buildContextEntries）。 */
type BuildContextEntries = (
  entries: PiEntryShape[],
  leafId?: string | null,
  byId?: Map<string, PiEntryShape>,
) => PiEntryShape[]

const { buildContextEntries } = (await import(
  pathToFileURL(join(PI_DIST, 'core', 'session-manager.js')).href
)) as { buildContextEntries: BuildContextEntries }

// ── P-1 行为锚：pi buildContextEntries 消费 compaction.firstKeptEntryId ─────────────

const TS = '2026-01-01T00:00:00.000Z'
const SUMMARY_TEXT = 'This session is being continued from a previous conversation…'

function msgEntry(id: string, parentId: string | null): PiEntryShape & Record<string, unknown> {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: TS,
    message: { role: 'user', content: `content of ${id}`, timestamp: 0 },
  }
}

/**
 * compaction entry 构造。`firstKeptEntryId` 缺省时**字段物理缺失**——pi 运行时不做
 * schema 校验（dist JS 直读属性），「缺省」负例无法用满足 compaction 形态声明的
 * 字面量表达，经草稿类型收窄后单点断言补齐（只此一处，不给 any 开口子）。
 */
function compactionEntry(parentId: string, firstKeptEntryId?: string): PiEntryShape {
  const draft: PiEntryShape & Record<string, unknown> & { firstKeptEntryId?: string } = {
    type: 'compaction',
    id: 'c',
    parentId,
    timestamp: TS,
    summary: SUMMARY_TEXT,
    tokensBefore: 10000,
  }
  if (firstKeptEntryId !== undefined) draft.firstKeptEntryId = firstKeptEntryId
  return draft
}

/** 线性链 m1→m2→m3→c→m4；压缩点 c 挂在 m3 之后，firstKeptEntryId 由用例注入。 */
function buildSession(firstKeptEntryId?: string): PiEntryShape[] {
  const m1 = msgEntry('m1', null)
  const m2 = msgEntry('m2', m1.id)
  const m3 = msgEntry('m3', m2.id)
  const c = compactionEntry(m3.id, firstKeptEntryId)
  const m4 = msgEntry('m4', c.id)
  return [m1, m2, m3, c, m4]
}

function ids(entries: PiEntryShape[]): string[] {
  return entries.map((entry) => entry.id)
}

describe('P-1 行为锚：pi buildContextEntries 消费 compaction.firstKeptEntryId（pi 0.84.4 实装）', () => {
  it('合法锚（指向压缩点之前的 entry）→ 上下文 = [compaction, 锚起…压缩点前全部, 压缩点后全部]', () => {
    const context = buildContextEntries(buildSession('m2'))
    expect(ids(context)).toEqual(['c', 'm2', 'm3', 'm4'])
  })

  it('锚指向紧邻压缩点的前驱 → 压缩点之前仅保留该前驱', () => {
    const context = buildContextEntries(buildSession('m3'))
    expect(ids(context)).toEqual(['c', 'm3', 'm4'])
  })

  it('compaction entry 是上下文首元素（摘要先行）', () => {
    const context = buildContextEntries(buildSession('m2'))
    expect(context[0]?.type).toBe('compaction')
    expect(context[0]?.id).toBe('c')
  })

  it('悬空锚（指向不存在的 entry）→ 压缩点之前 entry 全部静默丢弃', () => {
    const context = buildContextEntries(buildSession('dangling-id'))
    expect(ids(context)).toEqual(['c', 'm4'])
  })

  it('空串锚 → 同悬空（压缩点之前全部丢弃）', () => {
    const context = buildContextEntries(buildSession(''))
    expect(ids(context)).toEqual(['c', 'm4'])
  })

  it('字段缺省（firstKeptEntryId 物理缺失）→ 同悬空（压缩点之前全部丢弃）', () => {
    const context = buildContextEntries(buildSession(undefined))
    expect(ids(context)).toEqual(['c', 'm4'])
  })

  it('无 compaction entry → 完整路径原样返回', () => {
    const m1 = msgEntry('m1', null)
    const m2 = msgEntry('m2', m1.id)
    const m3 = msgEntry('m3', m2.id)
    expect(ids(buildContextEntries([m1, m2, m3]))).toEqual(['m1', 'm2', 'm3'])
  })
})

// ── U4 converter 级用例：D2 compaction 合并 + firstKept 三级锚 + 孤儿二分 ─────────────
// 规格源 = 设计 §6-D2（v2.3）+ U0 考古报告。
// fixture 形态对齐考古 §6 联合分区 8 组合：指针 part 宿主 = timeline_event / 无 semantics
//（不是 compact_summary——误用 kind 前置会误判 479 条指针）；指针目标 = compact_summary（312）
// 或 legacy 无 semantics user 消息（167，仅 data.summary 字段）。

const U4_SESSION: ZcodeSessionInput = {
  id: 'sess_0198test-0000-0000-0000-0000000000f4',
  title: 'T',
  timeCreated: Date.parse('2026-01-02T03:04:05.000Z'),
}

/** §4.2 值域闭集成员（U4 fixture 共用 semantics 形态）。 */
const U4_TIMELINE_SEMANTICS = {
  kind: 'timeline_event',
  origin: 'system',
  uiVisibility: 'hidden',
  transcriptVisibility: 'hidden',
}
const U4_COMPACT_SUMMARY_SEMANTICS = {
  kind: 'compact_summary',
  origin: 'system',
  uiVisibility: 'hidden',
  transcriptVisibility: 'hidden',
}
const U4_REAL_USER_SEMANTICS = {
  kind: 'user_prompt',
  origin: 'real_user',
  uiVisibility: 'visible',
  transcriptVisibility: 'visible',
}

function zUser(
  id: string,
  parts: Array<Record<string, unknown>>,
  dataExtra: Record<string, unknown> = {},
  createdMs = 1000,
): ZcodeMessageInput {
  return { id, data: { role: 'user', time: { created: createdMs }, ...dataExtra }, parts }
}

function zText(text: string, startMs?: number): Record<string, unknown> {
  return { type: 'text', text, ...(startMs !== undefined && { time: { start: startMs, end: startMs } }) }
}

function zCompaction(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'compaction', auto: false, trigger: 'manual', ...fields }
}

interface U4Entry {
  type: string
  id: string
  parentId: string | null
  timestamp?: string
  message?: { role?: string; content?: unknown; [key: string]: unknown }
  summary?: string
  firstKeptEntryId?: string
  tokensBefore?: number
  details?: Record<string, unknown>
  customType?: string
  data?: unknown
  [key: string]: unknown
}

/** converter 产物 → JSONL 行（serializeSession 基座字节契约，converter.test toLines 同款）。 */
function u4Lines(session: ReturnType<typeof convertZcodeTranscript>): U4Entry[] {
  return serializeSession(session.entries)
    .trimEnd()
    .split('\n')
    .map((l) => JSON.parse(l) as U4Entry)
}

function u4CompactionEntries(entries: U4Entry[]): U4Entry[] {
  return entries.filter((e) => e.type === 'compaction')
}

describe('U4 converter：D2 合并产出（summary/tokensBefore/details/锚 各字段来源）', () => {
  // 指针形态（考古 §6 现行指针行）：宿主 timeline_event（丢弃类）+ part 带 summaryMessageId/
  // tail_start_id/preCompactTokenCount；目标是 legacy 无 semantics 摘要消息（data.summary）
  const pointerPart = zCompaction({
    summaryMessageId: 'c-summary',
    tail_start_id: 'u-real',
    preCompactTokenCount: 123000,
    time: { start: 1500, end: 1600 },
  })
  const session = convertZcodeTranscript(
    [
      zUser('u-real', [zText('真话')]),
      zUser('m-pointer', [pointerPart], { semantics: U4_TIMELINE_SEMANTICS }, 1400),
      zUser('c-summary', [zText('摘要正文 text part')], { summary: { body: '摘要正文 from data.summary.body' } }, 2000),
    ],
    U4_SESSION,
  )
  const entries = u4Lines(session)
  const compactions = u4CompactionEntries(entries)

  it('宿主与关联 part 合并为单条 compaction entry，落在摘要消息位次；宿主消息零 entry', () => {
    // u-real（entry 2）→ m-pointer（timelineOnly 丢弃，零 entry）→ c-summary 位次发 compaction（entry 3）
    expect(entries.map((e) => e.type)).toEqual(['session_info', 'message', 'compaction'])
    expect(compactions).toHaveLength(1)
  })

  it('字段来源：summary←data.summary.body / tokensBefore←part / details←part 原样 / 锚←tail_start_id 映射', () => {
    const c = compactions[0] as U4Entry
    expect(c.summary).toBe('摘要正文 from data.summary.body')
    expect(c.tokensBefore).toBe(123000)
    expect(c.details).toEqual(pointerPart)
    // ① 级锚：tail_start_id 'u-real' 经映射表解析 = u-real 的 user entry id（session_info 占 00000001）
    expect(c.firstKeptEntryId).toBe('00000002')
    // 时间锚：part time.start 优先于消息 time.created（1500 < 2000）
    expect(c.timestamp).toBe(new Date(1500).toISOString())
    expect(c.parentId).toBe('00000002') // 接入现有 entry 链
  })

  it('摘要宿主的 text part 被合并消费（不再冒充用户气泡——失败模式 C 消除）；无 custom 无断链', () => {
    const userTexts = entries
      .filter((e) => e.message?.role === 'user')
      .flatMap((e) => ((e.message?.content as Array<{ text?: string }>) ?? []).map((c) => c.text ?? ''))
    expect(userTexts).toEqual(['真话']) // 摘要正文不在 user entry
    expect(entries.some((e) => e.type === 'custom')).toBe(false)
    // 唯一降级 = 指针宿主（timeline_event 丢弃类）自身的 L2 聚合登记，无 compaction_unlinked
    expect(session.degradations).toEqual([{ code: 'dropped_transient', kind: 'timeline_event', count: 1 }])
  })

  it('compaction entry 登记进 messageId→entryId 映射表：后续锚指向摘要消息时解析到该 entry', () => {
    // 第二次压缩的 tail_start_id 指向第一条摘要消息 c-summary——应解析到其 compaction entry id
    const session2 = convertZcodeTranscript(
      [
        zUser('u-real', [zText('真话')]),
        zUser('m1', [zCompaction({ summaryMessageId: 'c1', tail_start_id: 'u-real' })], { semantics: U4_TIMELINE_SEMANTICS }),
        zUser('c1', [], { summary: { body: '第一次摘要' } }, 2000),
        zUser('m2', [zCompaction({ summaryMessageId: 'c2', tail_start_id: 'c1' })], { semantics: U4_TIMELINE_SEMANTICS }, 3000),
        zUser('c2', [], { summary: { body: '第二次摘要' } }, 4000),
      ],
      U4_SESSION,
    )
    const es = u4Lines(session2)
    const cs = u4CompactionEntries(es)
    expect(cs).toHaveLength(2)
    expect((cs[1] as U4Entry).firstKeptEntryId).toBe((cs[0] as U4Entry).id)
  })
})

describe('U4 converter：⛔ 悬空门（任何情况不发射悬空 firstKeptEntryId）', () => {
  // 变异的 tail_start_id 必须落在「联合序最早的关联 part」上——1:N 锚取最早 part，锚取错
  // part 会让断言因错误原因通过。fixture：u-real(2) → u-dropped(丢弃类零 entry) → m-ptr(丢弃类
  // 零 entry，其 part 是唯一关联 part 即锚) → c 发 compaction(3)，紧邻前驱 = 00000002。
  function fixtureWithTail(tailId: string | undefined): ReturnType<typeof convertZcodeTranscript> {
    return convertZcodeTranscript(
      [
        zUser('u-real', [zText('真话')]),
        zUser('u-dropped', [zText('丢弃类')], { semantics: U4_TIMELINE_SEMANTICS }, 1300),
        zUser(
          'm-ptr',
          [zCompaction({ summaryMessageId: 'c', ...(tailId !== undefined && { tail_start_id: tailId }) })],
          { semantics: U4_TIMELINE_SEMANTICS },
          1200,
        ),
        zUser('c', [zText('摘要正文')], { summary: { body: '摘要' } }, 2000),
      ],
      U4_SESSION,
    )
  }

  it('负例（验收④）：tail_start_id 无映射（幽灵 id）→ 走 ② 级紧邻前驱，firstKeptEntryId 非空且合法', () => {
    const entries = u4Lines(fixtureWithTail('m-ghost'))
    const c = u4CompactionEntries(entries)[0] as U4Entry
    // entries：session_info(1) → u-real(2) → compaction(3)；紧邻前驱 = 00000002
    expect(c.firstKeptEntryId).toBe('00000002')
    expect(c.firstKeptEntryId).not.toBe('m-ghost')
    expect(String(c.firstKeptEntryId).length).toBeGreaterThan(0)
  })

  it('tail 目标在行集内但被分类器丢弃（永不发射 → 映射表无键）→ 同走 ② 级紧邻前驱', () => {
    const entries = u4Lines(fixtureWithTail('u-dropped'))
    const c = u4CompactionEntries(entries)[0] as U4Entry
    expect(c.firstKeptEntryId).toBe('00000002')
  })

  it('② 级集成用例：part 无 tail_start_id（legacy 形态）→ 紧邻前驱', () => {
    const entries = u4Lines(fixtureWithTail(undefined))
    const c = u4CompactionEntries(entries)[0] as U4Entry
    expect(c.firstKeptEntryId).toBe('00000002')
  })

  it('③ 级锚（无前驱 → 自身 id）纯函数真值表——集成路径 session_info 恒先发，② 恒可用，③ 为规格完备防御', () => {
    expect(resolveFirstKeptEntryId('mapped-entry', 'prev-entry', 'own-id')).toBe('mapped-entry')
    expect(resolveFirstKeptEntryId(undefined, 'prev-entry', 'own-id')).toBe('prev-entry')
    expect(resolveFirstKeptEntryId(undefined, null, 'own-id')).toBe('own-id')
  })
})

describe('U4 converter：1:N 合并（联合序最早锚 + 防双发）', () => {
  const partA = zCompaction({ summaryMessageId: 'c', tail_start_id: 'u1', preCompactTokenCount: 100000 })
  const partB = zCompaction({ summaryMessageId: 'c', tail_start_id: 'u2', preCompactTokenCount: 200000 })
  const session = convertZcodeTranscript(
    [
      zUser('u1', [zText('第一段')]),
      zUser('m1', [partA], { semantics: U4_TIMELINE_SEMANTICS }, 1200),
      zUser('u2', [zText('第二段')], {}, 2000),
      zUser('m2', [partB], { semantics: U4_TIMELINE_SEMANTICS }, 2200),
      zUser('c', [], { summary: { body: '共用摘要' } }, 3000),
    ],
    U4_SESSION,
  )
  const entries = u4Lines(session)

  it('两条关联 part → 单条 compaction entry；锚/tokensBefore/details 取联合序最早 part', () => {
    // entries：session_info(1) → u1(2) → u2(3) → compaction(4)；两个指针宿主均 timelineOnly 零 entry
    expect(entries.map((e) => e.type)).toEqual(['session_info', 'message', 'message', 'compaction'])
    const c = u4CompactionEntries(entries)[0] as U4Entry
    expect(c.tokensBefore).toBe(100000) // partA（最早），不是 partB 的 200000
    expect(c.details).toEqual(partA)
    expect(c.firstKeptEntryId).toBe('00000002') // partA.tail u1 的 entry，不是 partB.tail u2 的 00000003
  })

  it('关联 part 不再发 custom entry（防双发）；降级仅两个指针宿主自身的 L2 聚合（同维度 count=2）', () => {
    expect(entries.some((e) => e.type === 'custom')).toBe(false)
    expect(session.degradations).toEqual([{ code: 'dropped_transient', kind: 'timeline_event', count: 2 }])
  })
})

describe('U4 converter：孤儿二分（正常孤儿不计降级 / 悬空指针计 compaction_unlinked）', () => {
  it('正常孤儿（无 summaryMessageId、宿主有 entry）：维持现状 custom 通道，零降级', () => {
    // timelineStatus 在 part 顶层（考古 §2 磁盘形态）——判据③ 的并集检查不误关联，宿主照常产 entry
    const orphanPart = zCompaction({ timelineStatus: 'completed', preCompactTokenCount: 5000 })
    const session = convertZcodeTranscript([zUser('o-host', [zText('问题'), orphanPart])], U4_SESSION)
    const entries = u4Lines(session)
    expect(entries.map((e) => e.type)).toEqual(['session_info', 'custom', 'message'])
    expect(entries[1]).toMatchObject({ customType: 'zcode-import:compaction', data: orphanPart })
    expect(session.degradations).toEqual([])
  })

  it('悬空指针（summaryMessageId 指向不在行集的消息）：custom entry + compaction_unlinked 降级', () => {
    const session = convertZcodeTranscript(
      [zUser('d-host', [zCompaction({ summaryMessageId: 'm-nowhere' })], { semantics: U4_REAL_USER_SEMANTICS })],
      U4_SESSION,
    )
    const entries = u4Lines(session)
    expect(entries.some((e) => e.type === 'compaction')).toBe(false) // 不发射 compaction entry（防悬空锚）
    expect(entries[1]).toMatchObject({ type: 'custom', customType: 'zcode-import:compaction' })
    expect(session.degradations).toEqual([{ code: 'compaction_unlinked', kind: 'user_prompt', count: 1 }])
  })

  it('合并宿主 × 悬空指针（compactSummary + body 可用，宿主自带悬空 part）：compaction entry（②级锚）+ 悬空 part custom entry + 降级 三者齐备', () => {
    // 宿主 summary.body 可用 → 走合并路径；其自带 part 携带悬空 summaryMessageId（判据①
    // 指向不在行集）→ 处置 dangling，不参与合并（不登记 linkedParts）——合并 entry 锚退
    // ② 级紧邻前驱；悬空 part 本体补发现状 custom entry（孤儿② 语义与指针宿主路径一致）
    const danglingPart = zCompaction({ summaryMessageId: 'm-nowhere', time: { start: 2600, end: 2700 } })
    const session = convertZcodeTranscript(
      [
        zUser('u-real', [zText('真话')]),
        zUser(
          'c-host',
          [danglingPart, zText('摘要正文（随合并被消费）')],
          { semantics: U4_COMPACT_SUMMARY_SEMANTICS, summary: { body: '宿主摘要' } },
          2500,
        ),
      ],
      U4_SESSION,
    )
    const entries = u4Lines(session)
    // 三产物①：compaction entry（摘要宿主合并照常发射，落在宿主位次）
    expect(entries.map((e) => e.type)).toEqual(['session_info', 'message', 'compaction', 'custom'])
    const compaction = u4CompactionEntries(entries)[0] as U4Entry
    expect(compaction.summary).toBe('宿主摘要')
    // ② 级锚：悬空 part 不登记合并 → 无锚 part → tail 解析不到 → 紧邻前驱 = u-real 的 entry
    expect(compaction.firstKeptEntryId).toBe('00000002')
    expect(new Set(entries.map((e) => e.id)).has(compaction.firstKeptEntryId as string)).toBe(true)
    // 三产物②：悬空 part 的现状 custom entry（边界元数据原样透传，不吞）
    expect(entries[3]).toMatchObject({
      type: 'custom',
      customType: 'zcode-import:compaction',
      data: danglingPart,
      timestamp: new Date(2600).toISOString(),
    })
    // 三产物③：compaction_unlinked 降级登记（L3，宿主 kind 注解）不吞
    expect(session.degradations).toEqual([{ code: 'compaction_unlinked', kind: 'compact_summary', count: 1 }])
    // 宿主 text part 随合并被消费：无 user entry 承载摘要正文
    const userTexts = entries
      .filter((e) => e.message?.role === 'user')
      .flatMap((e) => ((e.message?.content as Array<{ text?: string }>) ?? []).map((c) => c.text ?? ''))
    expect(userTexts).toEqual(['真话'])
  })

  it('正常孤儿宿主被丢弃时随宿主消失（零 entry；登记仅宿主自身 L2 丢弃，无 compaction_unlinked）', () => {
    const session = convertZcodeTranscript(
      [zUser('o-dropped', [zCompaction({ timelineStatus: 'completed' })], { semantics: U4_TIMELINE_SEMANTICS })],
      U4_SESSION,
    )
    const entries = u4Lines(session)
    expect(entries).toHaveLength(1) // 仅 session_info
    expect(session.degradations).toEqual([{ code: 'dropped_transient', kind: 'timeline_event', count: 1 }])
  })
})

describe('U4 converter：summary.body 缺失退化（不伪造，P-4 降级路径）', () => {
  // compact_summary kind 但无 data.summary——宿主不可合并：宿主 part 不登记合并、走现状通道
  const session = convertZcodeTranscript(
    [
      zUser('u1', [zText('问')]),
      zUser(
        'c-no-body',
        [zText('正文在 text part'), zCompaction({ preCompactTokenCount: 80000 })],
        { semantics: U4_COMPACT_SUMMARY_SEMANTICS },
        2000,
      ),
    ],
    U4_SESSION,
  )
  const entries = u4Lines(session)

  it('无 compaction entry；退化为现状形态（user entry + compaction part custom entry）', () => {
    expect(entries.map((e) => e.type)).toEqual(['session_info', 'message', 'custom', 'message'])
    expect(entries.some((e) => e.type === 'compaction')).toBe(false)
    // 现状 user entry：text part 保留（摘要内容不丢）
    expect((entries[3] as U4Entry).message?.content).toEqual([{ type: 'text', text: '正文在 text part' }])
    expect(entries[2]).toMatchObject({ customType: 'zcode-import:compaction', data: { preCompactTokenCount: 80000 } })
  })

  it('计 compaction_unlinked 降级（L3，宿主 kind 注解）', () => {
    expect(session.degradations).toEqual([{ code: 'compaction_unlinked', kind: 'compact_summary', count: 1 }])
  })
})

describe('U4 converter：真实形态锚（考古 §6 联合分区形态 → D2 全规格产物）', () => {
  // 形态清单（考古 §9.4）：legacy 指针（无 semantics 宿主）→ 合并；现代指针（timeline_event 宿主）
  // → 合并；compact_summary 本体 ②形态（[compaction+text] 双 part）→ 合并；孤儿（无 semantics
  // 宿主 + 顶层 timelineStatus）→ custom；全程零 unclassified。
  // 迁移适配：原 runtime 版经 mapSessionEntries → convertPiHistory 消费链重放（compaction
  // 折成 system 消息）——本包不跨包 import runtime（成环），改产物 entries 级断言；
  // runtime 消费链重放覆盖保留在 runtime 侧测试。
  const legacyPointerPart = zCompaction({ summaryMessageId: 'c1', tail_start_id: 'u1' })
  const c2HostedPart = zCompaction({
    tail_start_id: 'a1',
    preCompactTokenCount: 4321,
    timelineStatus: 'completed',
    time: { start: 6500, end: 6600 },
  })
  const session = convertZcodeTranscript(
    [
      zUser('u1', [zText('真话')]),
      zUser('m-legacy', [legacyPointerPart], {}, 1200), // 无 semantics + summaryMessageId → 分类器 timelineOnly（兜底链）
      zUser('c1', [zText('c1 正文')], { summary: { body: 'legacy 摘要（无 semantics 仅 data.summary）' } }, 2000),
      {
        id: 'a1',
        data: { role: 'assistant', time: { created: 3000, completed: 3500 } },
        parts: [{ type: 'step-start' }, zText('干活', 3100), { type: 'step-finish', reason: 'stop' }],
      },
      // 现代指针指向 c1（1:N：指针 part 晚于 legacy 指针 part → 锚仍取 legacy 指针的 tail u1）
      zUser('m-modern', [zCompaction({ summaryMessageId: 'c1', tail_start_id: 'a1' })], { semantics: U4_TIMELINE_SEMANTICS }, 5000),
      // 纯 ② 形态（考古 §7）：宿主自带 [compaction+text] 双 part、无外部指针、data.summary.body
      // 与 text part 双全（P-4：312/312 宿主 body 齐备）——锚 = 宿主 part（携带 tail 与 tokens）
      zUser('c2', [c2HostedPart, zText('c2 正文')], { semantics: U4_COMPACT_SUMMARY_SEMANTICS, summary: { body: '现代摘要' } }, 6000),
      zUser('o-host', [zText('还在'), zCompaction({ timelineStatus: 'completed' })], {}, 7000),
    ],
    U4_SESSION,
  )
  const entries = u4Lines(session)

  it('D2 合并产物：2 条 compaction entry + 消息/孤儿落位（指针宿主零 entry）', () => {
    // u1(2) → m-legacy 丢弃 → c1 合并 compaction(3) → a1(4) → m-modern 丢弃 → c2 合并 compaction(5)
    // → o-host 的孤儿 compaction part 走 custom(6) + text 走 message(7)
    expect(entries.map((e) => e.type)).toEqual([
      'session_info', 'message', 'compaction', 'message', 'compaction', 'custom', 'message',
    ])
    const compactions = u4CompactionEntries(entries)
    expect(compactions.map((c) => (c as U4Entry).summary)).toEqual([
      'legacy 摘要（无 semantics 仅 data.summary）',
      '现代摘要',
    ])
  })

  it('⛔ 全局拒发门：每条 compaction entry 的 firstKeptEntryId 都指向产物内真实 entry（零悬空）', () => {
    const entryIds = new Set(entries.map((e) => e.id))
    const compactions = u4CompactionEntries(entries) as U4Entry[]
    expect(compactions).toHaveLength(2)
    expect(compactions[0]?.summary).toBe('legacy 摘要（无 semantics 仅 data.summary）')
    expect(compactions[0]?.firstKeptEntryId).toBe('00000002') // u1 的 entry（legacy 指针 ① 级锚命中）
    // 现代本体 ②形态：tokensBefore ← preCompactTokenCount；锚 ← tail a1 的 entry
    expect(compactions[1]?.tokensBefore).toBe(4321)
    expect(compactions[1]?.firstKeptEntryId).toBe('00000004')
    for (const c of compactions) {
      expect(entryIds.has(c.firstKeptEntryId as string), `firstKeptEntryId ${c.firstKeptEntryId} 悬空`).toBe(true)
    }
  })

  it('legacy 指针合并缺 preCompactTokenCount（考古 §2：指针形态不携带该字段）→ tokensBefore 键缺省不写 0', () => {
    const compactions = u4CompactionEntries(entries) as U4Entry[]
    expect(compactions[0]).not.toHaveProperty('tokensBefore')
    expect(compactions[1]).toHaveProperty('tokensBefore', 4321)
  })

  it('孤儿保留 custom 通道（恰 1 条 zcode-import:compaction）；合并宿主 text part 不再出现', () => {
    const customs = entries.filter((e) => e.type === 'custom')
    expect(customs).toHaveLength(1)
    expect((customs[0] as U4Entry).customType).toBe('zcode-import:compaction')
    // user content 文本归属：合并宿主摘要正文不冒充用户气泡
    const userTexts = entries
      .filter((e) => e.message?.role === 'user')
      .flatMap((e) => ((e.message?.content as Array<{ text?: string }>) ?? []).map((c) => c.text ?? ''))
      .join('|')
    expect(userTexts).toContain('真话')
    expect(userTexts).toContain('还在')
    expect(userTexts).not.toContain('c1 正文')
    expect(userTexts).not.toContain('c2 正文')
    // 降级 = 两个指针宿主自身的 L2 丢弃聚合（legacy 宿主无 kind → 键缺省；现代宿主 kind=timeline_event），
    // 无 compaction_unlinked、无 unclassified
    expect(session.degradations).toEqual([
      { code: 'dropped_transient', count: 1 },
      { code: 'dropped_transient', kind: 'timeline_event', count: 1 },
    ])
  })
})
