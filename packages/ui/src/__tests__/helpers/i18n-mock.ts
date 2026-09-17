/**
 * vue-i18n 测试替身（UI 包共享，g9-F5）。
 *
 * 口径 = 各测试文件此前各自手写的「字典 + `{name}` 命名参数 replace」：
 * - 键命中 → 字典文案；缺键 → 回落 key 本身（缺键回落语义与 vue-i18n dev 缺键行为同形）
 * - 命名参数逐个替换 `{k}`（首次出现），插值实现与各文件原手写版逐字一致
 * - 不实现复数 `|` 分段：需复数档的文件保留自有 mock（复数语义无法共用本口径，
 *   见 features/settings/common/__tests__/ScopedModelSection.test.ts）
 *
 * 只 mock `useI18n`（各文件原样：组件测试环境无 `app.use(i18n)`，无需 createI18n）。
 *
 * 用法——vi.mock 工厂被提升到静态 import 之前，顶层绑定此刻尚未初始化（TDZ），
 * 故工厂内必须动态 import 本模块，不得用顶层 import 绑定：
 * ```ts
 * vi.mock('vue-i18n', async () => {
 *   const { i18nMock } = await import('../../../__tests__/helpers/i18n-mock')
 *   return i18nMock({ 'panel.message.collapse': '收起' })
 * })
 * ```
 * （先例：packages/renderer/src/__tests__/vitest-i18n-setup.ts 的共享 mock 装配）
 */

/** 字典：i18n key → 测试断言用文案（'zh-CN' 口径） */
export type I18nMessages = Record<string, string>

/** `useI18n()` 的测试替身返回值 */
export interface I18nMock {
  useI18n: () => { t: (key: string, params?: Record<string, unknown>) => string }
}

/**
 * 构造 `vi.mock('vue-i18n', ...)` 工厂返回值（见文件头用法）。
 * t 为纯函数（无 locale 状态）：字典固定，props 不变则文案不变。
 */
export function i18nMock(messages: I18nMessages): I18nMock {
  const t = (key: string, params?: Record<string, unknown>): string => {
    let text = messages[key] ?? key
    if (params) {
      for (const [name, value] of Object.entries(params)) {
        text = text.replace(`{${name}}`, String(value))
      }
    }
    return text
  }
  return { useI18n: () => ({ t }) }
}
