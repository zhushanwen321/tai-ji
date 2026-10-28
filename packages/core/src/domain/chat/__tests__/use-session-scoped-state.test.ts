// use-session-scoped-state.test.ts —— core C10 簇合并产物（round5-G）。
// 共同被测业务模块：`src/foundation/use-session-scoped-state.ts`。mock 相容：全簇零 vi.mock。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/domain/chat/__tests__/message-turns.incremental.test.ts（68 用例，skip 0）
//   - src/foundation/__tests__/use-session-scoped-state.test.ts（5 用例，skip 0）
//   - src/foundation/use-session-scoped-state.test.ts（20 用例，skip 0）

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { effectScope, ref, shallowRef, nextTick } from 'vue'
import { toRenderItems, toRenderItemsIncremental, createTurnRenderCache, turnStableId, type RenderItem, type TurnRenderCache } from '../message-turns'
import { useSessionScopedState, registerSessionCleanup, triggerSessionCleanups, __clearSessionCleanupRegistryForTest } from '../../../foundation/use-session-scoped-state'
import { type Message } from '@taiji/shared'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error —— 无类型 .mjs 检查脚本（Node 直跑形态），core 不为测试引入 allowJs；类型边界见下方别名
import { collectCallSites, compareCensusToSnapshot, CENSUS_SNAPSHOT } from '../../../../../../scripts/check-session-scoped-state-census.mjs'

// ======== 来源：message-turns.incremental.test.ts ========
describe("message-turns.incremental [src/domain/chat/__tests__]", () => {
  // ── fixture 构造 helper ───────────────────────────────────────────────

  let seq = 0
  function makeMsg(over: Partial<Message> = {}): Message {
    seq += 1
    return { id: `m${seq}`, role: 'assistant', content: '', status: 'complete', timestamp: 0, ...over }
  }

  function bashMsg(id: string, over: Partial<Message> = {}): Message {
    return makeMsg({
      id,
      role: 'system',
      content: '',
      bashExecution: {
        command: 'echo hi',
        output: 'hi',
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 1000,
      },
      ...over,
    })
  }

  /** 隐藏完成通知（subagent-bg-notify / workflow-result / managed-session-notify，display:false——生产端覆写形态） */
  function notifyMsg(id: string, customType = 'subagent-bg-notify'): Message {
    return makeMsg({ id, role: 'system', customType, display: false, content: '' })
  }

  /** liveOnly 健康警告（stream_warn 形态；liveOnly 由 W2 在创建点打标，此处只构造读取） */
  function liveWarnMsg(id: string): Message {
    return makeMsg({ id, role: 'system', content: 'stream 超时', liveOnly: true })
  }

  /** 收窄 helper：取 turn 项的 MessageTurn（非 turn 项抛错，测试自检用） */
  function turnOf(item: RenderItem) {
    if (item.kind !== 'turn') throw new Error(`expected turn item, got ${item.kind}`)
    return item.turn
  }

  /** R2 组共用场景骨架：一问一答 turn → 隐藏完成通知边界（数量/形态由调用方给）→ 续跑 assistant */
  function qaThenNotify(notices: Message[]): Message[] {
    return [
      makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
      ...notices,
      makeMsg({ id: 'a2', role: 'assistant', content: '续跑结果' }),
    ]
  }

  /** R2 断言简写：第 2 个渲染项为 bg-notify 触发的 trigger turn，assistants 恰为给定 id 序列 */
  function expectBgNotifyTriggerTurn(items: RenderItem[], assistantIds: string[]): void {
    const t2 = turnOf(items[1])
    expect(t2.trigger).toBe('bg-notify')
    expect(t2.assistants.map((m) => m.id)).toEqual(assistantIds)
  }

  /** 混合 fixture：turn / systemNotice / bashExecution 全 kind 覆盖。
 *  bash 置于 c1（可见 system 边界）之后 → 无当前 turn → 退化独立 static 项（规则 4 兜底）；
 *  若置于 turn 内则按规则 v2 inline 归 turn（notices），不再产出独立 bashExecution 项。 */
  function mixedFixture(): Message[] {
    return [
      makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
      makeMsg({ id: 'c1', role: 'system', content: '压缩记录' }),
      bashMsg('bash-1'),
      makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
    ]
  }

  /** bash 落位 static 外部行断言单源（items[1] = b1 systemNotice；尾 user turn 归属断言，返回尾 turn）。 */
  function expectBashAsStaticNotice(items: ReturnType<typeof toRenderItems>, tailUserId: string) {
    expect(items).toHaveLength(3)
    expect(items[1]).toEqual({ kind: 'systemNotice', message: expect.objectContaining({ id: 'b1' }) })
    const t2 = turnOf(items[2])
    expect(t2.user?.id).toBe(tailUserId)
    return t2
  }

  /** bash + 隐藏通知共存的典型输入前缀（u1→a1→b1(done)→n1，尾随消息由调用方追加）。 */
  function bashThenNotifyPrefix() {
    return [
      makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
      bgBashDoneMsg('b1'),
      notifyMsg('n1', 'subagent-bg-notify'),
    ]
  }

  describe('toRenderItemsIncremental —— 退化路径与等价性', () => {
    it('cache=undefined 退化为全量版：输出与 toRenderItems deepEqual（forceWorking 双态）', () => {
      for (const fw of [false, true]) {
        const msgs = mixedFixture()
        expect(toRenderItemsIncremental(msgs, fw, undefined)).toEqual(
          toRenderItems(msgs, fw),
        )
      }
    })

    it('流式追加序列逐步等价：末位 assistant 对象逐步替换 + 新 turn + system 穿插，每步与全量版 deepEqual', () => {
      const cache = createTurnRenderCache()
      const u1 = makeMsg({ id: 'u1', role: 'user', content: 'q1' })
      const a1v1 = makeMsg({ id: 'a1', role: 'assistant', content: '部分', status: 'streaming' })
      const steps: Message[][] = [
        [u1],
        [u1, a1v1],
        // token 推进 = 末位 assistant 新对象替换（D-1 不可变语义）
        [u1, makeMsg({ id: 'a1', role: 'assistant', content: '部分回复', status: 'streaming' })],
        // 新 turn 追加（上一末位 streaming 态应被校正为 false）
        [
          u1,
          makeMsg({ id: 'a1', role: 'assistant', content: '完整回复', status: 'complete' }),
          makeMsg({ id: 'c1', role: 'system', content: 'notice' }),
          makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
        ],
        [
          u1,
          makeMsg({ id: 'a1', role: 'assistant', content: '完整回复', status: 'complete' }),
          makeMsg({ id: 'c1', role: 'system', content: 'notice' }),
          makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
          makeMsg({ id: 'a2', role: 'assistant', content: 'r2', status: 'streaming' }),
        ],
      ]
      for (const step of steps) {
        expect(toRenderItemsIncremental(step, false, cache)).toEqual(
          toRenderItems(step, false),
        )
      }
    })

    it('display:false 非通知消息透明：分组消费全量数组，隐藏消息不产出渲染项、不切断 turn（D3 输出侧过滤）', () => {
      const cache = createTurnRenderCache()
      const msgs = [
        makeMsg({ id: 'u1', role: 'user', content: 'q' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
        makeMsg({ id: 'h1', role: 'system', customType: 'todo-context', display: false, content: 'hidden' }),
        makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
      ]
      const items = toRenderItemsIncremental(msgs, false, cache)
      expect(items.map((i) => i.kind)).toEqual(['turn'])
      // a2 仍归 u1 的 turn（隐藏消息透明，不切断）；输出与全量版一致
      expect(turnOf(items[0]).assistants.map((m) => m.id)).toEqual(['a1', 'a2'])
      expect(items).toEqual(toRenderItems(msgs, false))
    })
  })

  describe('toRenderItemsIncremental —— ① 快路径零重算', () => {
    it('同源数组引用第二次调用：返回引用恒等 + turn 对象 toBe 恒等', () => {
      const cache = createTurnRenderCache()
      const msgs = mixedFixture()
      const r1 = toRenderItemsIncremental(msgs, false, cache)
      expect(r1).toBe(cache.cachedItems)
      // 快路径：同引用再次调用直接复用 cachedItems（含非 turn 项）不重扫（W4 起 filter 参数已移除——分组恒消费全量数组）
      const r2 = toRenderItemsIncremental(msgs, false, cache)
      expect(r2).toBe(r1)
      expect(turnOf(r2[0])).toBe(turnOf(r1[0]))
      expect(cache.lastSourceRef).toBe(msgs)
    })
  })

  describe('toRenderItemsIncremental —— ② 末位追加只重建末位 turn', () => {
    it('追加 assistant 进末位 turn：前面 turn 对象 toBe 恒等，末位 turn 重建（签名变化）', () => {
      const cache = createTurnRenderCache()
      const u1 = makeMsg({ id: 'u1', role: 'user' })
      const a1 = makeMsg({ id: 'a1', role: 'assistant', content: 'r1' })
      const u2 = makeMsg({ id: 'u2', role: 'user' })
      const r1 = toRenderItemsIncremental([u1, a1, u2], false, cache)
      const a2 = makeMsg({ id: 'a2', role: 'assistant', content: 'r2' })
      const r2 = toRenderItemsIncremental([u1, a1, u2, a2], false, cache)
      expect(turnOf(r2[0])).toBe(turnOf(r1[0])) // 历史 turn 复用（身份恒等）
      expect(turnOf(r2[1])).not.toBe(turnOf(r1[1])) // 末位 turn 重建（[u2] → [u2,a2]）
      expect(turnOf(r2[1]).assistants.map((m) => m.id)).toEqual(['u2', 'a2'].slice(1))
      expect(r2).toEqual(toRenderItems([u1, a1, u2, a2], false))
    })

    it('追加新 user turn：历史 turn 全部 toBe 复用，新 turn 新建', () => {
      const cache = createTurnRenderCache()
      const u1 = makeMsg({ id: 'u1', role: 'user' })
      const a1 = makeMsg({ id: 'a1', role: 'assistant', content: 'r1' })
      const r1 = toRenderItemsIncremental([u1, a1], false, cache)
      const u2 = makeMsg({ id: 'u2', role: 'user' })
      const a2 = makeMsg({ id: 'a2', role: 'assistant', content: 'r2' })
      const r2 = toRenderItemsIncremental([u1, a1, u2, a2], false, cache)
      expect(turnOf(r2[0])).toBe(turnOf(r1[0]))
      expect(turnOf(r2[1])).not.toBe(turnOf(r1[0]))
      expect(turnOf(r2[1]).index).toBe(2)
    })

    it('[D2] 插话回流开新 turn 后旧末位 streaming 回合保持 isStreaming=true（双工作态，对象不可变替换）', () => {
      const cache = createTurnRenderCache()
      const u1 = makeMsg({ id: 'u1', role: 'user' })
      const a1s = makeMsg({ id: 'a1', role: 'assistant', content: 'r', status: 'streaming' })
      const r1 = toRenderItemsIncremental([u1, a1s], false, cache)
      expect(turnOf(r1[0]).isStreaming).toBe(true)
      const u2 = makeMsg({ id: 'u2', role: 'user' })
      const r2 = toRenderItemsIncremental([u1, a1s, u2], false, cache)
      // [chat-flow-consistency D2] isStreaming = 回合内末位 assistant 是否 streaming，不再以
      // 末位回合短路：turn1 的 a1s 仍 streaming（到回合级 message.complete 才收尾）→ 保持 true
      // —— 双工作态并存（期望形态）。期望值未变（复用判定命中）→ turn 对象引用恒等（零 churn），
      // assistants 引用保留。
      expect(turnOf(r2[0]).isStreaming).toBe(true)
      expect(turnOf(r2[0])).toBe(turnOf(r1[0]))
      expect(turnOf(r2[0]).assistants).toBe(turnOf(r1[0]).assistants)
      expect(r2).toEqual(toRenderItems([u1, a1s, u2], false))
    })

    it('[D2] 旧回合定稿收尾（assistant status 翻 complete，新对象替换）→ isStreaming 翻 false', () => {
      const cache = createTurnRenderCache()
      const u1 = makeMsg({ id: 'u1', role: 'user' })
      const a1s = makeMsg({ id: 'a1', role: 'assistant', content: 'r', status: 'streaming' })
      const u2 = makeMsg({ id: 'u2', role: 'user' })
      const a2s = makeMsg({ id: 'a2', role: 'assistant', content: 'r2', status: 'streaming' })
      toRenderItemsIncremental([u1, a1s, u2, a2s], false, cache)
      // 旧回合 message.complete 到达（a1s 换 complete 新对象——不可变纪律）：双工作态解除
      const a1done = makeMsg({ id: 'a1', role: 'assistant', content: 'r', status: 'complete' })
      const r3 = toRenderItemsIncremental([u1, a1done, u2, a2s], false, cache)
      expect(turnOf(r3[0]).isStreaming).toBe(false)
      expect(turnOf(r3[1]).isStreaming).toBe(true)
      expect(r3).toEqual(toRenderItems([u1, a1done, u2, a2s], false))
    })

    it('hasFoldable 随成员变化重算：追加带 thinking 的 assistant 后末位 turn hasFoldable=true', () => {
      const cache = createTurnRenderCache()
      const u1 = makeMsg({ id: 'u1', role: 'user' })
      const r1 = toRenderItemsIncremental([u1], false, cache)
      expect(turnOf(r1[0]).hasFoldable).toBe(false)
      const a1 = makeMsg({
        id: 'a1',
        role: 'assistant',
        thinking: [{ id: 'th1', content: '推理', collapsed: false }],
      })
      const r2 = toRenderItemsIncremental([u1, a1], false, cache)
      expect(turnOf(r2[0])).not.toBe(turnOf(r1[0]))
      expect(turnOf(r2[0]).hasFoldable).toBe(true)
    })
  })

  describe('toRenderItemsIncremental —— ③ forceWorking 变化只重算末位', () => {
    it('源数组不变 fw false→true：仅末位 turn 对象替换，历史 turn toBe 恒等；再次同参引用恒等', () => {
      const cache = createTurnRenderCache()
      // mixedFixture items = [turn, systemNotice, bashExecution, turn]（v2：bash 在可见 system
      // 边界后无当前 turn，退化独立 static 项），末位 turn 在 index 3
      const msgs = mixedFixture()
      const r1 = toRenderItemsIncremental(msgs, false, cache)
      const r2 = toRenderItemsIncremental(msgs, true, cache)
      expect(r2).not.toBe(r1)
      expect(turnOf(r2[0])).toBe(turnOf(r1[0])) // 历史 turn 复用
      const t1 = turnOf(r1[3])
      const t2 = turnOf(r2[3])
      expect(t2).not.toBe(t1) // 末位 turn 替换
      expect(t2.isStreaming).toBe(true)
      expect(t1.isStreaming).toBe(false)
      // bashExecution 项（末位 turn 前的 static 项）引用恒等复用
      expect(r2[2]).toBe(r1[2])
      expect(r2[2].kind).toBe('bashExecution')
      // cache 自洽：替换后再次同参 → 引用恒等（零重算）
      const r3 = toRenderItemsIncremental(msgs, true, cache)
      expect(r3).toBe(r2)
      // fw true→false 对称回退
      const r4 = toRenderItemsIncremental(msgs, false, cache)
      expect(turnOf(r4[3]).isStreaming).toBe(false)
      expect(turnOf(r4[0])).toBe(turnOf(r1[0]))
    })

    it('快路径末位 turn 查找正确跳过 static 项（末位是 bashExecution 时仍驱动最后一个 turn）', () => {
      const cache = createTurnRenderCache()
      const u1 = makeMsg({ id: 'u1', role: 'user' })
      const a1 = makeMsg({ id: 'a1', role: 'assistant', content: 'r1' })
      // v2：bash 之前先放可见 system（c1）关闭 turn → bash 无当前 turn 退化独立 static 项，
      // 末位形态 = [turn, systemNotice, bashExecution]（最后一个 turn 后跟两个 static 项）
      const c1 = makeMsg({ id: 'c1', role: 'system', content: 'notice' })
      const bash = bashMsg('bash-1')
      const msgs = [u1, a1, c1, bash]
      const r1 = toRenderItemsIncremental(msgs, false, cache)
      expect(r1.map((i) => i.kind)).toEqual(['turn', 'systemNotice', 'bashExecution'])
      const r2 = toRenderItemsIncremental(msgs, true, cache)
      expect(turnOf(r2[0]).isStreaming).toBe(true) // static 项之后的最后一个 turn 被正确驱动
      // static 项本身引用复用（不依赖 forceWorking）
      expect(r2[1]).toBe(r1[1])
      expect(r2[2]).toBe(r1[2])
    })

    it('末位 assistant status=streaming 时 fw 翻转 isStreaming 期望不变：引用恒等返回（零重算）', () => {
      const cache = createTurnRenderCache()
      const msgs = [
        makeMsg({ id: 'u1', role: 'user' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r', status: 'streaming' }),
      ]
      const r1 = toRenderItemsIncremental(msgs, false, cache)
      expect(turnOf(r1[0]).isStreaming).toBe(true)
      const r2 = toRenderItemsIncremental(msgs, true, cache)
      expect(r2).toBe(r1) // 期望值不变 → cachedItems 引用恒等
    })
  })

  describe('toRenderItemsIncremental —— ④ 非 turn 项行为等价', () => {
    it('快路径：systemNotice/bashExecution 项引用恒等复用（cachedItems 整体复用）', () => {
      const cache = createTurnRenderCache()
      const msgs = mixedFixture()
      const r1 = toRenderItemsIncremental(msgs, false, cache)
      const r2 = toRenderItemsIncremental(msgs, false, cache)
      expect(r2[1]).toBe(r1[1]) // systemNotice
      // items = [turn, systemNotice, bashExecution, turn]（长度 4，bash 在下标 2）
      expect(r2[2]).toBe(r1[2]) // bashExecution
      expect(r2[2].kind).toBe('bashExecution') // 确认下标 2 确是 bashExecution（防下标写错退化成 vacuous）
    })

    it('重扫路径：system 项重建但 message 引用相同、kind 相同，整体与全量版 deepEqual', () => {
      const cache = createTurnRenderCache()
      const u1 = makeMsg({ id: 'u1', role: 'user' })
      const a1 = makeMsg({ id: 'a1', role: 'assistant' })
      const c1 = makeMsg({ id: 'c1', role: 'system', content: '压缩记录' })
      const bash = bashMsg('bash-1')
      const r1 = toRenderItemsIncremental([u1, a1, c1, bash], false, cache)
      const u2 = makeMsg({ id: 'u2', role: 'user' })
      const src2 = [u1, a1, c1, bash, u2]
      const r2 = toRenderItemsIncremental(src2, false, cache)
      expect(r2[1]).not.toBe(r1[1]) // static 项重扫重建（新 wrapper 对象）
      expect(r2[1]).toEqual(r1[1]) // 内容等价
      if (r2[1].kind !== 'systemNotice' || r1[1].kind !== 'systemNotice') throw new Error('expected systemNotice')
      expect(r2[1].message).toBe(r1[1].message) // message 引用不变
      expect(r2).toEqual(toRenderItems(src2, false))
    })
  })

  describe('toRenderItemsIncremental —— ④b 平移场景（W21 review Fix-5）', () => {
    it('prepend 历史（load-more）：输出与全量版 deepEqual，旧末位 turn 经重算路径 streaming 校正正确', () => {
      const cache = createTurnRenderCache()
      const u1 = makeMsg({ id: 'u1', role: 'user' })
      const a1s = makeMsg({ id: 'a1', role: 'assistant', content: 'r', status: 'streaming' })
      const r1 = toRenderItemsIncremental([u1, a1s], false, cache)
      expect(turnOf(r1[0]).isStreaming).toBe(true)

      // 头部 prepend：system notice + 一个完整 turn → 旧 turn 签名整体下移一位，
      // 同位置签名错位 → 全部重算（08 §3.3.1 失效条件 2：位置平移的 turn 重算）
      const sys = makeMsg({ id: 'sys0', role: 'system', content: 'notice' })
      const u0 = makeMsg({ id: 'u0', role: 'user', content: 'history q' })
      const a0 = makeMsg({ id: 'a0', role: 'assistant', content: 'history a' })
      const src2 = [sys, u0, a0, u1, a1s]
      const r2 = toRenderItemsIncremental(src2, false, cache)

      // 正确性兜底：平移场景输出与全量版 deepEqual（错位复用会导致 index/user 错乱，此处兜住）
      expect(r2).toEqual(toRenderItems(src2, false))
      expect(r2.map((i) => i.kind)).toEqual(['systemNotice', 'turn', 'turn'])
      // 旧末位 turn（现第 2 个 turn）仍为末位：重算后 isStreaming 正确保持 true（成员 a1s 仍 streaming）
      expect(turnOf(r2[2]).isStreaming).toBe(true)
      expect(turnOf(r2[2]).user?.id).toBe('u1')
      expect(turnOf(r2[2]).index).toBe(2)
    })

    it('中删一 turn（branch/fork 剪枝）：后续 turn 重算，index 连续不跳号，前缀 turn 引用复用', () => {
      const cache = createTurnRenderCache()
      const msgs = [
        makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
        makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
        makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
        makeMsg({ id: 'u3', role: 'user', content: 'q3' }),
        makeMsg({ id: 'a3', role: 'assistant', content: 'r3' }),
      ]
      const r1 = toRenderItemsIncremental(msgs, false, cache)
      expect(r1.map((i) => i.kind)).toEqual(['turn', 'turn', 'turn'])

      // 删中间 turn2（[u2,a2] 整组移除）：位置 1 旧签名 [u2,a2] vs 新 [u3,a3] 错位 → 重算
      const src2 = msgs.filter((m) => m.id !== 'u2' && m.id !== 'a2')
      const r2 = toRenderItemsIncremental(src2, false, cache)

      // 前缀 turn 引用复用（位置 0 签名对齐）
      expect(turnOf(r2[0])).toBe(turnOf(r1[0]))
      // 后续 turn 重算：index 连续（1,2 —— 非 1,3 跳号残留）
      expect(r2.map((i) => i.kind)).toEqual(['turn', 'turn'])
      expect(turnOf(r2[1]).index).toBe(2)
      expect(turnOf(r2[1]).user?.id).toBe('u3')
      expect(turnOf(r2[1])).not.toBe(turnOf(r1[2])) // 旧 turn3 对象不复用（签名错位重算）
      expect(r2).toEqual(toRenderItems(src2, false))
    })
  })

  describe('toRenderItemsIncremental —— ⑤ 缓存分区隔离（useSessionScopedState 组合语义）', () => {
    /** 模拟 MessageStream 的消费形态：工厂分区持有 shallowRef 包裹的 TurnRenderCache */
    function setup() {
      const scope = effectScope()
      const store: Record<string, Message[]> = {
        a: [
          makeMsg({ id: 'ua1', role: 'user', content: 'A 的提问' }),
          makeMsg({ id: 'aa1', role: 'assistant', content: 'A 的回复' }),
        ],
        b: [
          makeMsg({ id: 'ub1', role: 'user', content: 'B 的提问' }),
          makeMsg({ id: 'ab1', role: 'assistant', content: 'B 的回复' }),
        ],
      }
      let deriveFor!: (sid: string, forceWorking?: boolean) => RenderItem[]
      let state: ReturnType<typeof useSessionScopedState<ReturnType<typeof makeCacheRef>>>
      function makeCacheRef() {
        return shallowRef<TurnRenderCache>(createTurnRenderCache())
      }
      scope.run(() => {
        const sidRef = ref<string | null>('a')
        state = useSessionScopedState(sidRef, makeCacheRef)
        deriveFor = (sid: string, forceWorking = false) => {
          sidRef.value = sid
          const cacheRef = state.current.value
          return toRenderItemsIncremental(store[sid], forceWorking, cacheRef.value)
        }
      })
      return { deriveFor, state: () => state, store }
    }

    it('sid A/B 互不污染：切 B 再切回 A，A 的 cachedItems 引用恒等（快路径命中、分区保留）', () => {
      const { deriveFor } = setup()
      const ra1 = deriveFor('a')
      const rb = deriveFor('b')
      // B 的派生内容正确（不串台）
      expect(turnOf(rb[0]).user?.id).toBe('ub1')
      expect(turnOf(rb[0]).user?.content).toBe('B 的提问')
      // 切回 A：分区保留 → 源数组引用未变 → 快路径命中（被 B 污染则会重扫或内容错乱）
      const ra2 = deriveFor('a')
      expect(ra2).toBe(ra1)
      expect(turnOf(ra2[0]).user?.id).toBe('ua1')
      // B 侧同理
      const rb2 = deriveFor('b')
      expect(rb2).toBe(rb)
    })

    it('cleanup(sid) 后分区重建：该 sid 重新全量派生（对象新），另一 sid 分区不受影响', () => {
      const { deriveFor, state } = setup()
      const ra1 = deriveFor('a')
      const rb1 = deriveFor('b')
      state().cleanup('a') // 模拟 triggerSessionCleanups('a') 走到的分区删除
      const ra2 = deriveFor('a')
      expect(ra2).not.toBe(ra1) // 分区重建 → 全量重扫（引用新）
      expect(ra2).toEqual(ra1) // 内容不变（纯派生缓存可无损重建）
      const rb2 = deriveFor('b')
      expect(rb2).toBe(rb1) // B 分区未受 cleanup('a') 影响
    })
  })

  // ── 分组规则 v2（W3，conversation-turn-attribution §3.3 D3/D4）──────────────────

  describe('groupRenderInput 分组规则 v2 —— 规则 1/3/5（现状语义锚定）', () => {
    it('R1 user 锚开新 turn；R3 assistant 归当前（无则自启 user:null turn）', () => {
      const items = toRenderItems([
        makeMsg({ id: 'a0', role: 'assistant', content: '首条无 user' }),
        makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
        makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
        makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
      ])
      expect(items.map((i) => i.kind)).toEqual(['turn', 'turn', 'turn'])
      expect(turnOf(items[0]).user).toBeNull() // 首条 assistant 自启（边缘保留）
      expect(turnOf(items[0]).trigger).toBeUndefined() // 自启 turn 无 trigger 标记
      expect(turnOf(items[1]).user?.id).toBe('u1')
      expect(turnOf(items[1]).assistants.map((m) => m.id)).toEqual(['a1', 'a2'])
      expect(turnOf(items[2]).user?.id).toBe('u2')
      expect(turnOf(items[2]).assistants).toEqual([])
    })

    it('R5 可见 system 边界语义不变：独立 systemNotice 项 + 关闭当前 turn（后续 assistant 自启无 trigger）', () => {
      const items = toRenderItems([
        makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
        makeMsg({ id: 'c1', role: 'system', content: '压缩记录', compactionSummary: { summary: '压缩' } }),
        makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
        makeMsg({ id: 'v1', role: 'system', customType: 'goal-progress', content: '可见 custom' }),
      ])
      expect(items.map((i) => i.kind)).toEqual(['turn', 'systemNotice', 'turn', 'systemNotice'])
      expect(turnOf(items[0]).assistants.map((m) => m.id)).toEqual(['a1'])
      expect(turnOf(items[2]).user).toBeNull()
      expect(turnOf(items[2]).trigger).toBeUndefined() // assistant 自启，非触发 turn
    })
  })

  describe('groupRenderInput 分组规则 v2 —— R2 隐藏完成通知 = turn 边界（机制 A 修复，D3）', () => {
    it('R2 边界：关闭当前 turn、开启 trigger turn，后续 assistant 归入（不再并入上一提问）', () => {
      const items = toRenderItems([
        makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
        notifyMsg('n1'),
        makeMsg({ id: 'a2', role: 'assistant', content: '续跑结果' }),
      ])
      expect(items.map((i) => i.kind)).toEqual(['turn', 'turn'])
      expect(turnOf(items[0]).user?.id).toBe('u1')
      expect(turnOf(items[0]).assistants.map((m) => m.id)).toEqual(['a1'])
      const t2 = turnOf(items[1])
      expect(t2.user).toBeNull()
      expect(t2.trigger).toBe('bg-notify')
      expect(t2.assistants.map((m) => m.id)).toEqual(['a2'])
    })

    it('R2 常量源：workflow-result / managed-session-notify 同属 COMPLETE_NOTIFY_CUSTOM_TYPES（shared SSOT，无第二份判定）', () => {
      const items = toRenderItems(qaThenNotify([
        notifyMsg('n1', 'workflow-result'),
        notifyMsg('n2', 'managed-session-notify'),
      ]))
      expectBgNotifyTriggerTurn(items, ['a2'])
    })

    it('R2 空 turn 折叠：连续边界折叠为一个 trigger turn（后续 assistant 归入该组）', () => {
      const items = toRenderItems(qaThenNotify([notifyMsg('n1'), notifyMsg('n2'), notifyMsg('n3')]))
      expect(items.map((i) => i.kind)).toEqual(['turn', 'turn']) // 三个边界折叠为一
      expectBgNotifyTriggerTurn(items, ['a2'])
    })

    it('R2 空 turn 折叠：边界后紧跟 user 不产出空 trigger turn', () => {
      const items = toRenderItems([
        makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
        notifyMsg('n1'),
        makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
        makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
      ])
      expect(items.map((i) => i.kind)).toEqual(['turn', 'turn'])
      expect(turnOf(items[1]).user?.id).toBe('u2')
      expect(turnOf(items[1]).trigger).toBeUndefined() // 空 trigger turn 已折叠，u2 开正常 turn
    })

    it('R2 空 turn 折叠：边界后数组结束 / 可见 system 边界均不产出空 trigger turn', () => {
      // 数组结束
      const endCase = toRenderItems([
        makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
        notifyMsg('n1'),
      ])
      expect(endCase.map((i) => i.kind)).toEqual(['turn'])
      // 可见 system 边界（压缩记录）关闭未填实 trigger turn
      const sysCase = toRenderItems([
        makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
        notifyMsg('n1'),
        makeMsg({ id: 'c1', role: 'system', content: '压缩记录' }),
        makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
      ])
      expect(sysCase.map((i) => i.kind)).toEqual(['turn', 'systemNotice', 'turn'])
      expect(turnOf(sysCase[2]).trigger).toBeUndefined() // a2 自启 turn（空 trigger turn 已折叠）
    })

    it('R2 隐藏通知自身不渲染：全程无静态项产出（被消化为 trigger turn 语义，D3 输出侧过滤）', () => {
      const items = toRenderItems([notifyMsg('n1'), makeMsg({ id: 'a1', role: 'assistant', content: 'r' })])
      expect(items.map((i) => i.kind)).toEqual(['turn']) // 通知无独立渲染项
      expect(turnOf(items[0]).trigger).toBe('bg-notify')
      expect(turnOf(items[0]).user).toBeNull()
      expect(turnOf(items[0]).notices).toBeUndefined() // 通知不是 notice，是边界触发器
    })

    it('隐藏非完成通知消息透明：不切断 turn、不产出渲染项（todo-context 现状语义保留）', () => {
      const items = toRenderItems([
        makeMsg({ id: 'u1', role: 'user', content: 'q' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
        makeMsg({ id: 'h1', role: 'system', customType: 'todo-context', display: false, content: 'ctx' }),
        makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
      ])
      expect(items.map((i) => i.kind)).toEqual(['turn'])
      expect(turnOf(items[0]).assistants.map((m) => m.id)).toEqual(['a1', 'a2']) // 不切断
    })

    it('trigger turn 仅含 notice 时 turnStableId 回落 notices[0]（稳定 key 兜底）', () => {
      // n1 开 trigger turn → bash notice 挂入（turn 被填实）→ n2 边界关闭它并开新空 trigger turn（末尾折叠）
      const items = toRenderItems([
        makeMsg({ id: 'u1', role: 'user', content: 'q' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r' }),
        notifyMsg('n1'),
        bashMsg('bash-1'),
        notifyMsg('n2'),
      ])
      expect(items.map((i) => i.kind)).toEqual(['turn', 'turn'])
      const t2 = turnOf(items[1])
      expect(t2.trigger).toBe('bg-notify')
      expect(t2.assistants).toEqual([])
      expect(t2.notices?.map((m) => m.id)).toEqual(['bash-1'])
      expect(turnStableId(t2)).toBe('bash-1')
    })
  })

  describe('groupRenderInput 分组规则 v2 —— R4 inline notice 归 turn 内（机制 C 修复，D4）', () => {
    it('R4 bash 执行记录归当前 turn 内部：不切断 turn、无独立渲染项（notices 按到达序追加末尾）', () => {
      const items = toRenderItems([
        makeMsg({ id: 'u1', role: 'user', content: 'q' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
        bashMsg('bash-1'),
        makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
        bashMsg('bash-2'),
      ])
      expect(items.map((i) => i.kind)).toEqual(['turn']) // 旧 role 扫描会切成 turn+bash+孤立 turn
      const t = turnOf(items[0])
      expect(t.assistants.map((m) => m.id)).toEqual(['a1', 'a2']) // turn 不被切断
      expect(t.notices?.map((m) => m.id)).toEqual(['bash-1', 'bash-2']) // notice 不出 static 项
    })

    it('[C6] liveOnly 健康警告独立成项：开放 turn 期间到达先缓冲，该 turn 关闭后随其后输出（不切断 turn）', () => {
      // w1 在 a1 与 a2 之间到达（turn 开放期）→ 缓冲；u2 关闭 turn → w1 落位独立 systemNotice，
      // 位置 = 旧 turn 之后、新 turn 之前（时序位置，不归入任何 turn 的 notices）
      const items = toRenderItems([
        makeMsg({ id: 'u1', role: 'user', content: 'q' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r1', status: 'streaming' }),
        liveWarnMsg('w1'),
        makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
        makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
        makeMsg({ id: 'a3', role: 'assistant', content: 'r3' }),
      ])
      expect(items.map((i) => i.kind)).toEqual(['turn', 'systemNotice', 'turn'])
      // 不切断 turn：a1/a2 仍同回合（w1 到达不改任何消息归属判定）
      const t1 = turnOf(items[0])
      expect(t1.assistants.map((m) => m.id)).toEqual(['a1', 'a2'])
      expect(t1.notices).toBeUndefined() // liveOnly 不再 inline 归 turn
      if (items[1].kind !== 'systemNotice') throw new Error('expected systemNotice')
      expect(items[1].message.id).toBe('w1')
    })

    it('[C6] 无开放 turn 时 liveOnly 立即落位独立 systemNotice 项', () => {
      const items = toRenderItems([
        liveWarnMsg('w0'),
        makeMsg({ id: 'u1', role: 'user', content: 'q' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r' }),
      ])
      expect(items.map((i) => i.kind)).toEqual(['systemNotice', 'turn'])
      if (items[0].kind !== 'systemNotice') throw new Error('expected systemNotice')
      expect(items[0].message.id).toBe('w0')
      expect(turnOf(items[1]).notices).toBeUndefined()
    })

    it('R4 退化：无当前 turn 时 inline notice 退化为独立 static 项（bash 兜底保留；liveOnly 同形态恒独立，见 [C6]）', () => {
      const items = toRenderItems([
        bashMsg('bash-0'), // 首条，无当前 turn
        liveWarnMsg('w0'), // 同上（[C6] 无开放 turn → 立即独立 systemNotice）
        makeMsg({ id: 'u1', role: 'user', content: 'q' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r' }),
      ])
      expect(items.map((i) => i.kind)).toEqual(['bashExecution', 'systemNotice', 'turn'])
      expect(turnOf(items[2]).notices).toBeUndefined() // 有当前 turn 后不再退化
    })

    it('[C6] 多条 liveOnly 缓冲按到达序落位；bash inline notice 与 liveOnly 各走各路', () => {
      const items = toRenderItems([
        makeMsg({ id: 'u1', role: 'user', content: 'q' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
        liveWarnMsg('w1'),
        bashMsg('bash-1'),
        liveWarnMsg('w2'),
        makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
        makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
      ])
      // bash-1 inline 归 turn1（规则 4a 不变）；w1/w2 缓冲，u2 关闭 turn 后按到达序落位
      expect(items.map((i) => i.kind)).toEqual(['turn', 'systemNotice', 'systemNotice', 'turn'])
      expect(turnOf(items[0]).notices?.map((m) => m.id)).toEqual(['bash-1'])
      if (items[1].kind !== 'systemNotice' || items[2].kind !== 'systemNotice') {
        throw new Error('expected systemNotice ×2')
      }
      expect(items[1].message.id).toBe('w1')
      expect(items[2].message.id).toBe('w2')
    })

    it('[C6] liveOnly 缓冲下增量路径与全量路径逐步等价（尾部快路径跨缓冲形态）', () => {
      const cache = createTurnRenderCache()
      const u1 = makeMsg({ id: 'u1', role: 'user', content: 'q1' })
      const a1 = makeMsg({ id: 'a1', role: 'assistant', content: 'r1' })
      const steps: Message[][] = [
        [u1, a1],
        // w1 到达（turn 开放 → 缓冲，无渲染项变化——恒等复用形态）
        [u1, a1, liveWarnMsg('w1')],
        // w2 到达（同上）
        [u1, a1, liveWarnMsg('w1'), liveWarnMsg('w2')],
        // u2 关闭 turn → w1/w2 落位独立项（结构变化）
        [u1, a1, liveWarnMsg('w1'), liveWarnMsg('w2'), makeMsg({ id: 'u2', role: 'user', content: 'q2' })],
      ]
      for (const step of steps) {
        expect(toRenderItemsIncremental(step, false, cache)).toEqual(toRenderItems(step, false))
      }
    })

    it('R4 notice 挂入 trigger turn：边界后的 bash 归触发 turn 的 notices（不另起 static）', () => {
      const items = toRenderItems([
        makeMsg({ id: 'u1', role: 'user', content: 'q' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r' }),
        notifyMsg('n1'),
        bashMsg('bash-1'),
        makeMsg({ id: 'a2', role: 'assistant', content: '续跑' }),
      ])
      expect(items.map((i) => i.kind)).toEqual(['turn', 'turn'])
      const t2 = turnOf(items[1])
      expect(t2.trigger).toBe('bg-notify')
      expect(t2.assistants.map((m) => m.id)).toEqual(['a2'])
      expect(t2.notices?.map((m) => m.id)).toEqual(['bash-1'])
    })
  })

  describe('groupRenderInput 分组规则 v2 —— 纯函数等价性（W6 等价性测试铺路）', () => {
    /** 全类型混合 fixture：覆盖 5 条规则 + 隐藏（通知/非通知）+ notice（bash/liveOnly）+ trigger */
    function richFixture(): Message[] {
      return [
        makeMsg({ id: 'a0', role: 'assistant', content: '首条自启' }),
        makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
        bashMsg('bash-1'),
        makeMsg({ id: 'a1b', role: 'assistant', content: 'r1b' }),
        liveWarnMsg('w1'),
        notifyMsg('n1'),
        bashMsg('bash-2'),
        makeMsg({ id: 'a2', role: 'assistant', content: '续跑结果' }),
        notifyMsg('n2'),
        notifyMsg('n3'),
        makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
        makeMsg({ id: 'h1', role: 'system', customType: 'todo-context', display: false, content: 'ctx' }),
        makeMsg({ id: 'a3', role: 'assistant', content: 'r3' }),
        makeMsg({ id: 'c1', role: 'system', content: '压缩记录' }),
        makeMsg({ id: 'a4', role: 'assistant', content: 'r4' }),
      ]
    }

    it('同一数组两次分组结果 deep-equal、输入数组不被 mutate（无模块级状态/副作用）', () => {
      const msgs = richFixture()
      const snapshot = JSON.parse(JSON.stringify(msgs))
      expect(toRenderItems(msgs)).toEqual(toRenderItems(msgs))
      // 交叉组合也稳定：forceWorking 双态各自两次调用一致
      expect(toRenderItems(msgs, true)).toEqual(toRenderItems(msgs, true))
      expect(JSON.parse(JSON.stringify(msgs))).toEqual(snapshot) // 输入不可变（纯函数）
    })

    it('richFixture 全类型行为锚定（快照式断言：turn 结构 + trigger/notice 归属）', () => {
      // [C6] w1（liveOnly）不再 inline 归 turn：u1 turn 开放期到达 → 缓冲，n1 边界开新组时
      // 落位独立 systemNotice（时序位置 = u1 turn 之后、n1 trigger turn 之前）
      const items = toRenderItems(richFixture())
      expect(items.map((i) => i.kind)).toEqual([
        'turn', // a0 自启
        'turn', // u1 锚：a1/bash-1/a1b inline（w1 已缓冲）
        'systemNotice', // w1 独立成项（缓冲在 u1 turn 关闭后落位）
        'turn', // n1 触发：bash-2 notice + a2
        'turn', // u2 锚（n2/n3 空边界折叠）：h1 透明，a3 inline
        'systemNotice', // c1 可见 system 边界
        'turn', // a4 自启
      ])
      const t2 = turnOf(items[1])
      expect(t2.assistants.map((m) => m.id)).toEqual(['a1', 'a1b'])
      expect(t2.notices?.map((m) => m.id)).toEqual(['bash-1'])
      if (items[2].kind !== 'systemNotice') throw new Error('expected systemNotice')
      expect(items[2].message.id).toBe('w1')
      const t3 = turnOf(items[3])
      expect(t3.trigger).toBe('bg-notify')
      expect(t3.assistants.map((m) => m.id)).toEqual(['a2'])
      expect(t3.notices?.map((m) => m.id)).toEqual(['bash-2'])
      const t4 = turnOf(items[4])
      expect(t4.trigger).toBeUndefined() // n2/n3 折叠，u2 开正常锚 turn
      expect(t4.assistants.map((m) => m.id)).toEqual(['a3'])
      expect(t4.notices).toBeUndefined()
      const t5 = turnOf(items[6])
      expect(t5.user).toBeNull()
      expect(t5.trigger).toBeUndefined()
    })

    it('增量版与全量版在新规则流式序列下逐步等价（notify 边界 → trigger turn → notice 追加）', () => {
      const cache = createTurnRenderCache()
      const u1 = makeMsg({ id: 'u1', role: 'user', content: 'q1' })
      const a1 = makeMsg({ id: 'a1', role: 'assistant', content: 'r1', status: 'complete' })
      const steps: Message[][] = [
        [u1],
        [u1, a1],
        // 隐藏完成通知到达 → 空 trigger turn 挂起（无渲染项产出，与全量版一致）
        [u1, a1, notifyMsg('n1')],
        // 续跑 assistant 流入 trigger turn
        [
          u1,
          a1,
          notifyMsg('n1'),
          makeMsg({ id: 'a2', role: 'assistant', content: '部分', status: 'streaming' }),
        ],
        // bash notice 追加进 trigger turn（notice 改变签名 → 末位 turn 重建）
        [
          u1,
          a1,
          notifyMsg('n1'),
          makeMsg({ id: 'a2', role: 'assistant', content: '完整', status: 'complete' }),
          bashMsg('bash-1'),
        ],
      ]
      for (const step of steps) {
        expect(toRenderItemsIncremental(step, false, cache)).toEqual(
          toRenderItems(step, false),
        )
      }
    })

    it('追加 notice 到末位 turn：签名变化重建该 turn（notices 参与增量复用键），成员消息引用保留', () => {
      const cache = createTurnRenderCache()
      const u1 = makeMsg({ id: 'u1', role: 'user' })
      const a1 = makeMsg({ id: 'a1', role: 'assistant', content: 'r' })
      const r1 = toRenderItemsIncremental([u1, a1], false, cache)
      expect(turnOf(r1[0]).notices).toBeUndefined()
      const r2 = toRenderItemsIncremental([u1, a1, bashMsg('bash-1')], false, cache)
      expect(turnOf(r2[0])).not.toBe(turnOf(r1[0])) // notice 追加 → 签名变化重建
      // 重扫路径 turn 对象新建，但成员消息引用保留（user/assistants 不换对象）
      expect(turnOf(r2[0]).user).toBe(u1)
      expect(turnOf(r2[0]).assistants[0]).toBe(a1)
      expect(turnOf(r2[0]).notices?.map((m) => m.id)).toEqual(['bash-1'])
    })
  })

  // ── 尾单元：R2 边界聚合派生视图 notifySummary（D5）────────────────────────────────
  // 覆盖五条验收（impl-plan U6）：hiddenNotifies 累积 / 缓存复用路径 / batch 展开（含 U9
  // 展平后单层）/ 「通知后无 assistant 填充」空 turn 折叠不变 / id 去重与三态判据。

  /** subagent-bg-notify 隐藏通知（details 形态自定：单条 record / {batch,items} / 缺失畸形） */
  function bgNotify(id: string, details?: Record<string, unknown>): Message {
    return makeMsg({
      id,
      role: 'system',
      customType: 'subagent-bg-notify',
      display: false,
      content: '',
      ...(details !== undefined ? { details } : {}),
    })
  }

  /** workflow-result 隐藏通知（details = notifier notifyDone 形态：runId + name + status + reason） */
  function workflowNotify(id: string, details?: Record<string, unknown>): Message {
    return makeMsg({
      id,
      role: 'system',
      customType: 'workflow-result',
      display: false,
      content: '',
      ...(details !== undefined ? { details } : {}),
    })
  }

  /** BgNotifyRecord fixture：必需字段四件套（id/status/agent/startedAt）+ 可选项 over 覆盖 */
  function bgRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
    return { id: 't1', status: 'running', agent: 'main', startedAt: 1000, ...over }
  }

  /** 单个 trigger turn（user:null + trigger:'bg-notify' + 一条 assistant 填实）的 fixture 前缀 */
  function triggerFixture(...tail: Message[]): Message[] {
    return [
      makeMsg({ id: 'u1', role: 'user', content: 'q' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r' }),
      ...tail,
    ]
  }

  describe('groupRenderInput —— R2 边界聚合派生视图 notifySummary（D5）', () => {
    it('hiddenNotifies 累积：连续两条边界折叠复用同组，聚合覆盖两条（跨消息 record 合并）', () => {
      const items = toRenderItems(
        triggerFixture(
          bgNotify('n1', bgRecord({ id: 't1', startedAt: 1000, endedAt: 2000 })),
          bgNotify('n2', bgRecord({ id: 't2', status: 'closed', closedReason: 'gc', startedAt: 3000 })),
          makeMsg({ id: 'a2', role: 'assistant', content: '续跑' }),
        ),
      )
      expect(items.map((i) => i.kind)).toEqual(['turn', 'turn'])
      const trigger = turnOf(items[1])
      expect(trigger.trigger).toBe('bg-notify')
      // 非边界 turn 不携带聚合值（undefined = 无边界语义）
      expect(turnOf(items[0]).notifySummary).toBeUndefined()
      // 两条消息各 1 record：count 2；t2 无 endedAt 不贡献耗时 → maxEnd−minStart = 2000−1000
      expect(trigger.notifySummary).toEqual({
        count: 2,
        failedCount: 0,
        neutralCount: 0,
        outcomes: ['success', 'success'],
        durationMs: 1000,
      })
    })

    it('缓存复用路径：增量路边界累积后 summary 逐步更新，每步与全量版等价（两构造点同款携带）', () => {
      const cache = createTurnRenderCache()
      const u1 = makeMsg({ id: 'u1', role: 'user', content: 'q' })
      const a1 = makeMsg({ id: 'a1', role: 'assistant', content: 'r' })
      const n1 = bgNotify('n1', bgRecord({ id: 't1', startedAt: 0, endedAt: 60_000 }))
      // 空 trigger turn 折叠：边界未被填实 → 无渲染项（summary 无处可显，语义同现状）
      const r1 = toRenderItemsIncremental([u1, a1, n1], false, cache)
      expect(r1.map((i) => i.kind)).toEqual(['turn'])
      // 追加第二条边界 + 续跑 assistant：同组累积（count 2），聚合值随增量路更新
      const n2 = bgNotify('n2', bgRecord({ id: 't2', startedAt: 0, endedAt: 120_000 }))
      const a2 = makeMsg({ id: 'a2', role: 'assistant', content: '续跑' })
      const src2 = [u1, a1, n1, n2, a2]
      const r2 = toRenderItemsIncremental(src2, false, cache)
      expect(turnOf(r2[1]).notifySummary?.count).toBe(2)
      expect(turnOf(r2[1]).notifySummary?.durationMs).toBe(120_000)
      expect(r2).toEqual(toRenderItems(src2, false))
      // assistant 填实后第三条边界到达 → 另开独立组（跨组不重复计量：两行各计 1）
      const r3 = toRenderItemsIncremental(
        [...src2, bgNotify('n3', bgRecord({ id: 't3', startedAt: 0, endedAt: 180_000 })), makeMsg({ id: 'a3', role: 'assistant', content: '再续' })],
        false,
        cache,
      )
      expect(turnOf(r3[0])).toBe(turnOf(r2[0])) // 历史 turn 引用恒等
      expect(turnOf(r3[1]).notifySummary?.count).toBe(2) // 前组聚合值不变
      expect(turnOf(r3[2]).notifySummary).toEqual({
        count: 1,
        failedCount: 0,
        neutralCount: 0,
        outcomes: ['success'],
        durationMs: 180_000,
      })
      expect(r3).toEqual(toRenderItems([...src2, bgNotify('n3', bgRecord({ id: 't3', startedAt: 0, endedAt: 180_000 })), makeMsg({ id: 'a3', role: 'assistant', content: '再续' })], false))
    })

    it('缓存复用路径：已有 trigger turn 同位置重扫时聚合值随 hiddenNotifies 重建（签名含 hiddenNotifies）', () => {
      // 序列差异只在隐藏通知条数（a2 与 user/assistants 成员引用全同）：若 hiddenNotifies 不入
      // 复用键，同位置签名会判等 → 复用陈旧 notifySummary（count 1 而非 2）。
      const cache = createTurnRenderCache()
      const u1 = makeMsg({ id: 'u1', role: 'user', content: 'q' })
      const a1 = makeMsg({ id: 'a1', role: 'assistant', content: 'r' })
      const n1 = bgNotify('n1', bgRecord({ id: 't1', startedAt: 0, endedAt: 60_000 }))
      const a2 = makeMsg({ id: 'a2', role: 'assistant', content: '续跑' })
      const r1 = toRenderItemsIncremental([u1, a1, n1, a2], false, cache)
      expect(turnOf(r1[1]).notifySummary?.count).toBe(1)
      // 同 id 序列尾追一条通知（数组长度变化 → 路径③全量重扫；同位置 turn 签名只在
      // hiddenNotifies 上不同）→ 必须重建末位 turn 并刷新聚合值
      const n2 = bgNotify('n2', bgRecord({ id: 't2', startedAt: 0, endedAt: 120_000 }))
      const src = [u1, a1, n1, n2, a2]
      const r2 = toRenderItemsIncremental(src, false, cache)
      expect(turnOf(r2[0])).toBe(turnOf(r1[0])) // 历史 turn 引用恒等
      expect(turnOf(r2[1])).not.toBe(turnOf(r1[1])) // 聚合输入变化 → 重建
      expect(turnOf(r2[1]).notifySummary).toEqual({
        count: 2,
        failedCount: 0,
        neutralCount: 0,
        outcomes: ['success', 'success'],
        durationMs: 120_000,
      })
      expect(r2).toEqual(toRenderItems(src, false))
    })

    it('batch 展开：{batch,items} 逐条计入；嵌套存量载荷成员被解析拒绝（U9 前历史数据，解析侧零改动）', () => {
      // 单条形态 → 1
      const single = toRenderItems(
        triggerFixture(bgNotify('n1', bgRecord({ id: 't1' })), makeMsg({ id: 'a2', role: 'assistant' })),
      )
      expect(turnOf(single[1]).notifySummary?.count).toBe(1)
      // 批形态（U9 展平后归单层）→ items.length 逐条计入（含批内失败）
      const batch = toRenderItems(
        triggerFixture(
          bgNotify('n1', {
            batch: true,
            items: [bgRecord({ id: 't1', status: 'done' }), bgRecord({ id: 't2', status: 'failed' })],
          }),
          makeMsg({ id: 'a2', role: 'assistant' }),
        ),
      )
      expect(turnOf(batch[1]).notifySummary).toEqual({
        count: 2,
        failedCount: 1,
        neutralCount: 0,
        outcomes: ['success', 'failed'],
      })
      // 存量嵌套载荷（U9 前落盘）：wrapper 成员被 parseSingleRecord 拒绝 → 只算合法子项
      const nested = toRenderItems(
        triggerFixture(
          bgNotify('n1', {
            batch: true,
            items: [bgRecord({ id: 't1' }), { batch: true, items: [bgRecord({ id: 't9' })] }],
          }),
          makeMsg({ id: 'a2', role: 'assistant' }),
        ),
      )
      expect(turnOf(nested[1]).notifySummary?.count).toBe(1)
      // 全 wrapper → 整条 parse null → 消息级中性（count 0，只增 neutralCount）
      const allWrapper = toRenderItems(
        triggerFixture(
          bgNotify('n1', { batch: true, items: [{ batch: true, items: [bgRecord({ id: 't9' })] }] }),
          makeMsg({ id: 'a2', role: 'assistant' }),
        ),
      )
      expect(turnOf(allWrapper[1]).notifySummary).toEqual({
        count: 0,
        failedCount: 0,
        neutralCount: 1,
        outcomes: [],
      })
    })

    it('通知后无 assistant 填充：hidden-only 组随空 turn 折叠、边界行不渲染（notifySummary 不参与折叠判定）', () => {
      const n1 = bgNotify('n1', bgRecord({ id: 't1' }))
      const n2 = bgNotify('n2', bgRecord({ id: 't2' }))
      // 数组结束：未填实 trigger turn 不产出（连两条也折叠为一、不因载体存在变成两行）
      expect(toRenderItems(triggerFixture(n1)).map((i) => i.kind)).toEqual(['turn'])
      expect(toRenderItems(triggerFixture(n1, n2)).map((i) => i.kind)).toEqual(['turn'])
      // 可见 system 边界同样关闭未填实 trigger turn（后续 assistant 自启，无 trigger）
      const sysCase = toRenderItems(triggerFixture(n1, makeMsg({ id: 'c1', role: 'system', content: '压缩记录' }), makeMsg({ id: 'a2', role: 'assistant', content: 'r2' })))
      expect(sysCase.map((i) => i.kind)).toEqual(['turn', 'systemNotice', 'turn'])
      expect(turnOf(sysCase[2]).trigger).toBeUndefined()
      // 对照：被 assistant 填实即产出边界行并携带聚合值
      const filled = toRenderItems(triggerFixture(n1, makeMsg({ id: 'a2', role: 'assistant', content: '续跑' })))
      expect(turnOf(filled[1]).notifySummary?.count).toBe(1)
    })

    it('id 去重：多轮同 id 取 round 最大者（轮终成功覆盖早轮失败）；round 缺失让位、全缺取首条', () => {
      // 多轮同 id：round1 failed + round2 成功 → 取 round 最大者（不误报失败）
      const multiRound = toRenderItems(
        triggerFixture(
          bgNotify('n1', {
            batch: true,
            items: [bgRecord({ id: 'sync-1', status: 'failed', round: 1 }), bgRecord({ id: 'sync-1', status: 'running', round: 2 })],
          }),
          makeMsg({ id: 'a2', role: 'assistant' }),
        ),
      )
      expect(turnOf(multiRound[1]).notifySummary).toEqual({
        count: 1,
        failedCount: 0,
        neutralCount: 0,
        outcomes: ['success'],
      })
      // round 缺失的失败载荷（watchdog 裸 id 形态）让位于同 id 轮终
      const legacyWatcher = toRenderItems(
        triggerFixture(
          bgNotify('n1', bgRecord({ id: 'x1', status: 'failed' })),
          bgNotify('n2', bgRecord({ id: 'x1', status: 'running', round: 1 })),
          makeMsg({ id: 'a2', role: 'assistant' }),
        ),
      )
      expect(turnOf(legacyWatcher[1]).notifySummary?.failedCount).toBe(0)
      expect(turnOf(legacyWatcher[1]).notifySummary?.outcomes).toEqual(['success'])
      // 全部无 round → 取首条（不能取末条：末条会隐藏最新失败）
      const allNoRound = toRenderItems(
        triggerFixture(
          bgNotify('n1', bgRecord({ id: 'x2', status: 'failed' })),
          bgNotify('n2', bgRecord({ id: 'x2', status: 'done' })),
          makeMsg({ id: 'a2', role: 'assistant' }),
        ),
      )
      expect(turnOf(allNoRound[1]).notifySummary?.outcomes).toEqual(['failed'])
    })

    it('判据两段式（1）：legacy status 分派——done 成功 / failed 失败 / cancelled 中性', () => {
      const items = toRenderItems(
        triggerFixture(
          bgNotify('n1', {
            batch: true,
            items: [
              bgRecord({ id: 'a', status: 'done' }),
              bgRecord({ id: 'b', status: 'failed' }),
              bgRecord({ id: 'c', status: 'cancelled' }),
            ],
          }),
          makeMsg({ id: 'a2', role: 'assistant' }),
        ),
      )
      expect(turnOf(items[1]).notifySummary).toEqual({
        count: 3,
        failedCount: 1,
        neutralCount: 1,
        outcomes: ['success', 'failed', 'neutral'],
      })
    })

    it('判据两段式（2）：running/closed 走 shared deriveClosedDisplay——cancelled 中性 / gc+error 失败 / 级联关闭成功', () => {
      const items = toRenderItems(
        triggerFixture(
          bgNotify('n1', {
            batch: true,
            items: [
              // 存量 cancelled（error 有值也判中性——与侧边栏中断灰一致，不并入失败）
              bgRecord({ id: 'cancelled-1', status: 'closed', closedReason: 'cancelled', error: 'killed by user' }),
              // gc + error → 失败
              bgRecord({ id: 'gc-1', status: 'closed', closedReason: 'gc', error: 'boom' }),
              // closedReason 缺失兜底 'gc' + error → 失败（legacy 无 closedReason 的失败终态）
              bgRecord({ id: 'legacy-fail', status: 'closed', error: 'boom' }),
              // 级联关闭 + error → 成功（parent-* 是正常关闭语义，勿回退成「error 有值即 failed」）
              bgRecord({ id: 'cascade-1', status: 'closed', closedReason: 'parent-shutdown', error: 'closed due to parent-shutdown' }),
              // 无 error 的 closed → 成功
              bgRecord({ id: 'plain', status: 'closed' }),
            ],
          }),
          makeMsg({ id: 'a2', role: 'assistant' }),
        ),
      )
      expect(turnOf(items[1]).notifySummary).toEqual({
        count: 5,
        failedCount: 2,
        neutralCount: 1,
        outcomes: ['neutral', 'failed', 'failed', 'success', 'success'],
      })
    })

    it('workflow-result：reason 三态映射 + runId 去重键 + runId 缺失落消息级中性', () => {
      const items = toRenderItems(
        triggerFixture(
          workflowNotify('w1', { runId: 'run-1', name: 'wf', status: 'done', reason: 'completed' }),
          workflowNotify('w2', { runId: 'run-2', name: 'wf', status: 'done', reason: 'aborted' }),
          workflowNotify('w3', { runId: 'run-3', name: 'wf', status: 'done', reason: 'weird-done-reason' }),
          workflowNotify('w4', { name: 'wf', status: 'done', reason: 'completed' }),
          makeMsg({ id: 'a2', role: 'assistant' }),
        ),
      )
      // runId 缺失 → 消息级 parse null：不产 record、不计入 count，只增 neutralCount
      expect(turnOf(items[1]).notifySummary).toEqual({
        count: 3,
        failedCount: 1,
        neutralCount: 2,
        outcomes: ['success', 'failed', 'neutral'],
      })
    })

    it('parse null（旧 session / 第三方写入）：不产 record、只增 neutralCount，count===0', () => {
      const items = toRenderItems(
        triggerFixture(
          bgNotify('n1'), // details 缺失
          bgNotify('n2', { id: 't1' }), // 畸形（非 {batch,items} 且必需字段缺失）
          makeMsg({ id: 'a2', role: 'assistant' }),
        ),
      )
      expect(turnOf(items[1]).notifySummary).toEqual({
        count: 0,
        failedCount: 0,
        neutralCount: 2,
        outcomes: [],
      })
    })

    it('durationMs 聚合：去重后含值记录的 max(endedAt) − min(startedAt)，混合组只由含值记录贡献', () => {
      const items = toRenderItems(
        triggerFixture(
          bgNotify('n1', {
            batch: true,
            items: [
              bgRecord({ id: 'a', startedAt: 1000, endedAt: 5000 }),
              bgRecord({ id: 'b', startedAt: 2000, endedAt: 3000 }),
              // 无 endedAt（归档/提示类不物化）→ 不计入聚合集合，仍计入 count
              bgRecord({ id: 'c', status: 'closed', startedAt: 500 }),
              // 检查：endedAt < startedAt（时钟回拨）→ 排除。该值域刻意选在「若误纳入会把
              // max(endedAt) 从 5000 抬到 6000」处，检查失效即被本断言捕获
              bgRecord({ id: 'd', startedAt: 7000, endedAt: 6000 }),
            ],
          }),
          makeMsg({ id: 'a2', role: 'assistant' }),
        ),
      )
      // max(endedAt)=5000 − min(startedAt)=1000（来自含值记录本身，非全体 count）
      expect(turnOf(items[1]).notifySummary).toEqual({
        count: 4,
        failedCount: 0,
        neutralCount: 0,
        outcomes: ['success', 'success', 'success', 'success'],
        durationMs: 4000,
      })
    })

    it('durationMs 全无含值记录 → 不写入该字段（不显耗时；workflow 无时间字段同落此档）', () => {
      const items = toRenderItems(
        triggerFixture(
          workflowNotify('w1', { runId: 'run-1', reason: 'completed' }),
          bgNotify('n2', bgRecord({ id: 't2', status: 'closed' })),
          makeMsg({ id: 'a2', role: 'assistant' }),
        ),
      )
      expect(turnOf(items[1]).notifySummary?.durationMs).toBeUndefined()
      expect(turnOf(items[1]).notifySummary?.count).toBe(2)
    })
  })

  // ── 尾部快路径（D-4 三条路径演进：形态①同长度仅末条替换 / ②尾部 append / ③全量兜底）──
  // 正确性锚：任何路径产出与全量路径 deepEqual（既有等价断言形态，新路径同覆盖）。

  describe('toRenderItemsIncremental —— ⑥ 尾部快路径形态①（同长度仅末条替换，streaming 合帧 commit）', () => {
    it('末条 assistant 不可变替换：历史 turn toBe 恒等、末位 turn 重建，输出与全量版 deepEqual', () => {
      const cache = createTurnRenderCache()
      const u1 = makeMsg({ id: 'u1', role: 'user', content: 'q1' })
      const a1 = makeMsg({ id: 'a1', role: 'assistant', content: 'r1' })
      const u2 = makeMsg({ id: 'u2', role: 'user', content: 'q2' })
      const a2v1 = makeMsg({ id: 'a2', role: 'assistant', content: '部分', status: 'streaming' })
      const r1 = toRenderItemsIncremental([u1, a1, u2, a2v1], false, cache)
      // delta-coalescer 合帧 commit：末条 token 推进 = 新对象替换（D-1 不可变语义）
      const a2v2 = makeMsg({ id: 'a2', role: 'assistant', content: '部分回复', status: 'streaming' })
      const src = [u1, a1, u2, a2v2]
      const r2 = toRenderItemsIncremental(src, false, cache)
      expect(turnOf(r2[0])).toBe(turnOf(r1[0])) // 历史 turn 引用恒等（子重跑起点之前的零重算）
      expect(turnOf(r2[1])).not.toBe(turnOf(r1[1])) // 末位 turn 重建（末位成员引用变化）
      expect(turnOf(r2[1]).user).toBe(u2) // 重建但成员引用保留
      expect(turnOf(r2[1]).assistants[0].content).toBe('部分回复')
      expect(turnOf(r2[1]).isStreaming).toBe(true)
      expect(r2).toEqual(toRenderItems(src, false)) // 正确性锚：deepEqual 全量路径
    })

    it('恒等特例：末条替换为透明消息（display:false 非通知 / 隐藏完成通知折叠）→ 引用恒等复用', () => {
      const cache = createTurnRenderCache()
      const u1 = makeMsg({ id: 'u1', role: 'user', content: 'q' })
      const a1 = makeMsg({ id: 'a1', role: 'assistant', content: 'r1' })
      const h1 = makeMsg({ id: 'h1', role: 'system', customType: 'todo-context', display: false, content: 'ctx' })
      const r1 = toRenderItemsIncremental([u1, a1, h1], false, cache)
      // 末条透明消息换成另一条透明消息（引用不同、产出不变）
      const h1b = makeMsg({ id: 'h1', role: 'system', customType: 'todo-context', display: false, content: 'ctx' })
      const src = [u1, a1, h1b]
      const r2 = toRenderItemsIncremental(src, false, cache)
      expect(r2).toBe(r1) // 引用恒等（零重算承诺）
      expect(r2).toEqual(toRenderItems(src, false))
      // 隐藏完成通知同长度替换：空 trigger turn 数组末折叠，产出不变 → 恒等
      const cache2 = createTurnRenderCache()
      const n1 = notifyMsg('n1')
      const r3 = toRenderItemsIncremental([u1, a1, n1], false, cache2)
      const r4 = toRenderItemsIncremental([u1, a1, notifyMsg('n1')], false, cache2)
      expect(r4).toBe(r3)
      expect(r4).toEqual(toRenderItems([u1, a1, notifyMsg('n1')], false))
    })

    it('防御形态：末条从 assistant 换成可见 system（turn 项 → static 项结构变化）与全量版 deepEqual', () => {
      const cache = createTurnRenderCache()
      const u1 = makeMsg({ id: 'u1', role: 'user', content: 'q' })
      const a1 = makeMsg({ id: 'a1', role: 'assistant', content: 'r1' })
      const a2 = makeMsg({ id: 'a2', role: 'assistant', content: 'r2' })
      const r1 = toRenderItemsIncremental([u1, a1, a2], false, cache)
      expect(r1.map((i) => i.kind)).toEqual(['turn'])
      const c1 = makeMsg({ id: 'c1', role: 'system', content: '压缩记录' })
      const src = [u1, a1, c1]
      const r2 = toRenderItemsIncremental(src, false, cache)
      expect(r2.map((i) => i.kind)).toEqual(['turn', 'systemNotice'])
      expect(turnOf(r2[0]).assistants.map((m) => m.id)).toEqual(['a1'])
      expect(r2).toEqual(toRenderItems(src, false))
    })
  })

  describe('toRenderItemsIncremental —— ⑥ 尾部快路径形态②（尾部 append）', () => {
    it('连续两次 append 归既有末位 turn：每步 deepEqual、user/assistants 成员引用保留', () => {
      const cache = createTurnRenderCache()
      const u1 = makeMsg({ id: 'u1', role: 'user', content: 'q' })
      const r1 = toRenderItemsIncremental([u1], false, cache)
      const a1 = makeMsg({ id: 'a1', role: 'assistant', content: 'r1' })
      const s2 = [u1, a1]
      const r2 = toRenderItemsIncremental(s2, false, cache)
      const a2 = makeMsg({ id: 'a2', role: 'assistant', content: 'r2' })
      const s3 = [u1, a1, a2]
      const r3 = toRenderItemsIncremental(s3, false, cache)
      expect(turnOf(r2[0])).not.toBe(turnOf(r1[0])) // 签名 [u1] → [u1,a1] 重建
      expect(turnOf(r3[0])).not.toBe(turnOf(r2[0])) // 第二次 append 续建同 turn
      expect(turnOf(r3[0]).user).toBe(u1) // 成员引用保留
      expect(turnOf(r3[0]).assistants[0]).toBe(a1)
      expect(turnOf(r3[0]).assistants.map((m) => m.id)).toEqual(['a1', 'a2'])
      expect(r2).toEqual(toRenderItems(s2, false))
      expect(r3).toEqual(toRenderItems(s3, false))
    })

    it('append bash notice 进末位 turn（notices 参与签名）+ 连续 notice 到达：deepEqual、notices 序正确', () => {
      const cache = createTurnRenderCache()
      const u1 = makeMsg({ id: 'u1', role: 'user', content: 'q' })
      const a1 = makeMsg({ id: 'a1', role: 'assistant', content: 'r1' })
      const r1 = toRenderItemsIncremental([u1, a1], false, cache)
      const b1 = bashMsg('bash-1')
      const s2 = [u1, a1, b1]
      const r2 = toRenderItemsIncremental(s2, false, cache)
      expect(r2.map((i) => i.kind)).toEqual(['turn']) // notice 不出独立项
      expect(turnOf(r2[0])).not.toBe(turnOf(r1[0]))
      expect(turnOf(r2[0]).user).toBe(u1)
      expect(turnOf(r2[0]).assistants[0]).toBe(a1)
      expect(turnOf(r2[0]).notices?.map((m) => m.id)).toEqual(['bash-1'])
      expect(r2).toEqual(toRenderItems(s2, false))
      // [C6] liveOnly 到达：不再 inline 进 notices（签名不变 → 末位 turn 引用恒等复用），
      // 走独立 systemNotice 项（数组结束 closeTurn 后缓冲落位）
      const w1 = liveWarnMsg('w1')
      const s3 = [u1, a1, b1, w1]
      const r3 = toRenderItemsIncremental(s3, false, cache)
      expect(turnOf(r3[0]).notices?.map((m) => m.id)).toEqual(['bash-1'])
      expect(turnOf(r3[0])).toBe(turnOf(r2[0])) // liveOnly 不改 turn 签名 → 零 churn 复用
      expect(r3).toEqual(toRenderItems(s3, false))
      expect(r3.map((i) => i.kind)).toEqual(['turn', 'systemNotice'])
    })

    it('append 挂起空 trigger turn 被新消息填实：trigger turn 产出正确，前位 turn 引用复用', () => {
      const cache = createTurnRenderCache()
      const u1 = makeMsg({ id: 'u1', role: 'user', content: 'q' })
      const a1 = makeMsg({ id: 'a1', role: 'assistant', content: 'r1' })
      const n1 = notifyMsg('n1')
      // 数组末空 trigger turn 折叠 → 产出仅前位 turn
      const r1 = toRenderItemsIncremental([u1, a1, n1], false, cache)
      expect(r1.map((i) => i.kind)).toEqual(['turn'])
      // append 续跑 assistant 填实 trigger turn（子重跑起点 = 前位 turn 起始下标 0）
      const a2 = makeMsg({ id: 'a2', role: 'assistant', content: '续跑', status: 'streaming' })
      const src = [u1, a1, n1, a2]
      const r2 = toRenderItemsIncremental(src, false, cache)
      expect(r2.map((i) => i.kind)).toEqual(['turn', 'turn'])
      expect(turnOf(r2[0])).toBe(turnOf(r1[0])) // 前位 turn 引用恒等
      expect(turnOf(r2[1]).trigger).toBe('bg-notify')
      expect(turnOf(r2[1]).assistants.map((m) => m.id)).toEqual(['a2'])
      expect(r2).toEqual(toRenderItems(src, false))
    })
  })

  describe('toRenderItemsIncremental —— ⑥ 全量兜底路径③（前插 / 引用全变等低频形态）', () => {
    it('前插（prefix 断裂）走全量路径：输出与全量版 deepEqual，同位置 turn 按现状签名对齐复用', () => {
      const cache = createTurnRenderCache()
      const u1 = makeMsg({ id: 'u1', role: 'user', content: 'q1' })
      const a1 = makeMsg({ id: 'a1', role: 'assistant', content: 'r1' })
      const r1 = toRenderItemsIncremental([u1, a1], false, cache)
      // 头部前插可见 system：prefix 第 0 位断裂 → 不满足尾部快路径前置 → 路径③
      const sys0 = makeMsg({ id: 'sys0', role: 'system', content: 'notice' })
      const src = [sys0, u1, a1]
      const r2 = toRenderItemsIncremental(src, false, cache)
      expect(r2.map((i) => i.kind)).toEqual(['systemNotice', 'turn'])
      // turn 组在新旧产出同为位置 0、签名 [u1,a1] 对齐 → 路径③现状语义复用对象
      expect(turnOf(r2[1])).toBe(turnOf(r1[0]))
      expect(turnOf(r2[1]).index).toBe(1)
      expect(turnOf(r2[1]).user).toBe(u1)
      expect(r2).toEqual(toRenderItems(src, false))
    })

    it('同长度引用全变（prefix 断裂）走全量路径：输出与全量版 deepEqual', () => {
      const cache = createTurnRenderCache()
      const r1 = toRenderItemsIncremental(
        [makeMsg({ id: 'u1', role: 'user', content: 'q' }), makeMsg({ id: 'a1', role: 'assistant', content: 'r' })],
        false,
        cache,
      )
      // 同 id 全新对象（fork/replay 形态）：长度相等但前缀引用断裂 → 路径③
      const src = [
        makeMsg({ id: 'u1', role: 'user', content: 'q' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r' }),
      ]
      const r2 = toRenderItemsIncremental(src, false, cache)
      expect(r2).not.toBe(r1)
      expect(turnOf(r2[0])).not.toBe(turnOf(r1[0]))
      expect(r2).toEqual(toRenderItems(src, false))
      expect(r2).toEqual(r1) // 内容等价（引用相等 = 内容相等，同 id 同内容）
    })

    it('长会话高频形态串联（turn 前缀 + ① + ② + ③ 混合序列）：每步与全量版 deepEqual', () => {
      const cache = createTurnRenderCache()
      const u1 = makeMsg({ id: 'u1', role: 'user', content: 'q1' })
      const a1 = makeMsg({ id: 'a1', role: 'assistant', content: 'r1' })
      const u2 = makeMsg({ id: 'u2', role: 'user', content: 'q2' })
      const a2v1 = makeMsg({ id: 'a2', role: 'assistant', content: '部分', status: 'streaming' })
      const base = [u1, a1, u2, a2v1]
      const r1 = toRenderItemsIncremental(base, false, cache)
      expect(r1.map((i) => i.kind)).toEqual(['turn', 'turn'])
      const steps: Message[][] = [
        // ① 合帧 commit：末条 token 推进（×2 轮）
        [u1, a1, u2, makeMsg({ id: 'a2', role: 'assistant', content: '部分回复', status: 'streaming' })],
        [u1, a1, u2, makeMsg({ id: 'a2', role: 'assistant', content: '完整回复', status: 'complete' })],
        // ② append bash notice 进末位 turn
        [u1, a1, u2, makeMsg({ id: 'a2', role: 'assistant', content: '完整回复', status: 'complete' }), bashMsg('bash-1')],
        // ② append 新 user turn（末位地位转移：旧末位 isStreaming 校正）
        [
          u1,
          a1,
          u2,
          makeMsg({ id: 'a2', role: 'assistant', content: '完整回复', status: 'complete' }),
          bashMsg('bash-1'),
          makeMsg({ id: 'u3', role: 'user', content: 'q3' }),
          makeMsg({ id: 'a3', role: 'assistant', content: 'r3', status: 'streaming' }),
        ],
        // ③ 中删末位 turn（prefix 前缀相等但长度缩短 → 路径③）
        [u1, a1, u2, makeMsg({ id: 'a2', role: 'assistant', content: '完整回复', status: 'complete' }), bashMsg('bash-1')],
      ]
      for (const step of steps) {
        const next = toRenderItemsIncremental(step, false, cache)
        expect(next).toEqual(toRenderItems(step, false)) // 每步正确性锚
      }
      // 串联末态：前位 turn（u1/a1）跨全程引用恒等（尾部路径零重算承诺）
      const last = toRenderItemsIncremental(steps[steps.length - 1], false, cache)
      expect(turnOf(last[0])).toBe(turnOf(r1[0]))
    })
  })

  // ── 规则 5 收纳分支
  // background-bash 结构化完成通知：宿主响应轮出现即附着 foldedNotices（settle 后收进轮头行，
  // 渲染层形态切换），无宿主轮（user / 其余可见 system / 数组结束）落位独立 static 外部行。

  /** background-bash 结构化完成通知（可见 system 消息，details 经 shared 解析器命中） */
  function bgBashDoneMsg(id: string, exitCode = 0): Message {
    return makeMsg({
      id,
      role: 'system',
      content: `后台命令已完成（exit ${exitCode}）`,
      details: {
        taskId: `task-${id}`,
        command: `cmd-${id}`,
        durationMs: 1500,
        endReason: 'natural',
        exitCode,
      },
    })
  }

  describe('groupRenderInput 分组规则 v2 —— 规则 5 收纳分支', () => {
    it('bash 通知 → assistant：附着续跑 turn（foldedNotices 到达序），不产外部行', () => {
      const items = toRenderItems([
        makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
        bgBashDoneMsg('b1'),
        makeMsg({ id: 'a2', role: 'assistant', content: '续跑' }),
      ])
      // 无 static 项：bash 行被宿主轮收纳，流内只剩两个 turn
      expect(items).toHaveLength(2)
      const host = turnOf(items[1])
      expect(host.user).toBeNull()
      expect(host.assistants.map((m) => m.id)).toEqual(['a2'])
      expect(host.foldedNotices?.map((m) => m.id)).toEqual(['b1'])
      // 收纳通知构成展开入口（无 thinking/toolCall 块也可展开看明细）
      expect(host.hasFoldable).toBe(true)
    })

    it('bash 通知 → user（空闲到达）：落位独立 static 外部行（边界 1，不收纳）', () => {
      const items = toRenderItems([
        makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
        bgBashDoneMsg('b1'),
        makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
      ])
      const t2 = expectBashAsStaticNotice(items, 'u2')
      expect(t2.foldedNotices).toBeUndefined()
    })

    it('bash 通知 → 数组结束（agent 空闲）：static 外部行（不丢消息）', () => {
      const items = toRenderItems([
        makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
        bgBashDoneMsg('b1'),
      ])
      expect(items).toHaveLength(2)
      expect(items[1]).toEqual({ kind: 'systemNotice', message: expect.objectContaining({ id: 'b1' }) })
    })

    it('bash → 隐藏通知 → assistant：同一 trigger turn 收纳两类，foldedNotices 保持到达序', () => {
      const items = toRenderItems([...bashThenNotifyPrefix(), makeMsg({ id: 'a2', role: 'assistant', content: '续跑' })])
      expect(items).toHaveLength(2)
      const t2 = turnOf(items[1])
      expect(t2.trigger).toBe('bg-notify')
      expect(t2.foldedNotices?.map((m) => m.id)).toEqual(['b1', 'n1'])
      // 聚合轴只消费隐藏通知（bash 载荷不混入——混入会推高 neutralCount）
      expect(t2.notifySummary?.count).toBe(0)
      expect(t2.notifySummary?.neutralCount).toBe(1)
    })

    it('trigger turn 已开（未填实）时 bash 直接着附（同批完成收敛同一宿主轮）', () => {
      const items = toRenderItems([
        makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
        notifyMsg('n1', 'workflow-result'),
        bgBashDoneMsg('b1'),
        makeMsg({ id: 'a2', role: 'assistant', content: '续跑' }),
      ])
      const t2 = turnOf(items[1])
      expect(t2.trigger).toBe('bg-notify')
      expect(t2.foldedNotices?.map((m) => m.id)).toEqual(['n1', 'b1'])
    })

    it('未填实 trigger turn 携带 bash 附着被折叠时：bash 落位 static 外部行（隐藏本体保持不渲染）', () => {
      const items = toRenderItems([
        ...bashThenNotifyPrefix(),
        // 无 assistant 填实 → trigger turn 折叠，bash 行不能静默消失
        makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
      ])
      expectBashAsStaticNotice(items, 'u2')
    })

    it('增量路径等价：bash 折叠场景 toRenderItemsIncremental ≡ toRenderItems', () => {
      const msgs: Message[] = [
        makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
        bgBashDoneMsg('b1'),
        notifyMsg('n1', 'subagent-bg-notify'),
        makeMsg({ id: 'a2', role: 'assistant', content: '续跑' }),
        bgBashDoneMsg('b2', 2),
        makeMsg({ id: 'a3', role: 'assistant', content: '续跑 2' }),
      ]
      const cache = createTurnRenderCache()
      // 逐步追加重放（覆盖快路径 / 尾部路径 / 全量重扫三条路径）
      let last: RenderItem[] = []
      for (let i = 1; i <= msgs.length; i++) {
        last = toRenderItemsIncremental(msgs.slice(0, i), false, cache)
        expect(last).toEqual(toRenderItems(msgs.slice(0, i), false))
      }
      const t3 = turnOf(last[2])
      expect(t3.foldedNotices?.map((m) => m.id)).toEqual(['b2'])
    })
  })

  describe('handoff 指令锚（chat-flow-consistency U9/S2）—— 增量尾部快路径等价', () => {
    /** 交接指令提示行（runtime entry 转换产物形态：system 行携带 handoffInstruction 字段，
   *  判据 SSOT = isHandoffInstructionNotice 只认字段）。 */
    function handoffNotice(id: string): Message {
      return makeMsg({ id, role: 'system', content: '交接指令提示行', handoffInstruction: { text: 'HANDOFF_PROMPT' } })
    }

    it('handoffInstruction 锚开 turn：锚位进 turnStartOffsets，尾部 append 经快路径与全量 deep-equal', () => {
      const cache = createTurnRenderCache()
      // 前缀：普通 turn + handoff 指令行（锚自开新 turn——规则 1 同款分支）
      let msgs: Message[] = [
        makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
        handoffNotice('h1'),
      ]
      let items = toRenderItemsIncremental(msgs, false, cache)
      // 锚与 user 共用规则 1 分支：组起始下标即锚位（2），归零不变量成立
      expect(cache.turnStartOffsets).toEqual([0, 2])
      expect(turnOf(items[items.length - 1]).user?.id).toBe('h1')
      const turn1 = items[0]

      // 尾部 append 交接文档 assistant：快路径从锚位重建，产出与全量分组 deep-equal
      msgs = [...msgs, makeMsg({ id: 'a2', role: 'assistant', content: '# 交接文档', status: 'streaming' })]
      items = toRenderItemsIncremental(msgs, false, cache)
      // 前位 turn 对象引用恒等 = 尾部快路径真实执行（全量重扫会重建对象、引用不同）
      expect(items[0]).toBe(turn1)
      expect(items).toEqual(toRenderItems(msgs, false))
      const docTurn = turnOf(items[items.length - 1])
      expect(docTurn.user?.id).toBe('h1')
      expect(docTurn.assistants.map((m) => m.id)).toEqual(['a2'])

      // 锚 turn 关闭后 append 普通 user turn：快路径继续等价
      msgs = [...msgs, makeMsg({ id: 'u2', role: 'user', content: 'q2' })]
      items = toRenderItemsIncremental(msgs, false, cache)
      expect(items[0]).toBe(turn1)
      expect(items).toEqual(toRenderItems(msgs, false))
      expect(turnOf(items[items.length - 1]).user?.id).toBe('u2')
    })
  })
});

// ======== 来源：use-session-scoped-state.test.ts ========
describe("use-session-scoped-state [src/foundation/__tests__]", () => {
  /** 在独立 effectScope 内运行 composable，测试后 dispose 模拟卸载（既有测试同款 harness） */
  function runWithScope<T>(fn: () => T): { result: T; dispose: () => void } {
    const scope = effectScope()
    let result!: T
    scope.run(() => {
      result = fn()
    })
    return { result, dispose: () => scope.stop() }
  }

  describe('U6 hasPartition: 只读分区存在性查询', () => {
    it('分区未建立 → false；经 updateFor 写入建立后 → true', () => {
      const { result } = runWithScope(() =>
        useSessionScopedState(ref<string | null>('A'), () => ({ v: 0 })),
      )

      expect(result.hasPartition('A')).toBe(false)
      result.updateFor('A', (s) => { s.v = 1 })
      expect(result.hasPartition('A')).toBe(true)
    })

    it('current 读取建立的分区同样计数（同一份分区表，无第二口径）', () => {
      const { result } = runWithScope(() =>
        useSessionScopedState(ref<string | null>('read-sid'), () => ({ v: 0 })),
      )

      expect(result.hasPartition('read-sid')).toBe(false)
      void result.current.value
      expect(result.hasPartition('read-sid')).toBe(true)
    })

    it('只读零副作用：对不存在 sid 查询不惰性建分区（init 不被调）', () => {
      const init = vi.fn(() => ({ v: 0 }))
      const { result } = runWithScope(() =>
        useSessionScopedState(ref<string | null>(null), init),
      )

      expect(result.hasPartition('ghost')).toBe(false)
      expect(result.hasPartition('another-ghost')).toBe(false)
      expect(init).not.toHaveBeenCalled()
    })

    it('cleanup 后 → false；同 sid 重建（current 读出列）后 → true（生命周期与分区表同步）', () => {
      const { result } = runWithScope(() =>
        useSessionScopedState(ref<string | null>('cycle'), () => ({ v: 0 })),
      )

      result.updateFor('cycle', (s) => { s.v = 1 })
      expect(result.hasPartition('cycle')).toBe(true)

      result.cleanup('cycle')
      expect(result.hasPartition('cycle')).toBe(false)

      void result.current.value // current 路径重建（出列点）
      expect(result.hasPartition('cycle')).toBe(true)
    })

    it('先查后清范式（resetFor 前置检查语义）：查询为 false 时跳过写入则不建分区', () => {
      const init = vi.fn(() => ({ v: 0 }))
      const { result } = runWithScope(() =>
        useSessionScopedState(ref<string | null>(null), init),
      )

      // resetFor 的实现形态：hasPartition 前置检查 + 条件写入——对不存在的分区整体跳过
      if (result.hasPartition('no-reset-target')) {
        result.updateFor('no-reset-target', (s) => { s.v = 99 })
      }
      expect(init).not.toHaveBeenCalled() // 清理动作未制造常驻空分区
      expect(result.hasPartition('no-reset-target')).toBe(false)
    })
  })
});

// ======== 来源：use-session-scoped-state.test.ts ========
describe("use-session-scoped-state [src/foundation]", () => {
  /** census 脚本（无类型 .mjs）的类型边界：扫描根相对路径 → 非测试调用点次数 */
  type CensusCallSites = Record<string, number>
  const collectCensusCallSites = collectCallSites as (rootDir?: string) => CensusCallSites
  const censusDiffToSnapshot = compareCensusToSnapshot as (actual: CensusCallSites) => string[] | null
  const censusSnapshot = CENSUS_SNAPSHOT as CensusCallSites

  // 模块级 cleanup registry 跨测试可能残留（未包 effectScope 的用例无法触发反注册），
  // 每个用例前清空，防污染下游断言
  beforeEach(() => {
    __clearSessionCleanupRegistryForTest()
  })

  describe('W1 useSessionScopedState: Map 分区工厂', () => {
    /** 在独立 effectScope 内运行 composable，测试后 dispose 模拟卸载 */
    function runWithScope<T>(fn: () => T): { result: T; dispose: () => void } {
      const scope = effectScope()
      let result!: T
      scope.run(() => {
        result = fn()
      })
      return { result, dispose: () => scope.stop() }
    }

    it('新 sid 惰性 init：init() 对同一 sid 仅调用一次', () => {
      const init = vi.fn(() => ({ count: 0 }))
      const sid = ref<string | null>('sessionA')
      const { result } = runWithScope(() => useSessionScopedState(sid, init))

      // 首次 current 触发 init
      expect(result.current.value).toEqual({ count: 0 })
      expect(init).toHaveBeenCalledTimes(1)

      // 再次访问 current 不重复 init
      expect(result.current.value).toEqual({ count: 0 })
      expect(init).toHaveBeenCalledTimes(1)

      // update 操作不触发 init
      result.update((s) => { s.count += 1 })
      expect(init).toHaveBeenCalledTimes(1)
      expect(result.current.value).toEqual({ count: 1 })
    })

    it('current 按当前 sid 查分区', () => {
      const sid = ref<string | null>('a')
      const { result } = runWithScope(() => useSessionScopedState(sid, () => ({ tag: '' })))

      result.update((s) => { s.tag = 'a-value' })
      expect(result.current.value.tag).toBe('a-value')

      // 切到 b：current 切到 b 分区（初始值）
      sid.value = 'b'
      expect(result.current.value.tag).toBe('')
    })

    it('update(updater) 操作当前分区，不影响其他 session 分区', () => {
      const sid = ref<string | null>('a')
      const { result } = runWithScope(() => useSessionScopedState(sid, () => ({ v: 0 })))

      result.update((s) => { s.v = 10 })
      // 切到 b 单独 update
      sid.value = 'b'
      result.update((s) => { s.v = 99 })

      // 切回 a：a 分区数据保留
      sid.value = 'a'
      expect(result.current.value.v).toBe(10)

      // b 分区数据保留
      sid.value = 'b'
      expect(result.current.value.v).toBe(99)
    })

    it('updateFor(targetSid, updater) 显式指定分区，不读 sid.value 实时值（M1 竞态防护）', () => {
      // 场景：WS handler 闭包捕获订阅时 sid='A'，切到 B 后旧消息到达。
      // updateFor(A, ...) 写 A 分区，不污染 B（即使 sid.value 已是 B）
      const sid = ref<string | null>('A')
      const { result } = runWithScope(() => useSessionScopedState(sid, () => ({ v: 0 })))

      // 模拟切到 B（sid.value 变为 B）
      sid.value = 'B'

      // 此时模拟 A 的迟到 WS 消息：handler 闭包捕获的 sid 仍是 A，调 updateFor('A', ...)
      result.updateFor('A', (s) => { s.v = 42 })

      // A 分区被写入（迟到消息落地到它所属的 session）
      sid.value = 'A'
      expect(result.current.value.v).toBe(42)

      // B 分区不受污染
      sid.value = 'B'
      expect(result.current.value.v).toBe(0)
    })

    it('updateFor 对比 update：update 读实时 sid.value，updateFor 读参数（竞态场景差异）', () => {
      const sid = ref<string | null>('A')
      const { result } = runWithScope(() => useSessionScopedState(sid, () => ({ v: 0 })))

      sid.value = 'B'  // 模拟切到 B

      // update（读实时值 B）：写入 B 分区
      result.update((s) => { s.v = 10 })
      // updateFor(A)（读参数 A）：写入 A 分区
      result.updateFor('A', (s) => { s.v = 20 })

      sid.value = 'A'
      expect(result.current.value.v).toBe(20)  // A 分区
      sid.value = 'B'
      expect(result.current.value.v).toBe(10)  // B 分区
    })

    it('cleanup(sid) 从 Map 移除指定分区（下次访问重新 init）', () => {
      const init = vi.fn(() => ({ n: 0 }))
      const sid = ref<string | null>('a')
      const { result } = runWithScope(() => useSessionScopedState(sid, init))

      result.update((s) => { s.n = 42 })
      expect(init).toHaveBeenCalledTimes(1)

      // cleanup a
      result.cleanup('a')
      expect(init).toHaveBeenCalledTimes(1)

      // 再次访问 a → 重新 init，状态重置
      expect(result.current.value).toEqual({ n: 0 })
      expect(init).toHaveBeenCalledTimes(2)
    })

    it('D-B2-1：cleanup 后 updateFor 对已删分区 no-op（迟到写不复活分区）', () => {
      const init = vi.fn(() => ({ v: 0 }))
      const sid = ref<string | null>('late-write')
      const { result } = runWithScope(() => useSessionScopedState(sid, init))

      void result.current.value // 建立 'late-write' 分区
      result.update((s) => { s.v = 42 })
      expect(init).toHaveBeenCalledTimes(1)

      // session 销毁（cleanup：分区删除 + deletedSids 记入）后，迟到的 RPC resolve /
      // 广播经 updateFor 到达：拦截 no-op，不重建分区、不写入
      result.cleanup('late-write')
      result.updateFor('late-write', (s) => { s.v = 99 })
      expect(init).toHaveBeenCalledTimes(1) // updateFor 未触发分区重建

      // 佐证迟到写未落地：current 路径读分区 = 重建点，新实例从初始值开始（而非 99）
      expect(result.current.value.v).toBe(0)
      expect(init).toHaveBeenCalledTimes(2)
    })

    it('D-B2-1 出列规则锚：cleanup 后经 current 重新 init，updateFor 恢复写入落新分区', () => {
      const sid = ref<string | null>('reborn')
      const { result } = runWithScope(() => useSessionScopedState(sid, () => ({ v: 0 })))

      void result.current.value
      result.update((s) => { s.v = 1 })
      result.cleanup('reborn')

      // 重建点即出列点：current 路径重新 init（update 路径共享 getOrCreatePartition 单点，
      // 出列行为同构），同 sid 删除后重建（重导入等边缘形态）进入新生命周期
      expect(result.current.value.v).toBe(0)

      // 出列后 updateFor 恢复写入：删后同 id 重建不丢写
      result.updateFor('reborn', (s) => { s.v = 42 })
      expect(result.current.value.v).toBe(42)
    })

    it('D-B2-1 口径延伸 isDeleted：与 updateFor 拦截同生命周期（cleanup 置 true / 重建出列复位 false / 未删恒 false）', () => {
      const sid = ref<string | null>('aux-map')
      const { result } = runWithScope(() => useSessionScopedState(sid, () => ({ v: 0 })))

      // 未删分区（含从未建立过分区的 sid）→ false：辅助表写入点照常放行
      expect(result.isDeleted('aux-map')).toBe(false)
      expect(result.isDeleted('never-created')).toBe(false)

      // cleanup（session 销毁）→ true：分区外辅助表的迟到写检查生效（与 updateFor 拦截同源）
      result.cleanup('aux-map')
      expect(result.isDeleted('aux-map')).toBe(true)

      // 分区重建（同 id 新生命周期，重导入等边缘形态）→ 出列复位 false：辅助表恢复写入，
      // 与 updateFor 的「删后同 id 重建不丢写」语义一致（自建登记无此出列，会永久误拦）
      void result.current.value
      expect(result.isDeleted('aux-map')).toBe(false)
    })

    it('切 sid 不丢旧数据，切回恢复（AC-2 隐含契约）', () => {
      const sid = ref<string | null>('a')
      const { result } = runWithScope(() => useSessionScopedState(sid, () => ({ items: [] as string[] })))

      result.update((s) => { s.items.push('a-1') })
      // 切到 b 并写入
      sid.value = 'b'
      result.update((s) => { s.items.push('b-1') })

      // 切回 a：items 仍含 a-1（无丢失）
      sid.value = 'a'
      expect(result.current.value.items).toEqual(['a-1'])
    })

    it('大量 sid 创建后 Map 分区可被 cleanup 回收（防内存泄漏）', () => {
      const sid = ref<string | null>('init-sid')
      const { result } = runWithScope(() => useSessionScopedState(sid, () => ({ v: 0 })))

      // 创建 100 个 sid 分区
      for (let i = 0; i < 100; i++) {
        sid.value = `session-${i}`
        result.update((s) => { s.v = i })
      }

      // 逐个 cleanup
      for (let i = 0; i < 100; i++) {
        result.cleanup(`session-${i}`)
      }

      // cleanup 后访问已 cleanup 的 sid 应重新 init（v 回到 0），
      // 证明 Map 不持有旧分区引用
      sid.value = 'session-0'
      expect(result.current.value.v).toBe(0) // 重新 init

      // cleanup 不存在的 sid 不抛错
      expect(() => result.cleanup('nonexistent')).not.toThrow()
    })

    it('null sid 时 current 返回 init() 默认实例但不写入 Map', () => {
      const init = vi.fn(() => ({ x: 'default' }))
      const sid = ref<string | null>(null)
      const { result } = runWithScope(() => useSessionScopedState(sid, init))

      // null sid 时访问 current 返回默认实例
      expect(result.current.value).toEqual({ x: 'default' })
      // init 被调（生成默认实例），但 null 不应作为 key 污染 Map：
      // 切到真实 sid 时，之前对 null current 的修改不应泄漏到该 session
      sid.value = 'real'
      expect(result.current.value).toEqual({ x: 'default' })

      // 切回 null 再切回 real：real 分区数据应保留（不被 null 访问覆盖）
      sid.value = null
      sid.value = 'real'
      expect(result.current.value).toEqual({ x: 'default' })

      // 给 real 写入，切到 null，再切回 real：real 数据仍在（null 不污染 real 分区）
      result.update((s) => { s.x = 'mutated' })
      sid.value = null
      expect(result.current.value).toEqual({ x: 'default' }) // null 给默认
      sid.value = 'real'
      expect(result.current.value.x).toBe('mutated') // real 分区保留
    })
  })

  describe('W1 registerSessionCleanup / triggerSessionCleanups 注册机制', () => {
    it('registerSessionCleanup 注册的 cleanup 被 triggerSessionCleanups(sid) 调用', () => {
      const fn = vi.fn()
      registerSessionCleanup(fn)

      triggerSessionCleanups('sessionX')
      expect(fn).toHaveBeenCalledWith('sessionX')
    })

    it('多个 composable 注册的 cleanup 都被调用（AC-8）', () => {
      const fn1 = vi.fn()
      const fn2 = vi.fn()
      const fn3 = vi.fn()
      registerSessionCleanup(fn1)
      registerSessionCleanup(fn2)
      registerSessionCleanup(fn3)

      triggerSessionCleanups('multi')
      expect(fn1).toHaveBeenCalledWith('multi')
      expect(fn2).toHaveBeenCalledWith('multi')
      expect(fn3).toHaveBeenCalledWith('multi')
    })

    it('composable onUnmounted 时反注册自己的 cleanup（不残留）', async () => {
      const fn = vi.fn()
      const scope = effectScope()
      scope.run(() => {
        const sid = ref<string | null>('a')
        useSessionScopedState(sid, () => ({ v: 0 }))
        registerSessionCleanup(fn)
        // useSessionScopedState 应在 setup 时注册，onUnmounted 时反注册
        // 此处显式 register 模拟另一 composable 的注册路径，验证反注册不被该机制破坏
      })

      scope.stop()
      await nextTick()

      // 卸载后 trigger 不应调用已反注册的 cleanup（此处验证注册表可被反注册）
      // 注意：useSessionScopedState 自身的 cleanup（删 Map 分区）应被反注册；
      // 外部 register 的 fn 由注册者负责反注册，trigger 仍会调用它——这条断言锁的是
      // useSessionScopedState 自身注册的 cleanup 在卸载后不再被调用（见下一条用例）
      triggerSessionCleanups('after-unmount')
      // fn 是外部 register 的，trigger 仍调用（未反注册）
      expect(fn).toHaveBeenCalledWith('after-unmount')
    })

    it('useSessionScopedState 卸载后其内部 cleanup 不再被 trigger 调用', async () => {
      const init = vi.fn(() => ({ v: 0 }))
      const sid = ref<string | null>('doomed')
      const scope = effectScope()
      scope.run(() => {
        // 访问 current 触发惰性 init，建立 'doomed' 分区（惰性 init 契约：不访问不 init）
        const state = useSessionScopedState(sid, init)
        void state.current.value
      })
      expect(init).toHaveBeenCalledTimes(1)

      scope.stop()
      await nextTick()

      // trigger 'doomed' 的 cleanup：useSessionScopedState 卸载后不应再执行其 cleanup
      // （未卸载时 trigger 应移除 'doomed' 分区——见 W5 session-cleanup 集成测试）
      // 此处只验证 trigger 不抛错（反注册后注册表不含该 fn）
      expect(() => triggerSessionCleanups('doomed')).not.toThrow()
    })
  })

  describe('C-1 条件注册检查（console-noise-triage D1：if (getCurrentScope())）', () => {
    it('分支 1（有 scope）：dispose 后自身 cleanup 已反注册，trigger 不再触达其分区', async () => {
      const init = vi.fn(() => ({ v: 0 }))
      const sid = ref<string | null>('guarded-with-scope')
      const scope = effectScope()
      let state!: ReturnType<typeof useSessionScopedState<{ v: number }>>
      scope.run(() => {
        state = useSessionScopedState<{ v: number }>(sid, init)
      })
      state.update((s) => { s.v = 42 })
      expect(init).toHaveBeenCalledTimes(1)

      scope.stop()
      await nextTick()

      triggerSessionCleanups('guarded-with-scope')
      // 反注册成立的可观察判据（惰性 computed：分区重建只在读时发生，故先读后断言——
      // 实测 scope.stop 后 version bump 仍驱动 current 重算）：cleanup 若仍留在注册表，
      // 此处会删除分区 → 重访 current 触发第 2 次 init 且 v 回 0。
      // 既有用例「卸载后其内部 cleanup 不再被 trigger 调用」只断言 trigger 不抛错，而
      // trigger 对每个 fn 包 try/catch（该断言恒真、无判别力），registry 载重断言补于此。
      const afterTrigger = state.current.value
      expect(afterTrigger.v).toBe(42)
      expect(init).toHaveBeenCalledTimes(1)
    })

    it('分支 2（无 scope，模块级单例形态）：不 warn、不抛错，且 cleanup 保留在注册表（前提 2）', () => {
      const warnSpy = vi.spyOn(console, 'warn')
      try {
        const init = vi.fn(() => ({ v: 0 }))
        const sid = ref<string | null>('guarded-no-scope')
        let state!: ReturnType<typeof useSessionScopedState<{ v: number }>>
        expect(() => {
          state = useSessionScopedState<{ v: number }>(sid, init)
          void state.current.value
        }).not.toThrow()
        // 条件注册构造性消除 Vue「no active effect scope」dev warn（检查前此处必 warn）
        expect(warnSpy).not.toHaveBeenCalled()

        // 前提 2 载重：不挂 dispose → unregister 永不触发 → cleanup 留在注册表，
        // 模块级单例靠 triggerSessionCleanups 清理而非 scope dispose
        state.update((s) => { s.v = 42 })
        triggerSessionCleanups('guarded-no-scope')
        // 惰性 computed：cleanup 删除分区 + version bump 后，重算只在读时发生——先读后断言
        const afterTrigger = state.current.value
        expect(afterTrigger.v).toBe(0)
        expect(init).toHaveBeenCalledTimes(2)
      } finally {
        warnSpy.mockRestore()
      }
    })
  })

  describe('C-1 census 扫描机制（fixture 级）', () => {
    // 全仓「census ≡ 快照」护栏由 pre-commit 承载（.githooks/install-hooks.sh 的
    // E2E-CENSUS-01 段：staged 任意 .ts/.tsx/.vue 或脚本自身即触发
    // node scripts/check-session-scoped-state-census.mjs，与本处 import 消费同一实现
    // 同一快照，零双口径）——staged glob 与扫描范围同构，新增调用点的提交必经该门。
    // 单测层不递归全仓（秒级重负载，判据 e），只在 tmpdir fixture 树上锁扫描机制本身：
    // 剪枝（node_modules/点前缀目录）、排除（测试后缀/__tests__/工厂定义行/非 ts 扩展）、
    // 计数（裸括号/泛型双形态 + 同行多调用）与对账 diff 输出三态。
    it('collectCallSites：fixture 树计数与剪枝/排除口径逐条命中', () => {
      const root = mkdtempSync(join(tmpdir(), 'census-fixture-'))
      try {
        mkdirSync(join(root, 'sub', '__tests__'), { recursive: true })
        mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
        mkdirSync(join(root, '.hidden'), { recursive: true })
        // 命中：裸括号形态 + 泛型形态 + 同行双调用（g 变体计数，防 lastIndex 翻转）
        writeFileSync(join(root, 'alpha.ts'), [
          'const a = useSessionScopedState(sidRef, init)',
          'const b = useSessionScopedState<{ v: number }>(sidRef, init)',
          'const c = useSessionScopedState(x, i); const d = useSessionScopedState(y, i)',
          'export {}',
        ].join('\n'))
        // 不命中：import 引用（锁模式要求 [<(] 尾随）
        writeFileSync(join(root, 'importer.ts'), "import { useSessionScopedState } from './x'\nexport {}\n")
        // 排除：工厂定义行（命中模式但非调用点）
        writeFileSync(
          join(root, 'definition.ts'),
          'export function useSessionScopedState<T>(sid: unknown, init: () => T) {\n  return null as never\n}\n',
        )
        // .vue / .tsx 计入
        writeFileSync(join(root, 'component.vue'), '<script setup lang="ts">\nconst s = useSessionScopedState(sid, init)\n</script>\n')
        writeFileSync(join(root, 'sub', 'beta.tsx'), 'const s = useSessionScopedState(sid, init)\n')
        // 剪枝/排除：测试后缀 / __tests__ 目录 / node_modules / 点前缀目录 / 非 ts 扩展
        writeFileSync(join(root, 'skip.test.ts'), 'const s = useSessionScopedState(sid, init)\n')
        writeFileSync(join(root, 'sub', '__tests__', 'nested.ts'), 'const s = useSessionScopedState(sid, init)\n')
        writeFileSync(join(root, 'node_modules', 'pkg', 'x.ts'), 'const s = useSessionScopedState(sid, init)\n')
        writeFileSync(join(root, '.hidden', 'x.ts'), 'const s = useSessionScopedState(sid, init)\n')
        writeFileSync(join(root, 'notes.md'), 'const s = useSessionScopedState(sid, init)\n')

        expect(collectCensusCallSites(root)).toEqual({
          'alpha.ts': 4,
          'component.vue': 1,
          [join('sub', 'beta.tsx')]: 1,
        })
      } finally {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    })

    it('compareCensusToSnapshot：一致 null / 新增 / 消失 / 计数变化四态', () => {
      // 基线从真实快照派生（快照单一源，不硬编码文件清单）
      const baseline = { ...censusSnapshot }
      expect(censusDiffToSnapshot(baseline)).toBeNull()

      const added = censusDiffToSnapshot({ ...baseline, 'ghost/new-callsite.ts': 1 })
      expect(added).toHaveLength(1)
      expect(added![0]).toContain('+ 新增调用点: ghost/new-callsite.ts')

      const sampleKey = Object.keys(baseline)[0] as string
      const { [sampleKey]: _omitted, ...withoutSample } = baseline
      const removed = censusDiffToSnapshot(withoutSample)
      expect(removed).toHaveLength(1)
      expect(removed![0]).toContain(`- 消失调用点: ${sampleKey}`)

      const changed = censusDiffToSnapshot({ ...baseline, [sampleKey]: baseline[sampleKey]! + 1 })
      expect(changed).toHaveLength(1)
      expect(changed![0]).toContain(`~ 计数变化: ${sampleKey}`)
    })
  })
});
