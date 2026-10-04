/**
 * useAppUpdate 测试族共享的 renderMarkdown 桩（避免 SUT 加载 shiki WASM）。
 *
 * 拆成独立小模块且不 import SUT，原因：vi.mock 工厂经测试文件顶层 import 转发本导出
 * （范式同 i18n-toast-mock.ts），而 app-update-mount.ts 会 import SUT——SUT 解析
 * '@/composables/logic/markdown' 时 mock 工厂立即执行，此刻本模块必须已完成求值。
 * 因此测试文件里本模块的 import 行必须排在 app-update-mount 之前（重排会 ReferenceError，
 * 错误即时可见）。
 *
 * vitest 按测试文件隔离模块图：renderMarkdownMock 在每个测试文件内是独立实例。
 */
import { vi } from 'vitest'

/** renderMarkdown 桩 spy；默认解析 html 由 app-update-mount 的 lifecycle（markdownHtml）注入 */
export const renderMarkdownMock = vi.fn<(md: string) => Promise<string>>()

/** '@/composables/logic/markdown' mock 工厂（vi.mock 注册留在测试文件，见文件头） */
export function markdownStubModule(): { renderMarkdown: typeof renderMarkdownMock } {
  return { renderMarkdown: renderMarkdownMock }
}
