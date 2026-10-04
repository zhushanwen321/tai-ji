/**
 * [B9 agentcall LRU 联动] panel 枚举豁免查询源（memory-leak-remediation §3.3-B9）。
 *
 * 从 control.ts 迁入（display-containers §6.6① 五字段迁出后本查询改读复合谓词单一源
 * selection/predicates.ts，不再持有控制态拼装逻辑）。导出名与语义不变：
 * chat store 注入 evictIfNeeded 的豁免源（bindViewedVidPanels + getViewedVids）。
 */
import { ref } from 'vue'
import type { Ref } from 'vue'
import { viewedBtwVidFor, viewedSubagentVidFor } from './predicates'

/** 全部 panel 的 focusedSessionId 列表源（split 恢复时多 panel 全查；单 panel 恒 1 元素） */
type ViewedPanelsSource = Ref<readonly (string | null)[]>

/**
 * panel 枚举绑定（headless 模式，对齐 bindDrawerSessionId）：panel 枚举是 renderer
 * 数据（panel store），core 不 import renderer——renderer 装配模块（composables/
 * features/chat/agentcall-lru-linkage.ts）注册 computed(() => usePanelStore().panels
 * .map(p => p.sessionId))。惰性求值（首次读发生在 LRU 驱逐时，pinia 已 active）。
 * 幂等：同 ref 重复绑定无副作用；新 ref 覆盖（测试隔离重绑定用）。
 * 未绑定时 getViewedVids 返回空集（驱逐无豁免，安全默认）。
 */
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，12 类未覆盖存量，已登记 §4 ⑧ 2026-09-15）：panel 枚举绑定单例 ref
const boundViewedPanels: Ref<ViewedPanelsSource | null> = ref(null)

/** 绑定 panel 枚举源（renderer 装配层调用；重绑定覆盖旧源） */
export function bindViewedVidPanels(source: ViewedPanelsSource): void {
  boundViewedPanels.value = source
}

/**
 * [B9] 当前正在查看的 subagent/agentcall 虚拟 id 集（LRU 联动驱逐的豁免源）。
 * [D5 btw-question M3-a] 同源扩含 btw 线：drawer 开在 btw tab 且正在查看某线时，
 * 该线 vid 同样计入豁免（查看中不驱逐；btw 分区被驱逐时的派生键同驱归 M2-c）。
 *
 * 组合链（查询源钉死 panel 枚举，R2 S1）：逐 panel → focusedSessionId → 该 sid 的
 * 复合谓词（isOpen ∧ activeTab ∈ {'subagent','btw'} ∧ 选中 id——唯一拼装点 =
 * selection/predicates.ts，与 btw-replay 触发面 / useBtwTabData 视口命中同源）。
 *
 * [禁止] drawer 分区全枚举：曾开过 drawer 的 session 焦点切走后分区保留，全枚举会把
 * 全部历史 agentcall 分区永久豁免，B9 对重度用户静默失效。分区读取经 updateFor
 * （updater 零写入，纯读；分区不存在时惰性建默认空分区，量级 = panel 数 × 几十字节，接受）。
 */
export function getViewedVids(): Set<string> {
  const viewed = new Set<string>()
  const panels = boundViewedPanels.value?.value ?? []
  for (const sid of panels) {
    if (!sid) continue
    const subagentVid = viewedSubagentVidFor(sid)
    if (subagentVid) viewed.add(subagentVid)
    // btw 线查看保护（D5：查看中不驱逐——本集经 chat store 注入 evictIfNeeded，入口刷新
    // 该线 recency 恒排保留区，阈值驱逐不落选；未查看的线照常参与阈值驱逐，文件持久可回填）
    const btwVid = viewedBtwVidFor(sid)
    if (btwVid) viewed.add(btwVid)
  }
  return viewed
}
