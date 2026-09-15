/**
 * Turn file badge 渲染单测（W5, U14）。
 *
 * 验证 file segment 在消息流渲染为绿色 badge（FR-7）：
 * - 观察者（形态）：含 file segment 的消息渲染绿色 badge（FileText icon + basename + 行范围后缀）
 * - 使用者（黑盒）：点击 badge 调用 selectFile + openDrawer('detail')
 * - 构建者（白盒）：userSegments 遍历 seg.type==='file' 分支
 *
 * 运行：npx vitest run src/__tests__/panel/turn-file-badge.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
// [w6 chat-ui-and-shell T7] ui 包 UserBubble 经 ChatViewDeps inject 消费 onFileClick/openDrawer（原 useSideDrawer/fileTree mock 失效）
import { Turn } from '@taiji/ui'
import type { MessageTurn } from '@/composables/logic/messageTurns'
import type { Message } from '@taiji/shared'
import { mockChatProvide } from '@/__tests__/helpers/chat-view-deps'

const mockOpenDrawer = vi.fn()
const mockSelectFile = vi.fn()

function makeTurn(userOver: Partial<Message> = {}): MessageTurn {
  return {
    index: 1,
    user: {
      id: 'u1',
      role: 'user',
      content: [{ type: 'text', text: '看下这个文件' }],
      status: 'complete',
      timestamp: Date.now(),
      ...userOver,
    },
    assistants: [],
    isStreaming: false,
    hasFoldable: false,
  }
}

function mountTurn(turn: MessageTurn, sessionId = 's1') {
  return mount(Turn, {
    props: { turn, sessionId },
    global: {
      plugins: [createPinia()],
      provide: mockChatProvide({ onFileClick: mockSelectFile, openDrawer: mockOpenDrawer }),
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  mockOpenDrawer.mockClear()
  mockSelectFile.mockClear()
})

describe('W5: Turn file badge 渲染（FR-7）', () => {
  it('U14: file segment 渲染绿色 badge（basename + L10-L20 + tooltip 全路径）', () => {
    const turn = makeTurn({
      content: [
        { type: 'file', path: 'src/foo.ts', lineRange: [10, 20] },
        { type: 'text', text: ' 这里有问题' },
      ],
    })
    const wrapper = mountTurn(turn)

    const badge = wrapper.find('[data-testid^="msg-file-badge"]')
    expect(badge.exists()).toBe(true)
    // basename + 行范围后缀
    expect(badge.text()).toContain('foo.ts')
    expect(badge.text()).toContain('L10-L20')
    // tooltip 全路径
    expect(badge.attributes('title')).toBe('src/foo.ts')
    // 绿色 badge（--success token）
    expect(badge.classes().some((c) => c.includes('text-success'))).toBe(true)
  })

  it('U14b: file segment 无行范围时 badge 只显 basename', () => {
    const turn = makeTurn({
      content: [{ type: 'file', path: 'src/bar.ts' }],
    })
    const wrapper = mountTurn(turn)

    const badge = wrapper.find('[data-testid^="msg-file-badge"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toContain('bar.ts')
    expect(badge.text()).not.toContain('L')
  })

  it('U14c: 单行 lineRange 显示 L<n>（非 L<n>-L<n>）', () => {
    const turn = makeTurn({
      content: [{ type: 'file', path: 'a.ts', lineRange: [5, 5] }],
    })
    const wrapper = mountTurn(turn)

    const badge = wrapper.find('[data-testid^="msg-file-badge"]')
    expect(badge.text()).toContain('L5')
    expect(badge.text()).not.toContain('L5-L5')
  })

  it('U14d: 点击 badge 调 selectFile + openDrawer detail', async () => {
    const turn = makeTurn({
      content: [{ type: 'file', path: 'src/foo.ts', lineRange: [10, 20] }],
    })
    const wrapper = mountTurn(turn)

    await wrapper.find('[data-testid^="msg-file-badge"]').trigger('click')
    expect(mockSelectFile).toHaveBeenCalledWith('src/foo.ts')
    expect(mockOpenDrawer).toHaveBeenCalledWith('detail', { filePath: 'src/foo.ts' })
  })
})
