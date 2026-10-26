/**
 * restoreToDraft composable（从 composer-shell 拆出——script 行数上限）：队列条目撤销（×）/
 * 队列编辑预填（D6）共用的文本回输入区——delivery.cancel reply 全文 + segments 落回草稿
 * （ADR-0043）。空输入整段恢复含 chips（发送失败回滚同通路）；已有输入追加不覆盖
 * （composerInjectionStore '\n\n' 累积，用户输入不丢）；无 segments 快照落纯文本；
 * 追加分支只回文本（已登记 deviations）。
 */
import type { Ref } from 'vue'
import type { Segment } from '@taiji/shared'
import type { composerInjectionStore } from './composer-injection-store'

type ComposerInjectionStoreInstance = typeof composerInjectionStore

interface RestoreToDraftDeps { // oe-exempt:20261024:framework:壳层装配契约（composer-shell 单装配点依赖注入面，U6/U7 撤销回填与编辑预填两消费路径）
  draft: Ref<string>
  inputRef: Ref<{ getText: () => string; getSegments: () => Segment[] } | null>
  sessionIdRef: Ref<string | null>
  restoreSegments: (segments: Segment[]) => void
  restoreInput: (text: string) => void
  composerInjectionStore: ComposerInjectionStoreInstance
}

export function useRestoreToDraft(deps: RestoreToDraftDeps) {
  const { draft, inputRef, sessionIdRef, restoreSegments, restoreInput, composerInjectionStore } = deps

  function restoreToDraft(payload: { text: string; segments?: Segment[] }): void {
    const text = payload.text
    const segments = payload.segments
    const currentText = (inputRef.value?.getText() ?? draft.value).trim()
    const hasChips = (inputRef.value?.getSegments() ?? []).some((s) => s.type !== 'text')
    if (currentText.length === 0 && !hasChips) {
      if (segments && segments.length > 0) restoreSegments(segments)
      else if (text.trim()) restoreInput(text)
      return
    }
    const sid = sessionIdRef.value
    if (!sid || !text.trim()) return
    const pendingText = composerInjectionStore.pendingInjection.value?.text
    composerInjectionStore.requestInjection({
      target: 'current',
      sessionId: sid,
      text: pendingText ? `${pendingText}\n\n${text}` : text,
    })
  }

  return { restoreToDraft }
}
