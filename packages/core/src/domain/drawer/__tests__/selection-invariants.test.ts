/**
 * drawer 选中态迁出不变量单测（display-containers §7.1 [MANDATORY]，W0 还债验收①）。
 *
 * 对账对象 = 三消费方读的复合谓词 `isOpen ∧ activeTab ∈ {'subagent','btw'} ∧ 选中 id`：
 *   ① getViewedVids（chat LRU 驱逐豁免，selection/viewed-vids.ts）
 *   ② btw-replay 触发面（useViewedBtwVid，renderer stores/btw-replay.ts 直接 watch）
 *   ③ useBtwTabData 视口命中（isViewingBtwVid / useBtwViewKey）
 * 三者必须同值同变（读取单一源 = selection/predicates.ts）——任何拼装漂移 = 查看中的
 * btw 线 / agentcall 分区被静默驱逐（数据丢失类回归）或回放误停。
 *
 * 真实事件序（§8.2 条款对账口径）：以真实响应式写入 + await nextTick 逐步推进
 * （开/切 tab/切 session/清选中），每步对账三读数一致——不 mock 时序、不跳步。
 *
 * 运行：cd packages/core && npx vitest run src/domain/drawer/__tests__/selection-invariants.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { nextTick, ref } from 'vue'
import type { Ref } from 'vue'
import { bindDrawerSessionId, getBoundSessionId } from '../control'
import {
  bindViewedVidPanels,
  getViewedVids,
  isViewingBtwVid,
  setBtwView,
  useBtwViewKey,
  useViewedBtwVid,
  viewedBtwVidFor,
  viewedSubagentVidFor,
} from '../selection'
import { openDrawerTab, openSubagent, setDrawerTab, closeDrawer, _resetDrawerForTest } from '../coordination'

let sid: Ref<string | null>
let panels: Ref<Array<string | null>>

function focusSession(s: string | null): void {
  sid.value = s
}

/** 三消费方同值对账（btw 族）：豁免集 ↔ 回放触发源 ↔ 视口命中，一次断言三读数一致 */
async function assertBtwReadingsAgree(vid: string, expected: string | null): Promise<void> {
  await nextTick() // 真实事件序：写入后过一个 flush，再读三消费方
  // ① chat LRU 豁免（getViewedVids）
  expect(getViewedVids().has(vid)).toBe(expected !== null)
  // ② btw-replay 触发源（useViewedBtwVid——renderer watch 的就是它）
  expect(useViewedBtwVid().value).toBe(expected)
  // ③ useBtwTabData 视口命中（isViewingBtwVid）+ 视口三元组 key（useBtwViewKey）
  expect(isViewingBtwVid(vid)).toBe(expected !== null)
  const key = useBtwViewKey().value
  if (expected === null) {
    expect(key === '' || !key.includes(vid)).toBe(true)
  } else {
    expect(key).toBe(`${getBoundSessionId() ?? ''}\u0000${vid}`)
  }
}

beforeEach(() => {
  sid = ref<string | null>(null)
  bindDrawerSessionId(sid)
  panels = ref<Array<string | null>>([])
  bindViewedVidPanels(panels)
  _resetDrawerForTest()
})

describe('三消费方复合谓词不变量（真实事件序对账，selection-invariants）', () => {
  it('开 btw → 选线 → 切 tab → 切回 → 关 drawer：每步三读数同值', async () => {
    const V = 'btw:pi-1'
    focusSession('A')
    panels.value = ['A']

    // 初始：未开 → 三读数皆「不在查看」
    await assertBtwReadingsAgree(V, null)

    // 开 btw tab（未选线）→ 仍不在查看
    openDrawerTab('btw')
    await assertBtwReadingsAgree(V, null)

    // 选中线 → 三读数同翻（查看中）
    setBtwView(V)
    await assertBtwReadingsAgree(V, V)

    // 切到别的 tab → 三读数同落（选中残留不泄漏豁免——数据丢失防线）
    setDrawerTab('git')
    await assertBtwReadingsAgree(V, null)

    // 切回 btw tab → 三读数同恢复（切回恢复面板语义 D7④）
    setDrawerTab('btw')
    await assertBtwReadingsAgree(V, V)

    // 关 drawer → 三读数同落
    closeDrawer()
    await assertBtwReadingsAgree(V, null)
  })

  it('切 session（焦点换分区）→ 三读数随分区换显；A 的查看态在 A 分区不受影响', async () => {
    const V = 'btw:pi-a'
    focusSession('A')
    panels.value = ['A', 'B']
    openDrawerTab('btw')
    setBtwView(V)
    await assertBtwReadingsAgree(V, V)

    // 切到 B（B 无查看态）：三消费方读当前分区 → 同落；per-sid 读（①豁免链的读取路径）不受影响
    focusSession('B')
    await nextTick()
    expect(useViewedBtwVid().value).toBe(null)
    expect(isViewingBtwVid(V)).toBe(false)
    expect(useBtwViewKey().value).toBe('')
    expect(viewedBtwVidFor('A')).toBe(V) // A 分区查看态保留（getViewedVids 仍豁免 A）
    expect(getViewedVids()).toEqual(new Set([V]))

    // 切回 A：三读数同恢复
    focusSession('A')
    await assertBtwReadingsAgree(V, V)
  })

  it('subagent 分支：openSubagent 三分量齐 → 豁免集计入；关 drawer / 切 tab 即落（per-sid 谓词对账）', async () => {
    const V = 'agentcall:acs-1'
    focusSession('A')
    panels.value = ['A']

    openSubagent({ virtualId: V, enteredFrom: 'workflow' })
    await nextTick()
    expect(viewedSubagentVidFor('A')).toBe(V)
    expect(getViewedVids()).toEqual(new Set([V]))

    setDrawerTab('git')
    await nextTick()
    expect(viewedSubagentVidFor('A')).toBe(null)
    expect(getViewedVids()).toEqual(new Set())

    setDrawerTab('subagent')
    await nextTick()
    expect(viewedSubagentVidFor('A')).toBe(V)

    closeDrawer()
    await nextTick()
    expect(viewedSubagentVidFor('A')).toBe(null)
    expect(getViewedVids()).toEqual(new Set())
  })

  it('两族混合（A 看 btw、B 看 subagent）：复合谓词互不挤占，per-sid 读各自命中', async () => {
    const B = 'btw:pi-a'
    const S = 'subagent:B:s1'
    focusSession('A')
    openDrawerTab('btw')
    setBtwView(B)
    focusSession('B')
    openSubagent({ virtualId: S, enteredFrom: 'chat' })
    panels.value = ['A', 'B']
    await nextTick()

    expect(viewedBtwVidFor('A')).toBe(B)
    expect(viewedSubagentVidFor('A')).toBe(null)
    expect(viewedBtwVidFor('B')).toBe(null)
    expect(viewedSubagentVidFor('B')).toBe(S)
    expect(getViewedVids()).toEqual(new Set([B, S]))
  })
})
