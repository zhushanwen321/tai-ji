import { describe, it, expect } from 'vitest'
import { type SessionSummary } from '../session'

describe('SessionSummary', () => {
  it('TC-W2-1a: 省略 launchPresetId 时通过类型检查（可选字段）', () => {
    // 最小合法对象，不含 launchPresetId（向后兼容历史 session）
    const summary: SessionSummary = {
      id: 'sess-1',
      label: 'test session',
      cwd: '/tmp/test',
      status: 'idle',
      lastActiveAt: Date.now(),
      modelId: 'model-x',
      tokenCount: 0,
    }
    expect(summary.launchPresetId).toBeUndefined()
    expect(summary.id).toBe('sess-1')
  })

  it('TC-W2-1b: 赋值 launchPresetId:string 时通过类型检查', () => {
    // 新 session 锁定 builtin:full 预设
    const summary: SessionSummary = {
      id: 'sess-2',
      label: 'preset session',
      cwd: '/tmp/test',
      status: 'active',
      lastActiveAt: Date.now(),
      modelId: 'model-x',
      tokenCount: 100,
      launchPresetId: 'builtin:full',
    }
    expect(summary.launchPresetId).toBe('builtin:full')
  })
})

// 编译时类型检查（TC-W2-1）：launchPresetId 可选，省略合法、赋值 string 合法
const _withoutPreset: SessionSummary = {
  id: 's',
  label: 'l',
  cwd: '/',
  status: 'idle',
  lastActiveAt: 0,
  modelId: 'm',
  tokenCount: 0,
}
const _withPreset: SessionSummary = {
  ..._withoutPreset,
  launchPresetId: 'builtin:readonly',
}
void _withoutPreset
void _withPreset
