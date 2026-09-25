/**
 * 聊天流壳测试共享 mock 单例（Wave C r2-05 chatDepsMock 收敛）。
 *
 * 12 个 MessageStream 族测试文件曾逐字复制同一份 20 键 chatDepsMock（vi.hoisted 块）+
 * useChatViewDeps mock 注册。收敛到本 helper 单源；vi.mock 注册留在测试文件（mock 是
 * 文件作用域，工厂经顶层 import 转发本 helper 导出——同 sidebar-mount.ts 先例）。
 *
 * vitest 按测试文件隔离模块图：chatDepsMock 单例在每个测试文件内是独立实例（文件内
 * mock 工厂与断言共享同一批 vi.fn，与原 vi.hoisted 文件内单例语义一致）。
 *
 * 变体保留未收敛：
 * - MessageStream-truncated-bar.test.ts：文件内联 vi.hoisted 版（键面与本单例同形维护）
 * - 各文件内联的 virtua/vue 模块 mock（keepMounted/scrollRef props 与渲染循环互为变体）
 */
import { vi } from 'vitest'

/** 聊天流壳 deps mock 单例（ChatViewDeps 全字段必填默认面，零真 store；测试可断言 vi.fn 调用）。 */
export const chatDepsMock = {
  isActive: vi.fn(() => false),
  isHandingOff: vi.fn(() => false),
  getChangeSetStatus: vi.fn(() => undefined),
  isExpanded: vi.fn(() => false),
  isTakeover: vi.fn(() => false),
  isPendingSend: vi.fn(() => false),
  sessionCwdOf: vi.fn(() => undefined),
  toggleExpand: vi.fn(),
  collapse: vi.fn(),
  setTakeover: vi.fn(),
  abortBash: vi.fn(),
  editAndResend: vi.fn(),
  onRevokeMessage: vi.fn(),
  onForkAsk: vi.fn(),
  onHandoffAsk: vi.fn(),
  openDrawer: vi.fn(),
  onFileClick: vi.fn(),
  loadFileCandidates: vi.fn(() => Promise.resolve([])),
  renderMarkdown: vi.fn(() => Promise.resolve([])),
  renderMarkdownIncremental: vi.fn(() =>
    Promise.resolve({
      prefixSegments: [],
      tailSegments: [],
      stableBoundary: 0,
      mode: 'incremental' as const,
      cache: { boundary: 0, prefixText: '', prefixSegments: [], nextSegId: 0 },
    }),
  ),
  // [审计候选 18] 谓词注入收单阈值字段；默认大阈值 = 静默路径不触发（等价原 () => false 默认）
  streamingFenceSilenceMs: 60_000,
  renderMermaid: vi.fn(() => Promise.resolve({ svg: '' })),
  toMarkdown: vi.fn(() => ''),
}

/** '@/composables/panel/useChatViewDeps' mock 工厂（转发 chatDepsMock 单例）。 */
export function chatViewDepsModule() {
  return {
    useChatViewDeps: () => chatDepsMock,
  }
}
