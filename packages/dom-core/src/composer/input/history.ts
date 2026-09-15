/**
 * composer 输入历史导航 —— packages/dom-core/src/composer/input/history.ts（W2）。
 *
 * 定位：迁自 renderer useComposerHistory.ts。shell 风格 ↑/↓ 翻阅已发送消息。
 *
 * ⚠️ 权威行为规格见 `.taiji-harness/2026-07-10-composer-history-navigation/spec.md`
 * （FR1 视觉行导航 + FR2 光标定位 + FR3 换行往返 + FR4 跨 session 草稿持久化）。
 *
 * [W2 改造]
 * - 原 import { useChatStore } from '@/stores/chat' + history computed 派生 → 删除，
 *   改 deps.getHistoryEntries 注入（clarify C1 D2）。core composer 域零跨域 import chat store（D4/AC10）。
 * - 原 import { useSessionScopedState } from '@/composables/useSessionScopedState'
 *   → import { useSessionScopedState } from '@taiji/core/foundation/use-session-scoped-state'（W1 已落地）。
 * - normalizeContent 仍 from @taiji/shared（core 允许依赖）。
 *
 * 状态机（详见 spec FR1 三阶段模型）：
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
    () => reactive<ComposerNavState>({ browsing: false, index: 0, savedDraft: '' }),
  )

  const isBrowsing = computed(() => navState.current.value.browsing)

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
      const draft = deps.getText()
      if (h.length === 0) {
        return false
      }
      navState.update((st) => {
        st.savedDraft = draft
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
      deps.setText(h[newIndex] ?? s.savedDraft, 'end')
      isSettingText = false
    } else {
      isSettingText = true
      deps.setText(s.savedDraft, 'end')
      isSettingText = false
      navState.update((st) => {
        st.browsing = false
      })
    }
    return true
  }

  return { handleArrowUp, handleArrowDown, resetBrowsing, isBrowsing }
}
