/**
 * btw-replay —— btw 重载链 renderer 接线（btw-question D5「持久化 + 重载链」/ M2-c 验收 ③）。
 *
 * 职责（一件事）：**重开线时文件 → chatStore 分区回放**——drawer 选中某条 btw 线时，
 * 经既有回放通路 `chatApi.getHistory(vid)`（session.history，runtime 侧 = getEntries →
 * liftHistoryToEntries → replayEntries 对 pi 会话文件的 applyEntry 投影）拉取快照，注入
 * chatStore 的 `btw:` 分区（store.hydrate，内部 mergeBaselineWithLive 保尾部 live 实体）。
 * live ≡ reload 由共用同一 applyEntry reducer 构造性成立（等价性断言见本目录测试
 * btw-replay.test.ts + core apply-entry-equivalence 家族）。
 *
 * 触发面 = core drawer 控制态复合条件「drawer 开 + btw tab + 选中线」（selectedBtwVid 唯一
 * 源 = BtwPanel setBtwView，M3-a；与 getViewedVids 的 D5 豁免读同字段，不设第二副本）：
 * - 重开线（重启后自动选中 / 点 chip / 关 drawer 再开 / 切回焦点会话分区）→ 源值翻转即回放；
 * - 已 hydrate → 早退（幂等，关开 drawer 不重复拉取）；被 LRU 驱逐 → hydrated 标记随驱逐
 *   清除 → 再开触发重新回放（文件持久可回填，D5 chat-lru 语义的 renderer 半边）。
 *
 * 数据源纪律（M2-c 边界）：只走既有 snapshot/history 通路（chatApi.getHistory），不碰
 * transport 层 / 不新增帧（transport 归 M2-b）；快照回写失败 → markHistoryFailed（vid 入
 * failedHistory，P2 降级：live 帧仍可填充分区，下次重开触发重试），不拖垮面板。
 *
 * 装配点选 stores/chat.ts（defineStore setup）：watch 绑定 store effect scope，
 * $dispose 随 store 回收；不进组件（no-chat-ops-in-components）也不进 BtwPanel/M3-b 的
 * useBtwTabData 领地（数据编排下沉 composable 归 M3-b，本文件是 chatStore 自身的回放接线）。
 */
import { watch } from 'vue'
import { useDrawerControl } from '@taiji/core/domain/drawer'
import { isBtwVirtualId } from '@taiji/shared'
import {
  collectImagesFromMessages,
  historyWindowFromReply,
  persistImagesNewestFirst,
} from '@taiji/core'
import type { ChatStoreInstance } from '@taiji/core'
import { chat as chatApi } from '@/api'

/**
 * 回放目标面（chat store 的四个回放编排方法）。窄化 Pick：与 core factory 产物、
 * pinia store 实例双形态结构兼容（本模块不关心 messages 等 state 的 unwrap 形态差异）。
 */
export type BtwReplayTarget = Pick<
  ChatStoreInstance,
  'isHydrated' | 'hydrate' | 'clearHistoryError' | 'markHistoryFailed'
>

/**
 * 安装重开线回放 watch（stores/chat.ts defineStore setup 内调用一次）。
 *
 * 源 = 复合条件（isOpen ∧ activeTab==='btw' ∧ selectedBtwVid）：关 drawer / 切走 tab /
 * 清选中折叠为 null，重开/切回/选中翻出 vid——恰好覆盖「重开线」全部形态（含驱逐后
 * 重开：选中值在 drawer 分区内持久，靠 isOpen 翻转重新触发）。watch 跑在 store 的
 * effect scope 内，$dispose 即停。
 *
 * 在途回放去重 = 本闭包内 Set（复合源在 drawer 状态抖动窗口内可连续翻转，同 vid 只放行
 * 一次 getHistory——hydrate 幂等，但重复 RPC 是纯浪费；finally 必清，失败也重试可达）：
 * 随 store 实例隔离，不设模块级可变状态（taste/require-data-owner 面收敛 + 跨 store 隔离）。
 */
export function setupBtwReplayWatch(store: BtwReplayTarget): void {
  const inflight = new Set<string>()

  /** 单线回放（文件 → 分区）：getHistory(vid) → store.hydrate + 窗口状态 + 图片落盘编排。 */
  async function replay(vid: string): Promise<void> {
    if (!isBtwVirtualId(vid)) return // 防御：选中源只产 btw vid，异常值不发 RPC
    if (store.isHydrated(vid)) return // 已回放（关开 drawer / 重复选中幂等）
    if (inflight.has(vid)) return // 同 vid 在途去重
    inflight.add(vid)
    try {
      const reply = await chatApi.getHistory(vid)
      store.hydrate(vid, reply.messages, historyWindowFromReply(reply))
      store.clearHistoryError(vid)
      // toolResult 图片落盘编排（fire-and-forget，headless 无 write port 时内部 no-op）。
      // 编排对齐 core useChat.hydrateHistory / use-session.reconcileFromReply 两通路同款三件
      // （Gate B A9③ 缺陷#2：历史注入通路漏挂图片落盘即旁路，此处照挂）。
      void persistImagesNewestFirst(vid, collectImagesFromMessages(reply.messages))
    } catch (e) {
      // P2 降级：回放失败不写分区（live 帧仍可填充），vid 入 failedHistory 留重试面；
      // 下次重开源值翻转（关→开 / 切回）时 hydrated=false → 自动重试。
      console.warn(`[btw-replay] history replay failed for ${vid}:`, e)
      store.markHistoryFailed(vid)
    } finally {
      inflight.delete(vid)
    }
  }

  const { isOpen, activeTab, selectedBtwVid } = useDrawerControl()
  watch(
    () => (isOpen.value && activeTab.value === 'btw' ? (selectedBtwVid.value ?? null) : null),
    (vid) => {
      if (vid) void replay(vid)
    },
  )
}
