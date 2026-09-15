/**
 * notify-toast 单测 —— extension notify 的壳层编排（session 定位行 + 前台/后台分级过滤）。
 *
 * 覆盖：
 * 1. buildSessionLocator：
 *    - 显式/rename label → `{label} · {目录名}`
 *    - label 为派生值（basename(cwd)）且首条 user prompt 存在 → `{prompt 前 15 字} · {目录名}`
 *      （rename-session 未触发窗口的兜底，用户裁决）
 *    - 派生 label + prompt 缺失（分区被 LRU 驱逐/尚无 user 消息）→ 只显示目录名
 *    - session 不在 store / sessionId 缺失 → null（不渲染定位行）
 * 2. shouldShowSessionNotify：
 *    - 无 sessionId（plugin-crashed 等全局事件）→ 照弹
 *    - error / warning / warn → 照弹（需行动）
 *    - info + 前台（focused）→ 照弹（命令回显唯一反馈通道）
 *    - info + 后台 → 丢弃（goal start/budget70 等过程噪音）
 *
 * 运行：cd packages/renderer && npx vitest run src/composables/shell/__tests__/notify-toast.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { shallowRef } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { Message, SessionGroup } from '@taiji/shared'
import { useSessionStore } from '@/stores/session'
import { useChatStore } from '@/stores/chat'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import { useToast } from '@/composables/useToast'
import { buildSessionLocator, shouldShowSessionNotify, createNotifyToastHandler } from '../notify-toast'

/** 最小 SessionSummary（buildSessionLocator 只读 id/label/cwd） */
function summary(id: string, label: string, cwd: string): SessionGroup['sessions'][number] {
  return {
    id,
    label,
    cwd,
    status: 'running',
    lastActiveAt: 0,
    modelId: 'm',
    tokenCount: 0,
  } as SessionGroup['sessions'][number]
}

function userMessage(text: string): Message {
  return {
    id: 'msg-1',
    role: 'user',
    content: text,
    status: 'complete',
    timestamp: 0,
  }
}

/** 填 session 列表（整表快照形态，对齐 runtime config.sessions 广播） */
function seedSessions(sessions: SessionGroup['sessions'][number][]): void {
  useSessionStore().applySnapshot({
    groups: [{ cwd: '/tmp/group', sessions }],
  })
}

/** 填 chat 分区（模拟首条 user prompt 已进对话流） */
function seedUserPrompt(sessionId: string, text: string): void {
  useChatStore().messages.set(sessionId, shallowRef([userMessage(text)]))
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('buildSessionLocator 定位行组装', () => {
  it('显式 label → `label · 目录名`', () => {
    seedSessions([summary('s1', '修通知组件', '/Users/z/Code/taiji')])
    expect(buildSessionLocator('s1')).toBe('修通知组件 · taiji')
  })

  it('派生 label（= basename）+ prompt 存在 → `prompt 前 15 字 · 目录名`', () => {
    seedSessions([summary('s2', 'taiji', '/Users/z/Code/taiji')])
    seedUserPrompt('s2', '帮我优化右下角的通知组件显示')
    expect(buildSessionLocator('s2')).toBe('帮我优化右下角的通知组件显示 · taiji')
  })

  it('prompt 超 15 字截断；多空白折叠为单空格', () => {
    seedSessions([summary('s3', 'repo', '/Users/z/Code/repo')])
    seedUserPrompt('s3', '这是一个  超长的\n用户提示词需要被截断到十五个字符以内才对')
    expect(buildSessionLocator('s3')).toBe('这是一个 超长的 用户提示词需 · repo')
  })

  it('派生 label + 无 prompt（分区缺失）→ 只显示目录名', () => {
    seedSessions([summary('s4', 'repo', '/Users/z/Code/repo')])
    expect(buildSessionLocator('s4')).toBe('repo')
  })

  it('session 不在 store → null（退化纯消息，不渲染定位行）', () => {
    seedSessions([])
    expect(buildSessionLocator('unknown')).toBeNull()
  })

  it('sessionId 缺失 → null', () => {
    expect(buildSessionLocator(undefined)).toBeNull()
  })

  it('Windows 风格路径分隔符也取最后段', () => {
    seedSessions([summary('s5', 'repo', 'C:\\Users\\z\\Code\\repo')])
    expect(buildSessionLocator('s5')).toBe('repo')
  })
})

describe('shouldShowSessionNotify 前台/后台分级', () => {
  beforeEach(() => {
    seedSessions([summary('bg', 'repo', '/tmp/repo'), summary('fg', 'repo', '/tmp/repo')])
    usePanelStore().loadSession(ROOT_PANEL_ID, 'fg')
  })

  it('无 sessionId → 照弹（全局事件保守不丢）', () => {
    expect(shouldShowSessionNotify(undefined, 'info')).toBe(true)
    expect(shouldShowSessionNotify(undefined, undefined)).toBe(true)
  })

  it('error / warning / warn → 无论前后台都弹', () => {
    expect(shouldShowSessionNotify('bg', 'error')).toBe(true)
    expect(shouldShowSessionNotify('bg', 'warning')).toBe(true)
    expect(shouldShowSessionNotify('bg', 'warn')).toBe(true)
  })

  it('info + 前台（focused）→ 弹（命令回显唯一反馈通道）', () => {
    expect(shouldShowSessionNotify('fg', 'info')).toBe(true)
  })

  it('info + 后台 → 丢弃（goal start/budget70 等过程噪音）', () => {
    expect(shouldShowSessionNotify('bg', 'info')).toBe(false)
  })
})

describe('createNotifyToastHandler 装配（真实 useToast 入口）', () => {
  /** toast 模块单例是跨用例共享状态，取末条断言 + 用后清空 */
  const { toasts, remove } = useToast()

  function lastToast() {
    return toasts.value[toasts.value.length - 1]
  }

  beforeEach(() => {
    seedSessions([summary('bg', '修通知', '/tmp/repo'), summary('fg', '修通知', '/tmp/repo')])
    usePanelStore().loadSession(ROOT_PANEL_ID, 'fg')
    while (toasts.value.length > 0) remove(toasts.value[0].id)
  })

  it('error → toast type=error，sessionLabel + sessionId 双透传（定位行可渲染可跳转）', () => {
    createNotifyToastHandler()('goal blocked', 'error', 'bg')
    const t = lastToast()
    expect(t.type).toBe('error')
    expect(t.sessionLabel).toBe('修通知 · repo')
    expect(t.sessionId).toBe('bg') // 回归：曾漏传致定位行永不渲染
  })

  it('warn / warning → 归一为 warning；其余 → info', () => {
    const show = createNotifyToastHandler()
    show('w1', 'warn', 'bg')
    expect(lastToast().type).toBe('warning')
    show('w2', 'info', 'fg')
    expect(lastToast().type).toBe('info')
  })

  it('info + 后台 session → 不入列（过滤生效）', () => {
    const before = toasts.value.length
    createNotifyToastHandler()('budget 70%', 'info', 'bg')
    expect(toasts.value.length).toBe(before)
  })

  it('sessionId 非字符串 → 归一 undefined，不设 sessionId 字段（无定位行纯消息）', () => {
    createNotifyToastHandler()('plugin crashed', 'error', null)
    const t = lastToast()
    expect(t.type).toBe('error')
    expect(t.sessionId).toBeUndefined()
    expect(t.sessionLabel).toBeUndefined()
  })
})
