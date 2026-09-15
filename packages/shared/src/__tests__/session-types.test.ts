/**
 * SessionSummary 类型扩展测试（U4-A7）。
 *
 * 验证 SessionSummary 新增 spawnSource/parentAgentSessionId 字段：
 * - 字段可选（undefined 合法）
 * - 类型正确（'user' | 'agent' | string）
 * - 现有字段不受影响
 *
 * 运行：pnpm --filter @taiji/shared exec vitest run session-types
 */
import { describe, it, expect } from 'vitest'
import type { SessionSummary, SessionStatus } from '../session.js'

describe('SessionSummary 类型扩展（U4-A7）', () => {
  it('spawnSource 可选，值为 "user" | "agent"', () => {
    const summary: SessionSummary = {
      id: 'test',
      label: 'test',
      cwd: '/test',
      status: 'active',
      lastActiveAt: Date.now(),
      modelId: 'openai/gpt-4',
      tokenCount: 0,
      spawnSource: 'agent',
    }
    expect(summary.spawnSource).toBe('agent')
  })

  it('parentAgentSessionId 可选，值为 string', () => {
    const summary: SessionSummary = {
      id: 'test',
      label: 'test',
      cwd: '/test',
      status: 'active',
      lastActiveAt: Date.now(),
      modelId: 'openai/gpt-4',
      tokenCount: 0,
      parentAgentSessionId: 'parent-session-123',
    }
    expect(summary.parentAgentSessionId).toBe('parent-session-123')
  })

  it('spawnSource 和 parentAgentSessionId 可同时存在', () => {
    const summary: SessionSummary = {
      id: 'agent-created',
      label: 'agent session',
      cwd: '/workspace',
      status: 'idle',
      lastActiveAt: Date.now(),
      modelId: 'anthropic/claude-3',
      tokenCount: 100,
      spawnSource: 'agent',
      parentAgentSessionId: 'parent-agent-session',
    }
    expect(summary.spawnSource).toBe('agent')
    expect(summary.parentAgentSessionId).toBe('parent-agent-session')
  })

  it('spawnSource 和 parentAgentSessionId 可同时省略（向后兼容）', () => {
    const summary: SessionSummary = {
      id: 'user-created',
      label: 'user session',
      cwd: '/workspace',
      status: 'active',
      lastActiveAt: Date.now(),
      modelId: 'openai/gpt-4',
      tokenCount: 50,
    }
    expect(summary.spawnSource).toBeUndefined()
    expect(summary.parentAgentSessionId).toBeUndefined()
  })

  it('现有字段不受影响', () => {
    const summary: SessionSummary = {
      id: 'test',
      label: 'test',
      cwd: '/test',
      status: 'active',
      lastActiveAt: Date.now(),
      modelId: 'openai/gpt-4',
      tokenCount: 100,
      // 所有现有可选字段
      gitBranch: 'main',
      gitIsWorktree: false,
      isBareWorkspace: false,
      thinkingLevel: 'high',
      sessionFile: '/path/to/session.jsonl',
      projectId: 'proj-1',
      hidden: false,
      source: 'scan',
      parentSession: '/path/to/parent.jsonl',
      forkEntryId: 'entry-1',
      handedOffTo: 'new-session',
      lastMergedAt: Date.now(),
      launchPresetId: 'preset-1',
      // 新字段
      spawnSource: 'agent',
      parentAgentSessionId: 'parent-id',
    }

    // 验证所有字段都正确赋值
    expect(summary.id).toBe('test')
    expect(summary.label).toBe('test')
    expect(summary.cwd).toBe('/test')
    expect(summary.status).toBe('active')
    expect(summary.modelId).toBe('openai/gpt-4')
    expect(summary.tokenCount).toBe(100)
    expect(summary.gitBranch).toBe('main')
    expect(summary.gitIsWorktree).toBe(false)
    expect(summary.isBareWorkspace).toBe(false)
    expect(summary.thinkingLevel).toBe('high')
    expect(summary.sessionFile).toBe('/path/to/session.jsonl')
    expect(summary.projectId).toBe('proj-1')
    expect(summary.hidden).toBe(false)
    expect(summary.source).toBe('scan')
    expect(summary.parentSession).toBe('/path/to/parent.jsonl')
    expect(summary.forkEntryId).toBe('entry-1')
    expect(summary.handedOffTo).toBe('new-session')
    expect(summary.lastMergedAt).toBeDefined()
    expect(summary.launchPresetId).toBe('preset-1')
    expect(summary.spawnSource).toBe('agent')
    expect(summary.parentAgentSessionId).toBe('parent-id')
  })

  it('SessionStatus 类型包含所有预期值', () => {
    const validStatuses: SessionStatus[] = ['active', 'idle', 'dead', 'done', 'error', 'stopped']
    for (const status of validStatuses) {
      const summary: SessionSummary = {
        id: 'test',
        label: 'test',
        cwd: '/test',
        status,
        lastActiveAt: Date.now(),
        modelId: 'openai/gpt-4',
        tokenCount: 0,
      }
      expect(summary.status).toBe(status)
    }
  })
})
