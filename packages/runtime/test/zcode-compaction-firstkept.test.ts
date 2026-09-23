/**
 * P-1 行为锚（探针 P-1 结论固化，impl-plan §2-U0 ②）：pi `buildContextEntries`
 * 消费 `compaction.firstKeptEntryId` 切上下文的行为断言。
 *
 * 权威源 = @earendil-works/pi-coding-agent 0.84.4 实装 dist/core/session-manager.js
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
 * 职责边界：P-1 锚段（pi buildContextEntries 行为）+ U4 converter 级用例（D2 合并产物 /
 * ⛔ 悬空门拒发 / 三级降级逐级 / 1:N 合并 / 孤儿二分 / summary.body 缺失退化 / 真实形态
 * 回放锚）——converter 级用例锚定 zcode-import/converter.ts 的 D2 落地行为。
 *
 * 实装加载：经 locatePiCodingAgentDist 动态 import dist JS（pi-semantics 探针族先例，
 * 运行时不经 runtime 包声明依赖面）。与探针族的差异：本文件是行为锚而非登记探针，
 * dist 不可达 = 语义权威缺失，硬失败而非 skipIf——skip 会让锚静默失效。
 *
 * 运行：cd packages/runtime && pnpm test -- zcode-compaction-firstkept
 * 纯内存构造，零 fs 写（不触真实数据目录）。
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { Message } from '@taiji/shared'
import type {
  CompactionEntry,
  SessionEntry,
  SessionMessageEntry,
} from '@earendil-works/pi-coding-agent'
import type { PiHistoryToolResult, PiSessionEntry } from '../src/infra/pi/pi-protocol.js'
import { convertPiHistory } from '../src/infra/pi/message-converter.js'
import { mapSessionEntries } from '../src/infra/pi/session-entry-mapper.js'
import {
  buildZcodeSessionFile,
  resolveFirstKeptEntryId,
  type ZcodeConversionOutput,
  type ZcodeMessageInput,
} from '../src/services/session/zcode-import/converter.js'

import { locatePiCodingAgentDist } from '../src/infra/pi/__tests__/helpers/pi-semantics-probe'

const PI_DIST = locatePiCodingAgentDist()
if (!PI_DIST) {
  throw new Error(
    'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）：' +
      '行为锚的语义权威缺失，不 skip、直接红。先 `pnpm install` 或核对 pi 版本。',
  )
}

/** d.ts 精确签名（dist/core/session-manager.d.ts buildContextEntries）。 */
type BuildContextEntries = (
  entries: SessionEntry[],
  leafId?: string | null,
  byId?: Map<string, SessionEntry>,
) => SessionEntry[]

const { buildContextEntries } = (await import(
  pathToFileURL(join(PI_DIST, 'core', 'session-manager.js')).href
)) as { buildContextEntries: BuildContextEntries }

const TS = '2026-01-01T00:00:00.000Z'
const SUMMARY_TEXT = 'This session is being continued from a previous conversation…'

function msgEntry(id: string, parentId: string | null): SessionMessageEntry {
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
 * schema 校验（dist JS 直读属性），「缺省」负例无法用满足 CompactionEntry 声明的
 * 字面量表达，经草稿类型收窄后单点断言补齐（只此一处，不给 any 开口子）。
 */
function compactionEntry(parentId: string, firstKeptEntryId?: string): CompactionEntry {
  const draft: Omit<CompactionEntry, 'firstKeptEntryId'> & { firstKeptEntryId?: string } = {
    type: 'compaction',
    id: 'c',
    parentId,
    timestamp: TS,
    summary: SUMMARY_TEXT,
    tokensBefore: 10000,
  }
  if (firstKeptEntryId !== undefined) draft.firstKeptEntryId = firstKeptEntryId
  return draft as CompactionEntry
}

/** 线性链 m1→m2→m3→c→m4；压缩点 c 挂在 m3 之后，firstKeptEntryId 由用例注入。 */
function buildSession(firstKeptEntryId?: string): SessionEntry[] {
  const m1 = msgEntry('m1', null)
  const m2 = msgEntry('m2', m1.id)
  const m3 = msgEntry('m3', m2.id)
  const c = compactionEntry(m3.id, firstKeptEntryId)
  const m4 = msgEntry('m4', c.id)
  return [m1, m2, m3, c, m4]
}

function ids(entries: SessionEntry[]): string[] {
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
// 规格源 = 设计 §6-D2（v2.3）+ U0 考古报告（.tmp/dev-flow/u0-compaction-archaeology.md）。
// fixture 形态对齐考古 §6 联合分区 8 组合：指针 part 宿主 = timeline_event / 无 semantics
//（不是 compact_summary——误用 kind 前置会误判 479 条指针）；指针目标 = compact_summary（312）
// 或 legacy 无 semantics user 消息（167，仅 data.summary 字段）。

const U4_HEADER = Object.freeze({
  id: '0198test-0000-0000-0000-0000000000f4',
  timestamp: '2026-01-02T03:04:05.000Z',
  cwd: '/tmp/zc-firstkept-cwd',
})

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

function u4Parse(out: ZcodeConversionOutput): { entries: Array<Record<string, unknown>> } {
  const lines = out.content.trimEnd().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
  const [, ...entries] = lines
  return { entries }
}

function u4CompactionEntries(entries: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
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
  const msgs: ZcodeMessageInput[] = [
    zUser('u-real', [zText('真话')]),
    zUser('m-pointer', [pointerPart], { semantics: U4_TIMELINE_SEMANTICS }, 1400),
    zUser('c-summary', [zText('摘要正文 text part')], { summary: { body: '摘要正文 from data.summary.body' } }, 2000),
  ]
  const out = buildZcodeSessionFile(msgs, 'T', U4_HEADER)
  const { entries } = u4Parse(out)
  const compactions = u4CompactionEntries(entries)

  it('宿主与关联 part 合并为单条 compaction entry，落在摘要消息位次；宿主消息零 entry', () => {
    // u-real（entry 2）→ m-pointer（timelineOnly 丢弃，零 entry）→ c-summary 位次发 compaction（entry 3）
    expect(entries.map((e) => e.type)).toEqual(['session_info', 'message', 'compaction'])
    expect(compactions).toHaveLength(1)
  })

  it('字段来源：summary←data.summary.body / tokensBefore←part / details←part 原样 / 锚←tail_start_id 映射', () => {
    const c = compactions[0] as Record<string, unknown>
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
      .filter((e) => (e.message as { role?: string } | undefined)?.role === 'user')
      .flatMap((e) => ((e.message as { content: Array<{ text?: string }> }).content).map((c) => c.text ?? ''))
    expect(userTexts).toEqual(['真话']) // 摘要正文不在 user entry
    expect(entries.some((e) => e.type === 'custom')).toBe(false)
    // 唯一降级 = 指针宿主（timeline_event 丢弃类）自身的 L2 聚合登记，无 compaction_unlinked
    expect(out.degradations).toEqual([{ code: 'dropped_transient', kind: 'timeline_event', count: 1 }])
  })

  it('compaction entry 登记进 messageId→entryId 映射表：后续锚指向摘要消息时解析到该 entry', () => {
    // 第二次压缩的 tail_start_id 指向第一条摘要消息 c-summary——应解析到其 compaction entry id
    const msgs2: ZcodeMessageInput[] = [
      zUser('u-real', [zText('真话')]),
      zUser('m1', [zCompaction({ summaryMessageId: 'c1', tail_start_id: 'u-real' })], { semantics: U4_TIMELINE_SEMANTICS }),
      zUser('c1', [], { summary: { body: '第一次摘要' } }, 2000),
      zUser('m2', [zCompaction({ summaryMessageId: 'c2', tail_start_id: 'c1' })], { semantics: U4_TIMELINE_SEMANTICS }, 3000),
      zUser('c2', [], { summary: { body: '第二次摘要' } }, 4000),
    ]
    const { entries: es } = u4Parse(buildZcodeSessionFile(msgs2, 'T', U4_HEADER))
    const cs = u4CompactionEntries(es)
    expect(cs).toHaveLength(2)
    expect((cs[1] as Record<string, unknown>).firstKeptEntryId).toBe((cs[0] as Record<string, unknown>).id)
  })
})

describe('U4 converter：⛔ 悬空门（任何情况不发射悬空 firstKeptEntryId）', () => {
  // 变异的 tail_start_id 必须落在「联合序最早的关联 part」上——1:N 锚取最早 part，锚取错
  // part 会让断言因错误原因通过。fixture：u-real(2) → u-dropped(丢弃类零 entry) → m-ptr(丢弃类
  // 零 entry，其 part 是唯一关联 part 即锚) → c 发 compaction(3)，紧邻前驱 = 00000002。
  function fixtureWithTail(tailId: string | undefined): ZcodeConversionOutput {
    return buildZcodeSessionFile(
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
      'T',
      U4_HEADER,
    )
  }

  it('负例（验收④）：tail_start_id 无映射（幽灵 id）→ 走 ② 级紧邻前驱，firstKeptEntryId 非空且合法', () => {
    const { entries } = u4Parse(fixtureWithTail('m-ghost'))
    const c = u4CompactionEntries(entries)[0] as Record<string, unknown>
    // entries：session_info(1) → u-real(2) → compaction(3)；紧邻前驱 = 00000002
    expect(c.firstKeptEntryId).toBe('00000002')
    expect(c.firstKeptEntryId).not.toBe('m-ghost')
    expect(String(c.firstKeptEntryId).length).toBeGreaterThan(0)
  })

  it('tail 目标在行集内但被分类器丢弃（永不发射 → 映射表无键）→ 同走 ② 级紧邻前驱', () => {
    const { entries } = u4Parse(fixtureWithTail('u-dropped'))
    const c = u4CompactionEntries(entries)[0] as Record<string, unknown>
    expect(c.firstKeptEntryId).toBe('00000002')
  })

  it('② 级集成用例：part 无 tail_start_id（legacy 形态）→ 紧邻前驱', () => {
    const out = fixtureWithTail(undefined)
    const { entries } = u4Parse(out)
    const c = u4CompactionEntries(entries)[0] as Record<string, unknown>
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
  const msgs: ZcodeMessageInput[] = [
    zUser('u1', [zText('第一段')]),
    zUser('m1', [partA], { semantics: U4_TIMELINE_SEMANTICS }, 1200),
    zUser('u2', [zText('第二段')], {}, 2000),
    zUser('m2', [partB], { semantics: U4_TIMELINE_SEMANTICS }, 2200),
    zUser('c', [], { summary: { body: '共用摘要' } }, 3000),
  ]
  const out = buildZcodeSessionFile(msgs, 'T', U4_HEADER)
  const { entries } = u4Parse(out)

  it('两条关联 part → 单条 compaction entry；锚/tokensBefore/details 取联合序最早 part', () => {
    // entries：session_info(1) → u1(2) → u2(3) → compaction(4)；两个指针宿主均 timelineOnly 零 entry
    expect(entries.map((e) => e.type)).toEqual(['session_info', 'message', 'message', 'compaction'])
    const c = u4CompactionEntries(entries)[0] as Record<string, unknown>
    expect(c.tokensBefore).toBe(100000) // partA（最早），不是 partB 的 200000
    expect(c.details).toEqual(partA)
    expect(c.firstKeptEntryId).toBe('00000002') // partA.tail u1 的 entry，不是 partB.tail u2 的 00000003
  })

  it('关联 part 不再发 custom entry（防双发）；降级仅两个指针宿主自身的 L2 聚合（同维度 count=2）', () => {
    expect(entries.some((e) => e.type === 'custom')).toBe(false)
    expect(out.degradations).toEqual([{ code: 'dropped_transient', kind: 'timeline_event', count: 2 }])
  })
})

describe('U4 converter：孤儿二分（正常孤儿不计降级 / 悬空指针计 compaction_unlinked）', () => {
  it('正常孤儿（无 summaryMessageId、宿主有 entry）：维持现状 custom 通道，零降级', () => {
    // timelineStatus 在 part 顶层（考古 §2 磁盘形态）——判据③ 的并集检查不误关联，宿主照常产 entry
    const orphanPart = zCompaction({ timelineStatus: 'completed', preCompactTokenCount: 5000 })
    const out = buildZcodeSessionFile([zUser('o-host', [zText('问题'), orphanPart])], 'T', U4_HEADER)
    const { entries } = u4Parse(out)
    expect(entries.map((e) => e.type)).toEqual(['session_info', 'custom', 'message'])
    expect(entries[1]).toMatchObject({ customType: 'zcode-import:compaction', data: orphanPart })
    expect(out.degradations).toEqual([])
  })

  it('悬空指针（summaryMessageId 指向不在行集的消息）：custom entry + compaction_unlinked 降级', () => {
    const out = buildZcodeSessionFile(
      [zUser('d-host', [zCompaction({ summaryMessageId: 'm-nowhere' })], { semantics: U4_REAL_USER_SEMANTICS })],
      'T',
      U4_HEADER,
    )
    const { entries } = u4Parse(out)
    expect(entries.some((e) => e.type === 'compaction')).toBe(false) // 不发射 compaction entry（防悬空锚）
    expect(entries[1]).toMatchObject({ type: 'custom', customType: 'zcode-import:compaction' })
    expect(out.degradations).toEqual([{ code: 'compaction_unlinked', kind: 'user_prompt', count: 1 }])
  })

  it('合并宿主 × 悬空指针（compactSummary + body 可用，宿主自带悬空 part）：compaction entry（②级锚）+ 悬空 part custom entry + 降级 三者齐备', () => {
    // 宿主 summary.body 可用 → 走合并路径；其自带 part 携带悬空 summaryMessageId（判据①
    // 指向不在行集）→ 处置 dangling，不参与合并（不登记 linkedParts）——合并 entry 锚退
    // ② 级紧邻前驱；悬空 part 本体补发现状 custom entry（孤儿② 语义与指针宿主路径一致）
    const danglingPart = zCompaction({ summaryMessageId: 'm-nowhere', time: { start: 2600, end: 2700 } })
    const out = buildZcodeSessionFile(
      [
        zUser('u-real', [zText('真话')]),
        zUser(
          'c-host',
          [danglingPart, zText('摘要正文（随合并被消费）')],
          { semantics: U4_COMPACT_SUMMARY_SEMANTICS, summary: { body: '宿主摘要' } },
          2500,
        ),
      ],
      'T',
      U4_HEADER,
    )
    const { entries } = u4Parse(out)
    // 三产物①：compaction entry（摘要宿主合并照常发射，落在宿主位次）
    expect(entries.map((e) => e.type)).toEqual(['session_info', 'message', 'compaction', 'custom'])
    const compaction = u4CompactionEntries(entries)[0] as Record<string, unknown>
    expect(compaction.summary).toBe('宿主摘要')
    // ② 级锚：悬空 part 不登记合并 → 无锚 part → tail 解析不到 → 紧邻前驱 = u-real 的 entry
    expect(compaction.firstKeptEntryId).toBe('00000002')
    expect(new Set(entries.map((e) => e.id as string)).has(compaction.firstKeptEntryId as string)).toBe(true)
    // 三产物②：悬空 part 的现状 custom entry（边界元数据原样透传，不吞）
    expect(entries[3]).toMatchObject({
      type: 'custom',
      customType: 'zcode-import:compaction',
      data: danglingPart,
      timestamp: new Date(2600).toISOString(),
    })
    // 三产物③：compaction_unlinked 降级登记（L3，宿主 kind 注解）不吞
    expect(out.degradations).toEqual([{ code: 'compaction_unlinked', kind: 'compact_summary', count: 1 }])
    // 宿主 text part 随合并被消费：无 user entry 承载摘要正文
    const userTexts = entries
      .filter((e) => (e.message as { role?: string } | undefined)?.role === 'user')
      .flatMap((e) => ((e.message as { content: Array<{ text?: string }> }).content).map((c) => c.text ?? ''))
    expect(userTexts).toEqual(['真话'])
  })

  it('正常孤儿宿主被丢弃时随宿主消失（零 entry；登记仅宿主自身 L2 丢弃，无 compaction_unlinked）', () => {
    const out = buildZcodeSessionFile(
      [zUser('o-dropped', [zCompaction({ timelineStatus: 'completed' })], { semantics: U4_TIMELINE_SEMANTICS })],
      'T',
      U4_HEADER,
    )
    const { entries } = u4Parse(out)
    expect(entries).toHaveLength(1) // 仅 session_info
    expect(out.degradations).toEqual([{ code: 'dropped_transient', kind: 'timeline_event', count: 1 }])
  })
})

describe('U4 converter：summary.body 缺失退化（不伪造，P-4 降级路径）', () => {
  // compact_summary kind 但无 data.summary——宿主不可合并：宿主 part 不登记合并、走现状通道
  const msgs: ZcodeMessageInput[] = [
    zUser('u1', [zText('问')]),
    zUser(
      'c-no-body',
      [zText('正文在 text part'), zCompaction({ preCompactTokenCount: 80000 })],
      { semantics: U4_COMPACT_SUMMARY_SEMANTICS },
      2000,
    ),
  ]
  const out = buildZcodeSessionFile(msgs, 'T', U4_HEADER)
  const { entries } = u4Parse(out)

  it('无 compaction entry；退化为现状形态（user entry + compaction part custom entry）', () => {
    expect(entries.map((e) => e.type)).toEqual(['session_info', 'message', 'custom', 'message'])
    expect(entries.some((e) => e.type === 'compaction')).toBe(false)
    // 现状 user entry：text part 保留（摘要内容不丢）
    expect((entries[3] as { message: { content: Array<Record<string, unknown>> } }).message.content).toEqual([
      { type: 'text', text: '正文在 text part' },
    ])
    expect(entries[2]).toMatchObject({ customType: 'zcode-import:compaction', data: { preCompactTokenCount: 80000 } })
  })

  it('计 compaction_unlinked 降级（L3，宿主 kind 注解）', () => {
    expect(out.degradations).toEqual([{ code: 'compaction_unlinked', kind: 'compact_summary', count: 1 }])
  })
})

describe('U4 converter：真实形态回放锚（考古 §6 联合分区形态 → applyEntry 消费链）', () => {
  // 形态清单（考古 §9.4）：legacy 指针（无 semantics 宿主）→ 合并；现代指针（timeline_event 宿主）
  // → 合并；compact_summary 本体 ②形态（[compaction+text] 双 part）→ 合并；孤儿（无 semantics
  // 宿主 + 顶层 timelineStatus）→ custom；全程零 unclassified
  const legacyPointerPart = zCompaction({ summaryMessageId: 'c1', tail_start_id: 'u1' })
  const c2HostedPart = zCompaction({
    tail_start_id: 'a1',
    preCompactTokenCount: 4321,
    timelineStatus: 'completed',
    time: { start: 6500, end: 6600 },
  })
  const msgs: ZcodeMessageInput[] = [
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
  ]
  const out = buildZcodeSessionFile(msgs, 'T', U4_HEADER)
  const { entries } = u4Parse(out)
  const mapped = mapSessionEntries(entries as unknown as PiSessionEntry[])
  const orphans: PiHistoryToolResult[] = []
  const messages = convertPiHistory(mapped.messages, mapped.entryIds, orphans)

  it('重放无异常：消息序列 = user → system(compaction) → assistant → system(compaction) → user', () => {
    // reducer 把 compactionSummary 伪消息折成 role:'system' + compactionSummary 字段（applyEntry 语义）
    expect(messages.map((m: Message) => m.role)).toEqual(['user', 'system', 'assistant', 'system', 'user'])
    const summaries = messages
      .filter((m: Message) => m.role === 'system')
      .map((m: Message) => m.compactionSummary?.summary)
    expect(summaries).toEqual(['legacy 摘要（无 semantics 仅 data.summary）', '现代摘要'])
    expect(orphans).toHaveLength(0)
  })

  it('⛔ 全局拒发门：每条 compaction entry 的 firstKeptEntryId 都指向产物内真实 entry（零悬空）', () => {
    const entryIds = new Set(entries.map((e) => e.id as string))
    const compactions = u4CompactionEntries(entries) as Array<{
      id: string
      firstKeptEntryId: string
      summary: string
      tokensBefore?: number
    }>
    expect(compactions).toHaveLength(2)
    expect(compactions[0]?.summary).toBe('legacy 摘要（无 semantics 仅 data.summary）')
    expect(compactions[0]?.firstKeptEntryId).toBe('00000002') // u1 的 entry（legacy 指针 ① 级锚命中）
    // 现代本体 ②形态：tokensBefore ← preCompactTokenCount；锚 ← tail a1 的 entry
    expect(compactions[1]?.tokensBefore).toBe(4321)
    expect(compactions[1]?.firstKeptEntryId).toBe('00000004')
    for (const c of compactions) {
      expect(entryIds.has(c.firstKeptEntryId), `firstKeptEntryId ${c.firstKeptEntryId} 悬空`).toBe(true)
    }
  })

  it('legacy 指针合并缺 preCompactTokenCount（考古 §2：指针形态不携带该字段）→ tokensBefore 键缺省不写 0', () => {
    const compactions = u4CompactionEntries(entries) as Array<Record<string, unknown>>
    expect(compactions[0]).not.toHaveProperty('tokensBefore')
    expect(compactions[1]).toHaveProperty('tokensBefore', 4321)
  })

  it('孤儿保留 custom 通道（customDataEntries 恰 1 条）；合并宿主 text part 不再出现', () => {
    expect(mapped.customDataEntries).toHaveLength(1)
    expect((mapped.customDataEntries[0] as { customType?: string }).customType).toBe('zcode-import:compaction')
    // user content 经 reducer 可为块数组——形态宽容提取后断言文本归属
    const userTexts = messages
      .filter((m: Message) => m.role === 'user')
      .map((m: Message) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('|')
    expect(userTexts).toContain('真话')
    expect(userTexts).toContain('还在')
    expect(userTexts).not.toContain('c1 正文')
    expect(userTexts).not.toContain('c2 正文')
    // 降级 = 两个指针宿主自身的 L2 丢弃聚合（legacy 宿主无 kind → 键缺省；现代宿主 kind=timeline_event），
    // 无 compaction_unlinked、无 unclassified
    expect(out.degradations).toEqual([
      { code: 'dropped_transient', count: 1 },
      { code: 'dropped_transient', kind: 'timeline_event', count: 1 },
    ])
  })
})
