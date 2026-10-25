/**
 * composer 输入历史导航 —— packages/dom-core/src/composer/input/history.ts（W2）。
 *
 * 定位：迁自 renderer useComposerHistory.ts。shell 风格 ↑/↓ 翻阅已发送消息。
 *
 * [W2 改造]
 * - 原 import { useChatStore } from '@/stores/chat' + history computed 派生 → 删除，
 *   改 deps.getHistoryEntries 注入（clarify C1 D2）。core composer 域零跨域 import chat store（D4/AC10）。
 * - 原 import { useSessionScopedState } from '@/composables/useSessionScopedState'
 *   → import { useSessionScopedState } from '@taiji/core/foundation/use-session-scoped-state'（W1 已落地）。
 * - 历史派生已上移壳层（renderer composer-shell 的 deriveHistoryFromChatStore 注入
 *   getHistoryEntries），本文件自 @taiji/shared 仅 import type Segment。
 *
 * 状态机（FR1 三阶段模型，内联权威描述）：
 * - ↑（edit 态）：非首行移光标 → 首行非行首归位 → 首行行首进 browsing
 * - ↑（browsing + 未到最老）：index++ → 回填 H[index]
 * - ↑（browsing + 已在最老）：保持不动
 * - ↓（browsing + 未到最近）：index-- → 回填 H[index]
 * - ↓（browsing + 已在最近）：恢复草稿 → edit 态
 * - 回填后光标定位（FR2）：↑→首位（连续回溯），↓→末位
 * - 重置：用户在 browsing 态修改内容 → 退出 browsing
 */
import { computed, reactive, type Ref } from 'vue'
import { useSessionScopedState } from '@taiji/core/foundation/use-session-scoped-state'
import type { Segment } from '@taiji/shared'
import type { ComposerNavState, HistoryDeps } from './types'

/**
 * @param sessionIdRef 当前 session id（null 时无历史可翻）
 * @param deps DOM 操作回调 + getHistoryEntries 派生注入
 */
export function useComposerHistory(
  sessionIdRef: Ref<string | null>,
  deps: HistoryDeps,
): {
  handleArrowUp: () => boolean
  handleArrowDown: () => boolean
  resetBrowsing: () => void
  isBrowsing: Ref<boolean>
  /** 按 sid 显式读 browsing 态（session 切换 watch 回调时刻 sid.value 已是新值，isBrowsing 读不到旧分区） */
  isBrowsingFor: (sid: string) => boolean
  /** 按 sid 显式读进 browsing 前保存的草稿 segments 快照（用户真实输入；browsing 态输入区已被历史条目替换） */
  getSavedSegments: (sid: string) => Segment[]
} {
  /**
   * 派生历史（倒序、去重连续相同文本）。
   * H[0] = 最近一条已发送消息，H[last] = 最老一条。
   * [W2 改造] 派生逻辑上移壳层（deriveHistoryFromChatStore），core 经 deps.getHistoryEntries 取最终数组。
   */
  const history = computed<string[]>(() => {
    const sid = sessionIdRef.value
    if (!sid) return []
    return deps.getHistoryEntries(sid)
  })

  /**
   * per-session 分区导航状态（ADR-0049 W3）。
   * init 返回 reactive 容器：下游 isBrowsing computed 在其上建立依赖。
   */
  const navState = useSessionScopedState<ComposerNavState>(
    sessionIdRef,
    () => reactive<ComposerNavState>({ browsing: false, index: 0, savedSegments: [] }),
  )

  const isBrowsing = computed(() => navState.current.value.browsing)

  /**
   * 按 sid 显式读分区导航态（R2-A6：session 切换 watch 回调触发时 sessionIdRef 已指向
   * 新 session，isBrowsing 只能读到新分区恒 false——旧 session 是否在 browsing、其用户
   * 真实输入是什么，都必须按旧 sid 显式取）。
   */
  function isBrowsingFor(sid: string): boolean {
    let browsing = false
    navState.updateFor(sid, (s) => { browsing = s.browsing })
    return browsing
  }

  /**
   * 按 sid 显式读进 browsing 前保存的草稿（用户真实输入的 segments 快照，含全部 chip
   * 类型——browsing 态输入区已被历史条目替换，getText()/getSegments() 都读不到原值）。
   */
  function getSavedSegments(sid: string): Segment[] {
    let saved: Segment[] = []
    navState.updateFor(sid, (s) => { saved = s.savedSegments })
    return saved
  }

  /** 是否正在程序化设置文本（防止 setText 触发的 input 事件导致 resetBrowsing） */
  let isSettingText = false

  /**
   * 重置浏览状态（用户修改了 composer 内容时调用）。
   * 下次按 ↑ 会重新从最后一条历史开始。程序化设置文本会跳过此重置。
   */
  function resetBrowsing(): void {
    if (isSettingText) return
    navState.update((s) => {
      s.browsing = false
      s.index = 0
    })
  }

  /** ↑ 处理。返回 true 表示已消费。 */
  function handleArrowUp(): boolean {
    const h = history.value
    const s = navState.current.value

    if (!s.browsing) {
      if (h.length === 0) {
        return false
      }
      navState.update((st) => {
        st.savedSegments = deps.getSegments()
        st.browsing = true
        st.index = 0
      })
      isSettingText = true
      deps.setText(h[0], 'start')
      isSettingText = false
      return true
    }

    if (s.index + 1 < h.length) {
      const newIndex = s.index + 1
      navState.update((st) => {
        st.index = newIndex
      })
      isSettingText = true
      deps.setText(h[newIndex], 'start')
      isSettingText = false
    }
    return true
  }

  /** ↓ 处理。返回 true 表示已消费。 */
  function handleArrowDown(): boolean {
    const s = navState.current.value
    if (!s.browsing) return false

    const h = history.value
    if (s.index > 0) {
      const newIndex = s.index - 1
      navState.update((st) => {
        st.index = newIndex
      })
      isSettingText = true
      const entry = h[newIndex]
      if (entry !== undefined) {
        deps.setText(entry, 'end')
      } else {
        // index 越界兜底（历史派生缩短）：退回恢复草稿（segments 快照结构化回填），
        // 与「↓ 已在最近」同款收尾——同步退出 browsing（否则浏览态残留，↑ 失效一次）
        deps.restoreSegments(s.savedSegments)
        navState.update((st) => {
          st.browsing = false
        })
      }
      isSettingText = false
    } else {
      // ↓ 退回最近条目 = 恢复草稿：走 segments 快照结构化回填（text 重建 + chip 还原，
      // U8 单点），不再 setText 纯文本——纯文本形态会把 chip 序列化成标记污染文本
      isSettingText = true
      deps.restoreSegments(s.savedSegments)
      isSettingText = false
      navState.update((st) => {
        st.browsing = false
      })
    }
    return true
  }

  return { handleArrowUp, handleArrowDown, resetBrowsing, isBrowsing, isBrowsingFor, getSavedSegments }
}
