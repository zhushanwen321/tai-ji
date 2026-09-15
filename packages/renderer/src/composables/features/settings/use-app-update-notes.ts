/**
 * useAppUpdate 的 releaseNotes 多语言提取 + 渲染轴。
 *
 * - extractLocalizedNotes：从多语言 release body 中提取当前语言段落（<!-- LANG:xx --> 标记，
 *   无标记向后兼容返回原文）
 * - renderReleaseNotes：提取 + renderMarkdown（markdown-it + shiki WASM 异步渲染）+
 *   写入单例 state.releaseNotesHtml。checkForUpdate 调用方传 guard 做防陈旧丢弃
 *   （渲染期间又发了新 checkForUpdate 则丢弃本次 html），restore 链无并发检测不传。
 *
 * 依赖方向：本模块 → use-app-update-state（写 releaseNotesHtml），被
 * use-app-update-check / use-app-update-restore 消费。
 */
import { renderMarkdown } from '@/composables/logic/markdown'
import { getLocale } from '@/i18n'
import { updateState } from './use-app-update-state'

/**
 * 多语言 release notes 分隔标记。
 *
 * GitHub Release body 中使用此标记分隔不同语言的内容。
 * 格式示例：
 * ```markdown
 * ## English
 * <!-- LANG:en -->
 * - Fix bug X
 * - Add feature Y
 *
 * <!-- LANG:zh -->
 * ## 中文
 * - 修复 bug X
 * - 添加功能 Y
 * ```
 *
 * 前端根据用户语言偏好提取对应部分。未找到对应语言标记时，
 * 返回整个 body（向后兼容无标记的 release）。
 */
const LANG_MARKER_RE = /<!--\s*LANG:(\w+)\s*-->/g

/**
 * 从多语言 release notes 中提取当前用户语言对应的部分。
 *
 * 支持两种格式：
 * 1. 带标记格式：`<!-- LANG:zh -->中文内容<!-- LANG:en -->English content`
 * 2. 无标记格式：直接返回原文（向后兼容）
 *
 * @param releaseNotes 原始 release notes（可能包含多语言标记）
 * @returns 提取后的 release notes（当前语言对应的部分）
 */
export function extractLocalizedNotes(releaseNotes: string): string {
  // 无标记：直接返回原文（向后兼容旧 release）
  if (!releaseNotes.includes('<!-- LANG:')) {
    return releaseNotes
  }

  const locale = getLocale() // 'zh-CN' 或 'en-US'
  // 提取语言代码（zh-CN → zh，en-US → en）
  const langCode = locale.split('-')[0].toLowerCase()

  // 按标记分段
  const sections: Array<{ lang: string; content: string }> = []
  let lastIndex = 0
  let currentLang = ''

  // 重置正则状态
  LANG_MARKER_RE.lastIndex = 0

  let match: RegExpExecArray | null
  while ((match = LANG_MARKER_RE.exec(releaseNotes)) !== null) {
    // 标记前的内容归入上一段
    if (currentLang && match.index > lastIndex) {
      sections.push({
        lang: currentLang,
        content: releaseNotes.slice(lastIndex, match.index).trim(),
      })
    }
    currentLang = match[1].toLowerCase()
    lastIndex = match.index + match[0].length
  }

  // 最后一段
  if (currentLang && lastIndex < releaseNotes.length) {
    sections.push({
      lang: currentLang,
      content: releaseNotes.slice(lastIndex).trim(),
    })
  }

  // 查找当前语言对应的段落
  const targetSection = sections.find((s) => s.lang === langCode)
  if (targetSection) {
    return targetSection.content
  }

  // 找不到当前语言：优先回退英文，否则取第一段
  const enSection = sections.find((s) => s.lang === 'en')
  return enSection?.content ?? sections[0]?.content ?? releaseNotes
}

/**
 * 渲染 release notes 并写入单例 state.releaseNotesHtml（异步，不阻塞 UI）。
 * guard 返回 false 时丢弃本次解析（防陈旧：渲染期间状态已被更新的检测覆盖）。
 */
export function renderReleaseNotes(releaseNotes: string, guard?: () => boolean): void {
  const localizedNotes = extractLocalizedNotes(releaseNotes)
  void renderMarkdown(localizedNotes).then((html) => {
    if (guard && !guard()) return
    updateState.releaseNotesHtml = html
  })
}
