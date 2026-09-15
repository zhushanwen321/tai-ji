/**
 * PresetMessageHandler 单测 —— preset.* 消息路由 + PresetService 调用验证。
 *
 * 覆盖：
 * - preset.list → reply { presets }（getAllPresets 返回值）
 * - preset.getDefault → reply { presetId }（getDefaultPresetId 返回值）
 * - preset.setDefault → reply ack（setDefaultPresetId 被调用）
 * - preset.create → reply { preset }（savePreset + getPreset）
 * - preset.update → reply { preset }（savePreset + getPreset）
 * - preset.delete → reply ack（deletePreset 被调用）
 * - PresetGuardError → error envelope（code='preset_guard_error'）
 *
 * mock 策略：mock PresetService 方法，捕获 reply/sendError 调用。
 * 运行：cd packages/runtime && npx vitest run test/preset-message-handler.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { WebSocket } from 'ws'
import type { ClientMessage, PiLaunchPreset } from '@taiji/shared'
import { PresetMessageHandler } from '../src/transport/preset-message-handler.js'
import { PresetGuardError } from '../src/services/preset-service.js'

// ── Fixtures ──────────────────────────────────────────────────────

const fullPreset: PiLaunchPreset = {
  id: 'builtin:full',
  name: '全工具模式',
  builtin: true,
  order: 0,
  toolMode: 'all',
  extensionMode: 'all',
}

const customPreset: PiLaunchPreset = {
  id: 'custom:test-uuid',
  name: '自定义预设',
  builtin: false,
  order: 3,
  toolMode: 'allowlist',
  allowedTools: ['read', 'grep'],
  extensionMode: 'all',
}

// ── Mocks ─────────────────────────────────────────────────────────

function createMockWs(): WebSocket {
  return {} as WebSocket
}

function createMockPresetService() {
  const mock = {
    getAllPresets: vi.fn().mockReturnValue([fullPreset, customPreset]),
    getPreset: vi.fn().mockImplementation((id: string) => {
      if (id === 'builtin:full') return fullPreset
      if (id === 'custom:test-uuid') return customPreset
      return undefined
    }),
    getDefaultPresetId: vi.fn().mockReturnValue('builtin:full'),
    setDefaultPresetId: vi.fn(),
    savePreset: vi.fn(),
    deletePreset: vi.fn(),
    recordUsage: vi.fn(),
    getUsage: vi.fn().mockReturnValue({}),
    exportPresets: vi.fn().mockReturnValue('{}'),
    importPresets: vi.fn().mockReturnValue(0),
  }
  return { mock, service: mock as unknown as import('../src/services/preset-service.js').PresetService }
}

function createMockContext() {
  const { mock, service: presetService } = createMockPresetService()
  return {
    mock,
    presetService,
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn(),
  }
}

// ── Tests ─────────────────────────────────────────────────────────

describe('PresetMessageHandler', () => {
  let ctx: ReturnType<typeof createMockContext>
  let handler: PresetMessageHandler
  let ws: WebSocket

  beforeEach(() => {
    ctx = createMockContext()
    handler = new PresetMessageHandler(ctx)
    ws = createMockWs()
  })

  it('handles 消息类型清单包含 10 个 preset.* 类型', () => {
    expect(handler.handles).toEqual([
      'preset.list',
      'preset.getDefault',
      'preset.setDefault',
      'preset.create',
      'preset.update',
      'preset.delete',
      'preset.recordUsage',
      'preset.getUsage',
      'preset.export',
      'preset.import',
    ])
  })

  describe('preset.list', () => {
    it('调用 getAllPresets 并 reply { presets }', async () => {
      const msg = { type: 'preset.list' as const, id: 'req-1', payload: {} }
      const result = await handler.handlePresetMessage(msg, ws)
      expect(result).toBe(true)
      expect(ctx.mock.getAllPresets).toHaveBeenCalledTimes(1)
      expect(ctx.reply).toHaveBeenCalledWith(ws, 'req-1', 'preset.list', { presets: [fullPreset, customPreset] })
    })
  })

  describe('preset.getDefault', () => {
    it('调用 getDefaultPresetId 并 reply { presetId }', async () => {
      const msg = { type: 'preset.getDefault' as const, id: 'req-2', payload: {} }
      const result = await handler.handlePresetMessage(msg, ws)
      expect(result).toBe(true)
      expect(ctx.mock.getDefaultPresetId).toHaveBeenCalledTimes(1)
      expect(ctx.reply).toHaveBeenCalledWith(ws, 'req-2', 'preset.getDefault', { presetId: 'builtin:full' })
    })
  })

  describe('preset.setDefault', () => {
    it('调用 setDefaultPresetId 并 reply ack（S-TR-1：ack 型 reply 占位对象）', async () => {
      const msg = { type: 'preset.setDefault' as const, id: 'req-3', payload: { presetId: 'custom:test-uuid' } }
      const result = await handler.handlePresetMessage(msg, ws)
      expect(result).toBe(true)
      expect(ctx.mock.setDefaultPresetId).toHaveBeenCalledWith('custom:test-uuid')
      // S-TR-1：reply() 用 ServerMessageMap[T] 占位对象（domain register<void> 忽略 payload）
      expect(ctx.reply).toHaveBeenCalledWith(ws, 'req-3', 'preset.setDefault', expect.any(Object))
    })
  })

  describe('preset.create', () => {
    it('调用 savePreset 并 reply { preset }（W-TR-1：直接用传入 preset，不再二次 getPreset）', async () => {
      const msg = { type: 'preset.create' as const, id: 'req-4', payload: { preset: customPreset } }
      const result = await handler.handlePresetMessage(msg, ws)
      expect(result).toBe(true)
      expect(ctx.mock.savePreset).toHaveBeenCalledWith(customPreset)
      // W-TR-1：handler 不再调 getPreset（避免二次 loadPresetsFile），直接用传入 preset reply。
      expect(ctx.mock.getPreset).not.toHaveBeenCalled()
      expect(ctx.reply).toHaveBeenCalledWith(ws, 'req-4', 'preset.create', { preset: customPreset })
    })
  })

  describe('preset.update', () => {
    it('调用 savePreset 并 reply { preset }（W-TR-1：直接用传入 preset）', async () => {
      const updated = { ...customPreset, name: '新名称' }
      const msg = { type: 'preset.update' as const, id: 'req-5', payload: { preset: updated } }
      const result = await handler.handlePresetMessage(msg, ws)
      expect(result).toBe(true)
      expect(ctx.mock.savePreset).toHaveBeenCalledWith(updated)
      // W-TR-1：用传入的 updated（含改名）reply，不是 getPreset 返回的旧值。
      expect(ctx.reply).toHaveBeenCalledWith(ws, 'req-5', 'preset.update', { preset: updated })
    })
  })

  describe('preset.delete', () => {
    it('调用 deletePreset 并 reply ack（S-TR-1：ack 型 reply 占位对象）', async () => {
      const msg = { type: 'preset.delete' as const, id: 'req-6', payload: { presetId: 'custom:test-uuid' } }
      const result = await handler.handlePresetMessage(msg, ws)
      expect(result).toBe(true)
      expect(ctx.mock.deletePreset).toHaveBeenCalledWith('custom:test-uuid')
      expect(ctx.reply).toHaveBeenCalledWith(ws, 'req-6', 'preset.delete', expect.any(Object))
    })
  })

  // ── FR-14/FR-15/FR-13 测试 ──

  describe('preset.recordUsage (FR-14)', () => {
    it('调用 recordUsage 并 reply ack（S-TR-1：ack 型 reply 占位对象）', async () => {
      const msg = { type: 'preset.recordUsage' as const, id: 'req-7', payload: { presetId: 'builtin:full' } }
      const result = await handler.handlePresetMessage(msg, ws)
      expect(result).toBe(true)
      expect(ctx.mock.recordUsage).toHaveBeenCalledWith('builtin:full')
      expect(ctx.reply).toHaveBeenCalledWith(ws, 'req-7', 'preset.recordUsage', expect.any(Object))
    })
  })

  describe('preset.getUsage (FR-14)', () => {
    it('调用 getUsage 并 reply { usage }', async () => {
      ctx.mock.getUsage.mockReturnValue({ 'builtin:full': { count: 5, lastUsed: 1000 } })
      const msg = { type: 'preset.getUsage' as const, id: 'req-8', payload: {} }
      const result = await handler.handlePresetMessage(msg, ws)
      expect(result).toBe(true)
      expect(ctx.reply).toHaveBeenCalledWith(ws, 'req-8', 'preset.getUsage', { usage: { 'builtin:full': { count: 5, lastUsed: 1000 } } })
    })
  })

  describe('preset.export (FR-13)', () => {
    it('调用 exportPresets 并 reply { json }', async () => {
      ctx.mock.exportPresets.mockReturnValue('{"presets":[],"version":1}')
      const msg = { type: 'preset.export' as const, id: 'req-11', payload: {} }
      const result = await handler.handlePresetMessage(msg, ws)
      expect(result).toBe(true)
      expect(ctx.reply).toHaveBeenCalledWith(ws, 'req-11', 'preset.export', { json: '{"presets":[],"version":1}' })
    })
  })

  describe('preset.import (FR-13)', () => {
    it('调用 importPresets 并 reply { count }', async () => {
      ctx.mock.importPresets.mockReturnValue(3)
      const msg = { type: 'preset.import' as const, id: 'req-12', payload: { json: '{"presets":[],"version":1}' } }
      const result = await handler.handlePresetMessage(msg, ws)
      expect(result).toBe(true)
      expect(ctx.mock.importPresets).toHaveBeenCalledWith('{"presets":[],"version":1}')
      expect(ctx.reply).toHaveBeenCalledWith(ws, 'req-12', 'preset.import', { count: 3 })
    })
  })

  describe('错误处理', () => {
    it('PresetGuardError → sendError envelope（code=preset_guard_error）', async () => {
      ctx.mock.savePreset.mockImplementationOnce(() => {
        throw new PresetGuardError('cannot delete builtin preset')
      })
      const msg = { type: 'preset.create' as const, id: 'err-1', payload: { preset: fullPreset } }
      const result = await handler.handlePresetMessage(msg, ws)
      expect(result).toBe(true)
      expect(ctx.sendError).toHaveBeenCalledWith(ws, 'preset_guard_error', 'cannot delete builtin preset', 'err-1')
    })

    it('普通 Error → sendError envelope（code=preset_guard_error 兜底）', async () => {
      ctx.mock.deletePreset.mockImplementationOnce(() => {
        throw new Error('disk full')
      })
      const msg = { type: 'preset.delete' as const, id: 'err-2', payload: { presetId: 'custom:x' } }
      const result = await handler.handlePresetMessage(msg, ws)
      expect(result).toBe(true)
      expect(ctx.sendError).toHaveBeenCalledWith(ws, 'preset_guard_error', 'disk full', 'err-2')
    })

    it('带 code 的 Error → 透传 code', async () => {
      const err = new Error('custom error') as Error & { code: string }
      err.code = 'CUSTOM_CODE'
      ctx.mock.deletePreset.mockImplementationOnce(() => { throw err })
      const msg = { type: 'preset.delete' as const, id: 'err-3', payload: { presetId: 'custom:x' } }
      await handler.handlePresetMessage(msg, ws)
      expect(ctx.sendError).toHaveBeenCalledWith(ws, 'CUSTOM_CODE', 'custom error', 'err-3')
    })

    // S-TR-4：importPresets 的格式错误用独立 code 'preset_import_format_error'，
    // 不混用 guard code（guard 是 builtin 保护语义，格式错误不算 guard 违规）。
    // 覆盖 preset-service.importPresets 抛的三种格式错误消息。
    it.each([
      'Invalid JSON format',
      'Import file must be a JSON object',
      'No valid presets found in import file',
    ])('importPresets 格式错误（%s）→ code=preset_import_format_error', async (errMsg) => {
      ctx.mock.importPresets.mockImplementationOnce(() => { throw new Error(errMsg) })
      const msg = { type: 'preset.import' as const, id: 'err-imp', payload: { json: 'bad' } }
      const result = await handler.handlePresetMessage(msg, ws)
      expect(result).toBe(true)
      expect(ctx.sendError).toHaveBeenCalledWith(ws, 'preset_import_format_error', errMsg, 'err-imp')
    })
  })

  // S-TR-2：参数化覆盖每个 handle 类型——发一条 msg 断言 result===true 且 reply 被调，
  // 避免 handles 清单与实际路由脱节（新增 handle 类型但 switch 漏 case 时此处会失败）。
  describe('S-TR-2：每个 handle 类型都能被认领并 reply', () => {
    const cases: Array<{ type: string; payload: Record<string, unknown>; setup?: () => void }> = [
      { type: 'preset.list', payload: {} },
      { type: 'preset.getDefault', payload: {} },
      { type: 'preset.setDefault', payload: { presetId: 'builtin:full' } },
      { type: 'preset.create', payload: { preset: customPreset } },
      { type: 'preset.update', payload: { preset: customPreset } },
      { type: 'preset.delete', payload: { presetId: 'custom:test-uuid' } },
      { type: 'preset.recordUsage', payload: { presetId: 'builtin:full' } },
      { type: 'preset.getUsage', payload: {} },
      { type: 'preset.export', payload: {} },
      { type: 'preset.import', payload: { json: '{}' } },
    ]
    it.each(cases)('$type → result===true 且 reply 被调', async ({ type, payload }) => {
      const msg = { type, id: `s-tr-2-${type}`, payload } as unknown as ClientMessage
      const result = await handler.handlePresetMessage(msg, ws)
      expect(result).toBe(true)
      expect(ctx.reply).toHaveBeenCalled()
    })
  })
})
