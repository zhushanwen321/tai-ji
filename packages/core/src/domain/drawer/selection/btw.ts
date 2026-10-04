/**
 * btw（旁路线）内容域选中态（display-containers §6.6① 五字段迁出，W0 还债）。
 *
 * 迁出来源 = DrawerControlState.selectedBtwVid（btw tab 当前查看的旁路线 vid）。
 * per-session 分区（useSessionScopedState，ADR-0049），键 = drawerSessionKey。
 * 写入面 = setBtwView（BtwPanel 选中线时写入）；读取面 = useBtwSelection（BtwPanel）+
 * 复合谓词 selection/predicates.ts（getViewedVids 的 D5 豁免 / btw-replay 触发面 /
 * useBtwTabData 视口命中三消费方共用——禁止各处自行拼装三分量）。
 */
import { computed, reactive } from 'vue'
import type { ComputedRef } from 'vue'
import { useSessionScopedState } from '../../../foundation/use-session-scoped-state'
import { drawerSessionKey } from '../control'

/** btw 选中态（per-session 分区） */
export interface BtwSelectionState { // oe-exempt:20261003:framework:类型契约先行——selection 分区契约，renderer 消费面即本批 D1 单元
  /** btw tab 当前查看的旁路线 vid（`btw:<piSessionId>`，由 BtwPanel 选中线时写入）；undefined=未查看。
   *  D5 chat-lru 查看态保护数据源之一（getViewedVids：isOpen + activeTab==='btw' + 本字段
   *  三分量 → chat store 注入 evictIfNeeded，入口刷新该线 recency——查看中恒不落阈值驱逐）；
   *  切走/关 drawer 不清（D7④ 切回恢复面板语义），复合谓词已含 isOpen/activeTab 双闸不泄漏豁免。 */
  selectedBtwVid?: string
}

function createDefaultBtwSelection(): BtwSelectionState {
  // reactive 容器契约（ADR-0049 W2 教训）：plain object 的 mutate 不触发下游重算
  return reactive({})
}

const selection = useSessionScopedState<BtwSelectionState>(
  drawerSessionKey,
  createDefaultBtwSelection,
)

/** btw 选中态视图（当前分区，切 session 自动跟随） */
export function useBtwSelection(): {
  selectedBtwVid: ComputedRef<string | undefined>
  } {
  return {
    selectedBtwVid: computed(() => selection.current.value.selectedBtwVid),
  }
}

/**
 * 登记当前查看的 btw 线 vid（btw-question D7/D5，M3-a）：BtwPanel 选中线时写入 vid、
 * 清空选中/关线时传 undefined。纯字段写入（不切 tab 不开 drawer——面板本就挂在 btw tab
 * 上，由 openDrawerTab('btw') 入口负责），消费方 = 复合谓词（predicates.ts）。
 */
export function setBtwView(vid: string | undefined): void {
  selection.current.value.selectedBtwVid = vid
}

/** 读取当前分区选中态（复合谓词同步读取用）。返回 reactive 分区对象本身 */
export function getBtwSelectionState(): BtwSelectionState {
  return selection.current.value
}

/** 按 sid 读 btw 选中态（复合谓词跨域读取用；updateFor 语义：已删 sid 不复活分区） */
export function readBtwSelectionFor<R>(sid: string, read: (s: BtwSelectionState) => R): R | undefined {
  let out: R | undefined
  selection.updateFor(sid, (s) => {
    out = read(s)
  })
  return out
}

/** 清空 btw 选中态分区（测试隔离用）。生产代码禁止调用。 */
export function _resetBtwSelectionForTest(): void {
  selection._clearAllForTest()
}
