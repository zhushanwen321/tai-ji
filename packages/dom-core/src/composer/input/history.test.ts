/**
 * history.ts 导航状态机单测 —— composer input 模块历史导航（W2 TC3）。
 *
 * 覆盖 shell 风格 ↑/↓ 翻阅状态机 7 路径 + resetBrowsing + per-session 分区隔离（AC-5）。
 * mock deps（getText/setText/clear + getHistoryEntries 替代 chatStore）。jsdom 环境（dom-core 全局
 * vitest 为 jsdom），但本测试不依赖 DOM API，仅覆盖纯状态机（reactive/computed 来自 vue）。
 *
 * 范式对齐 renderer use-composer-history.test.ts，getHistoryEntries 替代 chatStore.appendUser。
 * [U8 草稿 segments 化] 进 browsing 快照走 getSegments、↓ 退回最近恢复走 restoreSegments
 * （segments 快照结构化回填，chips 保真）；历史中间条目仍走 setText 纯文本。
 * 运行：cd packages/dom-core && npx vitest run src/composer/input/history.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref, effectScope, type Ref } from 'vue'
import type { Segment } from '@taiji/shared'
import {
  useComposerHistory,
  type HistoryDeps,
} from './index'
import { __clearSessionCleanupRegistryForTest } from '@taiji/core/foundation/use-session-scoped-state'

beforeEach(() => {
  __clearSessionCleanupRegistryForTest()
})

/**
 * mock deps 工厂：记录 setText/clear 调用 + 可配 getHistoryEntries 返回。
 * [U8 草稿 segments 化] getSegments 返回 currentSegments 快照；restoreSegments 记录调用
 * 并按 text 段 join 同步 currentText（模拟真实回填链的 draft 镜像语义）。
 */
function makeDeps(
  historyEntries: string[] = [],
  overrides: Partial<{ getText: () => string; getSegments: () => Segment[] }> = {},
) {
  const setTextCalls: Array<{ text: string; caret?: string }> = []
  const restoreCalls: Segment[][] = []
  let currentText = ''
  let currentSegments: Segment[] = overrides.getSegments ? overrides.getSegments() : []
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
    getSegments: overrides.getSegments ?? vi.fn(() => currentSegments),
    restoreSegments: vi.fn((segments: Segment[]) => {
      restoreCalls.push(segments)
      currentSegments = segments
      currentText = segments.filter((s) => s.type === 'text').map((s) => s.text).join('')
    }),
  }
  return { deps, setTextCalls, restoreCalls }
}

/** 在 effectScope 内 setup composable（useSessionScopedState 需 active scope 注册 cleanup） */
function setupHistory(
  sessionId: string | null,
  historyEntries: string[],
  overrides: Partial<{ getText: () => string; getSegments: () => Segment[] }> = {},
) {
  const sidRef: Ref<string | null> = ref(sessionId)
  const { deps, setTextCalls, restoreCalls } = makeDeps(historyEntries, overrides)
  const scope = effectScope()
  const api = scope.run(() => useComposerHistory(sidRef, deps))!
  return { sidRef, deps, setTextCalls, restoreCalls, scope, ...api }
}

describe('useComposerHistory 状态机', () => {
  it('↑（edit 态 + 空历史）：不响应，return false', () => {
    const { handleArrowUp } = setupHistory('s1', [])
    expect(handleArrowUp()).toBe(false)
  })

  it('↑（edit 态 + 非空）：getSegments 快照存 savedSegments + setText(H[0], start) + 进 browsing', () => {
    const segments: Segment[] = [
      { type: 'text', text: 'my draft' },
      { type: 'skill', name: 'cw-cli' },
    ]
    const { handleArrowUp, setTextCalls, restoreCalls, isBrowsing } = setupHistory('s1', ['msg1', 'msg2'], {
      getSegments: () => segments,
    })
    expect(handleArrowUp()).toBe(true)
    expect(setTextCalls).toEqual([{ text: 'msg1', caret: 'start' }])
    expect(isBrowsing.value).toBe(true)
    // 进 browsing 未触发恢复（restoreSegments 只在 ↓ 退回最近时走）
    expect(restoreCalls).toEqual([])
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

  it('↓（browsing + 已在最近）：restoreSegments(savedSegments) + 退出 browsing（[U8] chips 结构化回填）', () => {
    const segments: Segment[] = [
      { type: 'text', text: 'original draft' },
      { type: 'image', id: 'i1', path: '/tmp/a.png', fileName: 'a.png', displayName: 'a.png' },
    ]
    const { handleArrowUp, handleArrowDown, restoreCalls, isBrowsing } = setupHistory('s1', ['msg1'], {
      getSegments: () => segments,
    })
    handleArrowUp() // 进 browsing，savedSegments=segments 快照
    handleArrowDown() // 已在最近 → 恢复草稿 + 退出
    expect(restoreCalls).toEqual([segments])
    expect(isBrowsing.value).toBe(false)
  })

  it('↓（edit 态）：不响应，return false', () => {
    const { handleArrowDown } = setupHistory('s1', ['msg1'])
    expect(handleArrowDown()).toBe(false)
  })
})

describe('isBrowsingFor / getSavedSegments（R2-A6 按 sid 显式读）', () => {
  it('browsing 分区：按旧 sid 显式读 browsing 态与进 browsing 前的草稿 segments 快照', () => {
    const segments: Segment[] = [
      { type: 'text', text: 'my draft' },
      { type: 'skill', name: 'cw-cli', location: '/skills/cw-cli/SKILL.md' },
    ]
    const { handleArrowUp, isBrowsingFor, getSavedSegments } = setupHistory('s1', ['msg1'], {
      getSegments: () => segments,
    })
    expect(handleArrowUp()).toBe(true)
    // 输入区已被历史条目替换——用户真实输入（含 chip 结构）只能按 sid 显式取
    expect(isBrowsingFor('s1')).toBe(true)
    expect(getSavedSegments('s1')).toEqual(segments)
  })

  it('session 切换后：新分区 browsing 恒 false / 草稿空，旧 sid 分区仍可显式读', () => {
    const { handleArrowUp, sidRef, isBrowsingFor, getSavedSegments } = setupHistory('s1', ['msg1'], {
      getText: () => 'old input',
    })
    handleArrowUp() // s1 进 browsing + savedSegments 快照（getSegments 缺省 mock 返回 []）
    sidRef.value = 's2' // 切换 watch 回调时刻 sidRef 已是新值——isBrowsing 读不到旧分区
    expect(isBrowsingFor('s2')).toBe(false)
    expect(getSavedSegments('s2')).toEqual([])
    expect(isBrowsingFor('s1')).toBe(true)
    expect(getSavedSegments('s1')).toEqual([])
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
    // useComposerHistory 内部用 isSettingText 检查，这里验证 browsing 态不被破坏
    const { handleArrowUp, isBrowsing } = setupHistory('s1', ['msg1'])
    handleArrowUp()
    expect(isBrowsing.value).toBe(true) // browsing 保持，未被内部 setText 触发的 reset 破坏
  })
})

describe('per-session 分区隔离（AC-5 草稿恢复）', () => {
  it('切 sid 切分区：A session browsing 态切到 B 再切回 A，恢复 browsing + 草稿指针', () => {
    const { sidRef, handleArrowUp, handleArrowDown, restoreCalls } = setupHistory('s1', ['msg1'])
    handleArrowUp() // s1 进 browsing, savedSegments=[]
    // 切到 s2（无历史）
    sidRef.value = 's2'
    // 切回 s1
    sidRef.value = 's1'
    // s1 应仍在 browsing 态（分区保留），↓ 应恢复草稿（restoreSegments 空快照）
    handleArrowDown()
    expect(restoreCalls).toEqual([[]])
  })

  it('null sid：history 为空，↑ 不响应', () => {
    const { handleArrowUp, isBrowsing } = setupHistory(null, ['ignored'])
    expect(handleArrowUp()).toBe(false)
    expect(isBrowsing.value).toBe(false)
  })
})
