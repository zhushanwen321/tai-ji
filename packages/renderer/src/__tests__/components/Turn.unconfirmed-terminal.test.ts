/**
 * 断连未确认终局的用户可见呈现（ADR-0112 事实驱动 / defense-mechanism-cleanup 遗留 5，
 * command-pi-restart-response-loss 终局③ 的渲染面锁定）。
 *
 * 链路分工（两段测试拼合出完整证据链，本文件锁第二段的真实 DOM 跳）：
 * - core 层（packages/core use-chat-disposition.test.ts）：message.error「执行结果未确认」
 *   帧 → chat store error 气泡（Message.error 字段含 runtime 显式上报文案）；
 * - 本文件（渲染层）：同一 Message 形状经真实 Turn → Block 渲染树，产出用户可见的
 *   「未确认」文案 danger 行（data-testid="block-text-error"，Block.vue M2 追加形态）。
 *
 * 观察者视角（用户可见 DOM 断言）：断连后在途命令条目的终态提示「执行结果未确认…
 * 重发前请核对」作为独立 danger 行出现在对话流——不得静默悬挂。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/Turn.unconfirmed-terminal.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { Turn } from '@taiji/ui'
import type { MessageTurn } from '@/composables/logic/messageTurns'
import type { Message } from '@taiji/shared'
import { mockChatProvide } from '@/__tests__/helpers/chat-view-deps'

// __APP_VERSION__ 是 vite define 注入的全局常量，vitest 下不存在，stub 之（同 Turn.smoke.test.ts）
vi.stubGlobal('__APP_VERSION__', '0.0.0-test')

/** runtime onPiDisconnected 显式上报文案（session-delivery-registry 帧载荷逐字形态） */
const UNCONFIRMED_TEXT = '执行结果未确认（pi 连接已断开），重发前请核对：/todos'

/** 断连终局 error 气泡（core terminalErrorEffect 产出形态：纯 error 追加形态，content 空） */
function makeTurn(): MessageTurn {
  const errMsg: Message = {
    id: 'a-err-1',
    role: 'assistant',
    content: '',
    error: UNCONFIRMED_TEXT,
    status: 'error',
    timestamp: Date.now(),
  }
  return {
    index: 0,
    user: null,
    assistants: [errMsg],
    isStreaming: false,
    hasFoldable: false,
  }
}

function mountTurn() {
  return mount(Turn, {
    props: { turn: makeTurn(), sessionId: 's-unconfirmed' },
    global: {
      plugins: [createPinia()],
      provide: mockChatProvide(),
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('断连未确认终局呈现（渲染面）', () => {
  it('error 气泡渲染「执行结果未确认」独立 danger 行（用户可见文案节点，非静默悬挂）', () => {
    const wrapper = mountTurn()
    // 用户可见 DOM 断言 ①：独立 error danger 行节点存在（Block.vue M2 追加形态 SSOT testid）
    const errorRow = wrapper.find('[data-testid="block-text-error"]')
    expect(errorRow.exists()).toBe(true)
    // ②：「未确认」语义文案完整可见（含恢复指引「重发前请核对」）
    expect(errorRow.text()).toContain('执行结果未确认')
    expect(errorRow.text()).toContain('重发前请核对')
    // ③：danger 色（错误视觉通道），且正文区不染 danger（错误只住 error 行，M2 形态不变量）
    expect(errorRow.classes()).toContain('text-danger')
    wrapper.unmount()
  })
})
