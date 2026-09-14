/**
 * agentcall-lru-linkage —— [B9 agentcall 分区 LRU 联动] renderer 装配点
 * （docs/design/memory-leak-remediation.md §3.3-B9）。
 *
 * 职责（两件事）：
 * 1. panel 枚举绑定：把 renderer panel store 的「全部 panel focusedSessionId 列表」注册进
 *    core drawer control 的豁免查询源（bindViewedVidPanels）。惰性 computed——首次求值
 *    发生在 LRU 驱逐时（pinia 已 active），对齐 useSideDrawer 的 bindDrawerSessionId 模式。
 *    split 模式恢复时多 panel 全查（panel store panels 即全部叶子）。
 * 2. LRU 联动回调装配：agentCallLruLinkage() 返回 createChatStore 的 options——
 *    主 session 被驱逐时，workflow store 映射（getAgentCallVirtualIdsByMain，agentcall
 *    清理唯一通路）筛除 viewedVids 豁免集后返回待释放的 agentcall virtualId，core lru.ts
 *    执行删除。正在查看的分区存活（drawer 不白屏）；豁免窗口外被驱逐 = getMessages(vid)
 *    返回 [] 静态白屏，恢复 = 用户重选 tab 触发 selectedSubagentId watch 重拉快照
 *    （一次性交互，设计登记取舍，不新增自动恢复机制）。
 *
 * 依赖方向：本文件是 features 层装配模块，可自由 import stores（stores 间禁止互相
 * import 的编排外置约定）；不回 import stores/chat.ts（防 defineStore 装配环）——
 * 回调是纯查询，无需 chat store 实例（驱逐执行面在 core lru.ts）。
 *
 * 被驱逐分区的白屏恢复语义：agentcall 分区无 live 写入者（D4 只读契约），不自愈；
 * SubagentTab 重挂载/重选时经 getAgentCallHistory + setMessages + registerAgentCall 重建。
 */
import { computed } from 'vue'
import type { ChatStoreOptions } from '@xyz-agent/core'
import { bindViewedVidPanels, getViewedVids } from '@xyz-agent/core/domain/drawer'
import { usePanelStore } from '@/stores/panel'
import { useWorkflowStore } from '@/stores/workflow'

// panel 枚举绑定（模块顶层一次）：豁免查询源 = 逐 panel 的 focusedSession → drawer 分区
// 当前选中 vid（core control.getViewedVids 组合）。lazy 调 usePanelStore()（computed
// 首次求值时 pinia 已 active，避免模块加载期 pinia 未初始化）。
bindViewedVidPanels(computed(() => usePanelStore().panels.map((p) => p.sessionId)))

/**
 * [B9] createChatStore 的 LRU 联动 options（stores/chat.ts 装配调用）。
 *
 * 回调为纯查询：workflow store 映射 ∖ viewedVids（panel 枚举豁免集）。返回的 vid 由
 * core lru.ts 在两驱逐路径（evictIfNeeded 阈值 / evictSessionWithVirtual 显式）统一执行
 * deleteMessageKey + 时序记录清理。
 */
export function agentCallLruLinkage(): ChatStoreOptions {
  return {
    agentCallEvictionsOf: (mainSid) => {
      const viewed = getViewedVids()
      const evictions = useWorkflowStore()
        .getAgentCallVirtualIdsByMain(mainSid)
        .filter((vid) => !viewed.has(vid))
      // [B9 验收探针（实施期门，A9 批次验证后降级/移除）] dev 实例观测联动驱逐面：
      // 主 session 驱逐时释放的分区数 + 豁免命中数（A6「正被查看的分区存活」新活证据）
      if (evictions.length > 0) {
        console.debug(
          `[B9] agentcall LRU 联动驱逐: main=${mainSid} released=${evictions.length} exempted=${viewed.size}`,
        )
      }
      return evictions
    },
  }
}
