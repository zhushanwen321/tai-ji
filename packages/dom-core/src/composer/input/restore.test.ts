/**
 * restore.ts composable 单测 —— composer 发送后清空 / 失败恢复（W2 TC）。
 *
 * 覆盖：clearInput（draft 置空 + drafts.delete 边界：sid=null 不删 + inputRef.clear）、
 * restoreInput（draft 同步 + setText）、restoreSegments（7 段类型分发：text 过滤 join /
 * image→insertImageBadge 含 needsMigrate ?? false 空值合并 / slash→insertSlashChip(name) /
 * skill→insertSkillChip(name, location)（设计 D3）/ file→insertFileChip lineRange 透传 /
 * session→insertSessionChip / subagent→insertSubagentChip）。
 *
 * restore.ts 自述「纯逻辑编排，零 DOM 直连」，故本测试零 jsdom DOM 断言，全 mock deps。
 *
 * 运行：cd packages/dom-core && npx vitest run src/composer/input/restore.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import { useComposerRestore } from './restore'
import type { ComposerRestoreDeps, DraftStore } from './types'
import type { ComposerInputInstance } from '@taiji/core/domain/composer'
import type { Segment } from '@taiji/shared'

/** mock ComposerInputInstance（clear/setText/insertImageBadge/insertSlashChip/insertFileChip
 * + U2b session/subagent chip 插入） */
function makeInputInstance(overrides: Partial<ComposerInputInstance> = {}): ComposerInputInstance {
  return {
    clear: vi.fn(),
    setText: vi.fn(),
    insertImageBadge: vi.fn(),
    insertSlashChip: vi.fn(),
    insertSkillChip: vi.fn(),
    insertFileChip: vi.fn(),
    insertSessionChip: vi.fn(),
    insertSubagentChip: vi.fn(),
    focus: vi.fn(),
    insertTextAtCursor: vi.fn(),
    ...overrides,
  } as unknown as ComposerInputInstance
}

/** mock DraftStore（ADR-0049：窄接口替代 Map<string,string>，spy 可断言调用） */
function makeDraftStore(initial?: Map<string, string>): DraftStore & { _store: Map<string, string> } {
  const store = initial ?? new Map<string, string>()
  return {
    _store: store,
    getDraft: vi.fn((sid: string) => store.get(sid) ?? ''),
    saveDraft: vi.fn((sid: string, text: string) => store.set(sid, text)),
    deleteDraft: vi.fn((sid: string) => store.delete(sid)),
  }
}

/** setup：构造 ComposerRestoreDeps（draft/inputRef/draftStore/sessionId） */
function setup(sessionId: string | null = 's1') {
  const draft = ref('')
  const inputRef = ref<ComposerInputInstance | null>(makeInputInstance())
  const drafts = makeDraftStore()
  const deps: ComposerRestoreDeps = {
    draft,
    inputRef,
    drafts,
    sessionId: ref(sessionId),
  }
  const api = useComposerRestore(deps)
  return { draft, inputRef, drafts, deps, ...api }
}

describe('useComposerRestore clearInput', () => {
  it('sid 非空：draft 置空 + drafts.deleteDraft(sid) + inputRef.clear()', () => {
    const c = setup('s1')
    c.drafts.saveDraft('s1', '保留草稿')
    c.draft.value = '待发送'
    c.clearInput()
    expect(c.draft.value).toBe('')
    // ADR-0049：deleteDraft 经工厂 cleanup 移除分区（spy 验证调用）
    expect(c.drafts.deleteDraft).toHaveBeenCalledWith('s1')
    expect(c.drafts._store.has('s1')).toBe(false)
    expect(c.inputRef.value?.clear).toHaveBeenCalled()
  })

  it('sid=null：draft 置空 + 不调 deleteDraft + 仍调 inputRef.clear()', () => {
    const c = setup(null)
    c.drafts.saveDraft('other', '其他 session 草稿')
    c.draft.value = 'x'
    c.clearInput()
    expect(c.draft.value).toBe('')
    // sid 为 null 时不调 drafts.deleteDraft（边界：landing 态）
    expect(c.drafts.deleteDraft).not.toHaveBeenCalled()
    expect(c.drafts._store.has('other')).toBe(true)
    expect(c.inputRef.value?.clear).toHaveBeenCalled()
  })

  it('inputRef 为 null：clearInput 不抛错', () => {
    const c = setup('s1')
    c.deps.inputRef.value = null
    expect(() => c.clearInput()).not.toThrow()
    expect(c.draft.value).toBe('')
  })
})

describe('useComposerRestore restoreInput', () => {
  it('draft 同步 + inputRef.setText(text)', () => {
    const c = setup('s1')
    c.restoreInput('恢复文本')
    expect(c.draft.value).toBe('恢复文本')
    expect(c.inputRef.value?.setText).toHaveBeenCalledWith('恢复文本')
  })
})

describe('useComposerRestore restoreSegments', () => {
  it('纯 text 段：过滤 join 后 restoreInput，不调任何 insert chip', () => {
    const c = setup('s1')
    const segments: Segment[] = [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }]
    c.restoreSegments(segments)
    expect(c.inputRef.value?.setText).toHaveBeenCalledWith('hello world')
    expect(c.inputRef.value?.insertImageBadge).not.toHaveBeenCalled()
    expect(c.inputRef.value?.insertSlashChip).not.toHaveBeenCalled()
    expect(c.inputRef.value?.insertFileChip).not.toHaveBeenCalled()
  })

  it('image 段 needsMigrate undefined → insertImageBadge 第 4 参走 ?? false（空值合并分支）', () => {
    const c = setup('s1')
    const segments: Segment[] = [
      { type: 'text', text: '看图' },
      { type: 'image', id: 'i1', path: '/tmp/a.png', fileName: 'a.png', displayName: '截图.png' },
    ]
    c.restoreSegments(segments)
    expect(c.inputRef.value?.setText).toHaveBeenCalledWith('看图')
    expect(c.inputRef.value?.insertImageBadge).toHaveBeenCalledWith('/tmp/a.png', 'a.png', '截图.png', false)
  })

  it('image 段 needsMigrate=true → insertImageBadge 第 4 参传 true', () => {
    const c = setup('s1')
    const segments: Segment[] = [
      {
        type: 'image',
        id: 'i2',
        path: '/tmp/b.png',
        fileName: 'b.png',
        displayName: 'b.png',
        needsMigrate: true,
      },
    ]
    c.restoreSegments(segments)
    expect(c.inputRef.value?.insertImageBadge).toHaveBeenCalledWith('/tmp/b.png', 'b.png', 'b.png', true)
  })

  it('skill 段 → insertSkillChip(name, location) 通路（设计 D3：不删其他 chip、带 location 回滚）', () => {
    const c = setup('s1')
    const segments: Segment[] = [
      { type: 'skill', name: 'cw-cli', location: '/skills/cw-cli/SKILL.md' },
    ]
    c.restoreSegments(segments)
    // 纯 skill 段（无 text）→ restoreInput('') 先调 setText('')
    expect(c.inputRef.value?.setText).toHaveBeenCalledWith('')
    expect(c.inputRef.value?.insertSkillChip).toHaveBeenCalledWith('cw-cli', '/skills/cw-cli/SKILL.md')
    // 不再走 insertSlashChip 老通路（误删其他 slash-chip + 强制最前 + 丢 location）
    expect(c.inputRef.value?.insertSlashChip).not.toHaveBeenCalled()
  })

  it('skill 段无 location → insertSkillChip(name, undefined)', () => {
    const c = setup('s1')
    const segments: Segment[] = [{ type: 'skill', name: 'cw-cli' }]
    c.restoreSegments(segments)
    expect(c.inputRef.value?.insertSkillChip).toHaveBeenCalledWith('cw-cli', undefined)
    expect(c.inputRef.value?.insertSlashChip).not.toHaveBeenCalled()
  })

  it('slash 段 → insertSlashChip(name) 命令 chip 形态恢复（设计 D4：name 不含 / 前缀，函数内归一化补回）', () => {
    const c = setup('s1')
    const segments: Segment[] = [
      { type: 'slash', name: 'compact' },
      { type: 'text', text: '清理一下' },
    ]
    c.restoreSegments(segments)
    // text 段照常 setText；slash 段不进 textOnly（name 不混入恢复文本）
    expect(c.inputRef.value?.setText).toHaveBeenCalledWith('清理一下')
    expect(c.inputRef.value?.insertSlashChip).toHaveBeenCalledWith('compact')
  })

  it('slash 段不带 location 概念：与 skill 段互不串扰（slash 走 insertSlashChip、skill 走 insertSkillChip）', () => {
    const c = setup('s1')
    const segments: Segment[] = [
      { type: 'slash', name: 'compact' },
      { type: 'skill', name: 'cw-cli', location: '/sk.md' },
    ]
    c.restoreSegments(segments)
    expect(c.inputRef.value?.insertSlashChip).toHaveBeenCalledWith('compact')
    expect(c.inputRef.value?.insertSkillChip).toHaveBeenCalledWith('cw-cli', '/sk.md')
  })

  it('file 段带 lineRange → insertFileChip(path, lineRange) 透传', () => {
    const c = setup('s1')
    const segments: Segment[] = [{ type: 'file', path: '/a.ts', lineRange: [10, 20] }]
    c.restoreSegments(segments)
    expect(c.inputRef.value?.insertFileChip).toHaveBeenCalledWith('/a.ts', [10, 20])
  })

  it('file 段无 lineRange → insertFileChip(path, undefined)', () => {
    const c = setup('s1')
    const segments: Segment[] = [{ type: 'file', path: '/b.ts' }]
    c.restoreSegments(segments)
    expect(c.inputRef.value?.insertFileChip).toHaveBeenCalledWith('/b.ts', undefined)
  })

  it('混合 4 类型：先 restoreInput(text 拼接) 再按序 insert 各 chip', () => {
    const c = setup('s1')
    const segments: Segment[] = [
      { type: 'text', text: 'pre ' },
      { type: 'image', id: 'i', path: '/i.png', fileName: 'i.png', displayName: 'i.png', needsMigrate: false },
      { type: 'skill', name: 's', location: '/skills/s/SKILL.md' },
      { type: 'file', path: '/f.ts', lineRange: [1, 2] },
      { type: 'text', text: ' post' },
    ]
    c.restoreSegments(segments)
    expect(c.inputRef.value?.setText).toHaveBeenCalledWith('pre  post')
    expect(c.inputRef.value?.insertImageBadge).toHaveBeenCalledWith('/i.png', 'i.png', 'i.png', false)
    expect(c.inputRef.value?.insertSkillChip).toHaveBeenCalledWith('s', '/skills/s/SKILL.md')
    expect(c.inputRef.value?.insertFileChip).toHaveBeenCalledWith('/f.ts', [1, 2])
  })

  // ── U2b：session / subagent chip 恢复（发送失败回滚两类新 chip）──

  it('session 段 → insertSessionChip(sessionId, label) 回填（两类段序列化为 #uuid / 空串，不进 textOnly）', () => {
    const c = setup('s1')
    const segments: Segment[] = [
      { type: 'text', text: '参考 ' },
      { type: 'session', sessionId: '019e-abc', label: '设计讨论' },
    ]
    c.restoreSegments(segments)
    expect(c.inputRef.value?.setText).toHaveBeenCalledWith('参考 ')
    expect(c.inputRef.value?.insertSessionChip).toHaveBeenCalledWith('019e-abc', '设计讨论')
  })

  it('subagent 段（含新建占位形态）→ insertSubagentChip(subagentId, slug) 原样回填', () => {
    const c = setup('s1')
    const segments: Segment[] = [
      { type: 'subagent', subagentId: '', slug: '新任务' },
      { type: 'text', text: '帮我修 bug' },
    ]
    c.restoreSegments(segments)
    expect(c.inputRef.value?.setText).toHaveBeenCalledWith('帮我修 bug')
    expect(c.inputRef.value?.insertSubagentChip).toHaveBeenCalledWith('', '新任务')
  })
})
