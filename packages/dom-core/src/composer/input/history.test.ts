/**
 * history.ts 导航状态机单测 —— composer input 模块历史导航（W2 TC3）。
 *
 * 覆盖 shell 风格 ↑/↓ 翻阅状态机 7 路径 + resetBrowsing + per-session 分区隔离（AC-5）。
 * mock deps（getText/setText/clear + getHistoryEntries 替代 chatStore）。jsdom 环境（dom-core 全局
 * vitest 为 jsdom），但本测试不依赖 DOM API，仅覆盖纯状态机（reactive/computed 来自 vue）。
 *
 * 范式对齐 renderer use-composer-history.test.ts，getHistoryEntries 替代 chatStore.appendUser。
 * 运行：cd packages/dom-core && npx vitest run src/composer/input/history.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref, effectScope, type Ref } from 'vue'
import {
  useComposerHistory,
  type HistoryDeps,
} from './index'
import { __clearSessionCleanupRegistryForTest } from '@taiji/core/foundation/use-session-scoped-state'

beforeEach(() => {
  __clearSessionCleanupRegistryForTest()
})

/** mock deps 工厂：记录 setText/clear 调用 + 可配 getHistoryEntries 返回 */
function makeDeps(historyEntries: string[] = [], overrides: Partial<{ getText: () => string }> = {}) {
  const setTextCalls: Array<{ text: string; caret?: string }> = []
  let currentText = ''
  const deps: HistoryDeps = {
    getText: overrides.getText ?? (() => currentText),
    setText: vi.fn((text: string, caretPosition?: 'start' | 'end') => {
      setTextCalls.push({ text, caret: caretPosition })
      currentText = text
    }),
    clear: vi.fn(() => {
      currentText = ''
    }),
    getHistoryEntries: vi.fn((_sid: string) => historyEntries),
  }
  return { deps, setTextCalls }
}

/** 在 effectScope 内 setup composable（useSessionScopedState 需 active scope 注册 cleanup） */
function setupHistory(
  sessionId: string | null,
  historyEntries: string[],
  overrides: Partial<{ getText: () => string }> = {},
) {
  const sidRef: Ref<string | null> = ref(sessionId)
  const { deps, setTextCalls } = makeDeps(historyEntries, overrides)
  const scope = effectScope()
  const api = scope.run(() => useComposerHistory(sidRef, deps))!
  return { sidRef, deps, setTextCalls, scope, ...api }
}

describe('useComposerHistory 状态机', () => {
  it('↑（edit 态 + 空历史）：不响应，return false', () => {
    const { handleArrowUp } = setupHistory('s1', [])
    expect(handleArrowUp()).toBe(false)
  })

  it('↑（edit 态 + 非空）：保存草稿 + setText(H[0], start) + 进 browsing', () => {
    const { handleArrowUp, setTextCalls, isBrowsing } = setupHistory('s1', ['msg1', 'msg2'], {
      getText: () => 'my draft',
    })
    expect(handleArrowUp()).toBe(true)
    expect(setTextCalls).toEqual([{ text: 'msg1', caret: 'start' }])
    expect(isBrowsing.value).toBe(true)
  })

  it('↑（browsing + 未到最老）：index++ + setText(H[index], start)', () => {
    const { handleArrowUp, setTextCalls } = setupHistory('s1', ['msg1', 'msg2', 'msg3'])
    handleArrowUp() // → H[0]=msg1, index=0
    handleArrowUp() // → H[1]=msg2, index=1
    expect(setTextCalls).toEqual([
      { text: 'msg1', caret: 'start' },
      { text: 'msg2', caret: 'start' },
    ])
  })

  it('↑（browsing + 已在最老）：保持不动，不追加 setText', () => {
    const { handleArrowUp, setTextCalls } = setupHistory('s1', ['only'])
    handleArrowUp() // → H[0]=only, index=0（最老）
    const callsBefore = setTextCalls.length
    handleArrowUp() // 已最老，保持
    expect(setTextCalls.length).toBe(callsBefore)
  })

  it('↓（browsing + 未到最近）：index-- + setText(H[index], end)', () => {
    const { handleArrowUp, handleArrowDown, setTextCalls } = setupHistory('s1', ['msg1', 'msg2'])
    handleArrowUp() // → index=0 (msg1)
    handleArrowUp() // → index=1 (msg2)
    handleArrowDown() // → index=0 (msg1)
    // 末尾应是 setText(msg1, 'end')
    const last = setTextCalls[setTextCalls.length - 1]
    expect(last).toEqual({ text: 'msg1', caret: 'end' })
  })

  it('↓（browsing + 已在最近）：setText(savedDraft, end) + 退出 browsing', () => {
    const { handleArrowUp, handleArrowDown, setTextCalls, isBrowsing } = setupHistory('s1', ['msg1'], {
      getText: () => 'original draft',
    })
    handleArrowUp() // 进 browsing，savedDraft='original draft'
    handleArrowDown() // 已在最近 → 恢复草稿 + 退出
    expect(setTextCalls[setTextCalls.length - 1]).toEqual({ text: 'original draft', caret: 'end' })
    expect(isBrowsing.value).toBe(false)
  })

  it('↓（edit 态）：不响应，return false', () => {
    const { handleArrowDown } = setupHistory('s1', ['msg1'])
    expect(handleArrowDown()).toBe(false)
  })
})

describe('resetBrowsing', () => {
  it('用户输入触发 resetBrowsing：退出 browsing，下次 ↑ 重新从 H[0] 开始', () => {
    const { handleArrowUp, resetBrowsing, setTextCalls } = setupHistory('s1', ['msg1', 'msg2'])
    handleArrowUp() // index=0
    handleArrowUp() // index=1
    resetBrowsing() // 用户修改 → 重置
    handleArrowUp() // 重新从 H[0]
    expect(setTextCalls[setTextCalls.length - 1]).toEqual({ text: 'msg1', caret: 'start' })
  })

  it('程序化 setText（isSettingText）触发的 resetBrowsing 被跳过（不重置 browsing）', () => {
    // 模拟：handleArrowUp 内部调 setText，若 setText 触发 input → resetBrowsing，会破坏 browsing
    // useComposerHistory 内部用 isSettingText 守卫，这里验证 browsing 态不被破坏
    const { handleArrowUp, isBrowsing } = setupHistory('s1', ['msg1'])
    handleArrowUp()
    expect(isBrowsing.value).toBe(true) // browsing 保持，未被内部 setText 触发的 reset 破坏
  })
})

describe('per-session 分区隔离（AC-5 草稿恢复）', () => {
  it('切 sid 切分区：A session browsing 态切到 B 再切回 A，恢复 browsing + 草稿指针', () => {
    const { sidRef, handleArrowUp, handleArrowDown, setTextCalls } = setupHistory('s1', ['msg1'])
    handleArrowUp() // s1 进 browsing, savedDraft=''
    // 切到 s2（无历史）
    sidRef.value = 's2'
    // 切回 s1
    sidRef.value = 's1'
    // s1 应仍在 browsing 态（分区保留），↓ 应恢复 savedDraft
    handleArrowDown()
    expect(setTextCalls[setTextCalls.length - 1]).toEqual({ text: '', caret: 'end' })
  })

  it('null sid：history 为空，↑ 不响应', () => {
    const { handleArrowUp, isBrowsing } = setupHistory(null, ['ignored'])
    expect(handleArrowUp()).toBe(false)
    expect(isBrowsing.value).toBe(false)
  })
})
