/**
 * pi-presets.json 损坏防覆写单测（code-harden M4 / RT-7#2）。
 *
 * 修复语义链（preset-service.ts）：读盘解析失败（JSON 畸形 / 顶层非对象）→
 * quarantineCorruptFile 隔离保现场 + 置 corruptedState → 任一写方法
 * （savePreset / deletePreset / setDefaultPresetId / recordUsage / importPresets）
 * 抛 PresetStoreCorruptedError（code='preset_store_corrupted'，message 指明副本路径）→
 * 原位文件恢复健康后降级态自愈。
 *
 * 读侧保持既有可用性：降级态下 getAllPresets 仍返回 DEFAULT 兜底（应用只读可用）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ClientMessage, PiLaunchPreset } from '@taiji/shared'
import { DEFAULT_PRESETS } from '@taiji/shared'
import {
  PresetService,
  PresetStoreCorruptedError,
  PresetGuardError,
} from '../src/services/preset-service.js'
import { PresetMessageHandler } from '../src/transport/preset-message-handler.js'
import type { PresetHandlerContext } from '../src/transport/preset-message-handler.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'preset-corruption-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

function makeService(): PresetService {
  // 最小 fake：app-config 路径经 getConfigDir 注入（PresetService 只用这一个 port 方法）
  return new PresetService(
    { getConfigDir: () => tmpDir } as unknown as ConstructorParameters<typeof PresetService>[0],
    {} as unknown as ConstructorParameters<typeof PresetService>[1],
  )
}

/** 找到 pi-presets.json 的 .corrupt-<ts> 隔离副本路径（无则 undefined）。 */
function findCorruptCopy(): string | undefined {
  return readdirSync(tmpDir).find(name => name.startsWith('pi-presets.json.corrupt-'))
}

/** 合法自定义 preset fixture（id 不与 DEFAULT 冲突 → 走 custom 写路径）。 */
function makeCustomPreset(): PiLaunchPreset {
  return {
    id: 'corruption-test-custom',
    name: 'Corruption Test',
    builtin: false,
    order: 99,
    toolMode: 'all',
    extensionMode: 'all',
  }
}

describe('RT-7#2 PresetService：损坏读隔离 + 拒绝空骨架覆写', () => {
  it('JSON 畸形：读取回 DEFAULT 兜底 + 隔离副本保现场；savePreset 抛带 code 错误', () => {
    const broken = '{ "presets": [ {"id": "custom-a", '
    writeFileSync(join(tmpDir, 'pi-presets.json'), broken, 'utf-8')
    const service = makeService()

    // 触发读取：降级态下读侧仍可用（DEFAULT_PRESETS 兜底，只读降级不炸应用）
    expect(service.getAllPresets()).toEqual(DEFAULT_PRESETS)

    // ① 原损坏内容未被空骨架覆盖：被隔离为 .corrupt-* 副本、原信息可找回
    const copyName = findCorruptCopy()
    expect(copyName).toBeDefined()
    expect(readFileSync(join(tmpDir, copyName!), 'utf-8')).toBe(broken)
    expect(existsSync(join(tmpDir, 'pi-presets.json'))).toBe(false)

    // ② savePreset 抛错而非成功：code 供 error envelope、message 指明副本路径
    expect(() => service.savePreset(makeCustomPreset())).toThrowError(PresetStoreCorruptedError)
    let caught: unknown
    try {
      service.savePreset(makeCustomPreset())
    } catch (e) {
      caught = e
    }
    expect((caught as PresetStoreCorruptedError).code).toBe('preset_store_corrupted')
    expect((caught as PresetStoreCorruptedError).message).toContain(copyName!)
    // 拒绝写盘：原位文件未被空骨架重建
    expect(existsSync(join(tmpDir, 'pi-presets.json'))).toBe(false)
  })

  it('顶层非对象（字符串）：同样隔离 + 各写方法全部拒绝', () => {
    writeFileSync(join(tmpDir, 'pi-presets.json'), '"scalar-top-level"', 'utf-8')
    const service = makeService()
    service.getAllPresets() // 触发读取 → 隔离 + 置降级态

    expect(() => service.deletePreset('custom-a')).toThrowError(PresetStoreCorruptedError)
    expect(() => service.setDefaultPresetId('builtin:full')).toThrowError(PresetStoreCorruptedError)
    expect(() => service.recordUsage('builtin:full')).toThrowError(PresetStoreCorruptedError)
    expect(() => service.importPresets(JSON.stringify({ presets: [makeCustomPreset()] })))
      .toThrowError(PresetStoreCorruptedError)
    expect(existsSync(join(tmpDir, 'pi-presets.json'))).toBe(false)
  })

  it('降级态在文件恢复健康后自愈：写方法恢复可用', () => {
    writeFileSync(join(tmpDir, 'pi-presets.json'), 'not-json', 'utf-8')
    const service = makeService()
    service.getAllPresets()
    expect(() => service.savePreset(makeCustomPreset())).toThrowError(PresetStoreCorruptedError)

    // 用户从 .corrupt 副本找回原预设写回原位 → 下一次读取清降级态 → 写恢复
    writeFileSync(
      join(tmpDir, 'pi-presets.json'),
      JSON.stringify({ presets: [makeCustomPreset()], version: 1 }),
      'utf-8',
    )
    expect(service.getAllPresets().map(p => p.id)).toContain('corruption-test-custom')
    expect(() => service.savePreset(makeCustomPreset())).not.toThrow()
    const onDisk = JSON.parse(readFileSync(join(tmpDir, 'pi-presets.json'), 'utf-8'))
    expect(onDisk.presets).toHaveLength(1)
  })

  it('无文件全新环境不受降级语义影响：savePreset 正常写入', () => {
    const service = makeService()
    service.savePreset(makeCustomPreset())
    const onDisk = JSON.parse(readFileSync(join(tmpDir, 'pi-presets.json'), 'utf-8'))
    expect(onDisk.presets[0].id).toBe('corruption-test-custom')
  })

  it('builtin 保护仍先于降级态守卫（既有语义不因本修复漂移）', () => {
    writeFileSync(join(tmpDir, 'pi-presets.json'), 'not-json', 'utf-8')
    const service = makeService()
    service.getAllPresets()
    expect(() => service.deletePreset(DEFAULT_PRESETS[0]!.id)).toThrowError(PresetGuardError)
  })
})

describe('RT-7#2 RPC 错误透传：损坏态 preset.create 回包为 error 信封带 code', () => {
  it('preset.create → sendError(code=preset_store_corrupted)，不 reply 成功', async () => {
    writeFileSync(join(tmpDir, 'pi-presets.json'), '{ broken', 'utf-8')
    const service = makeService()

    const replies: unknown[] = []
    const sendErrorCalls: Array<{ code: string; message: string; id?: string }> = []
    const ctx = {
      reply: vi.fn((_ws: unknown, _id: string | undefined, _type: string, payload: unknown) => {
        replies.push(payload)
      }),
      sendError: vi.fn((_ws: unknown, code: string, message: string, id?: string) => {
        sendErrorCalls.push({ code, message, id })
      }),
      presetService: service,
    }
    const handler = new PresetMessageHandler(ctx as unknown as PresetHandlerContext)
    const request = {
      type: 'preset.create',
      id: 'm1',
      payload: { preset: makeCustomPreset() },
    } as unknown as ClientMessage

    const handled = await handler.handlePresetMessage(request, {} as never)

    expect(handled).toBe(true)
    expect(sendErrorCalls).toHaveLength(1)
    expect(sendErrorCalls[0]!.code).toBe('preset_store_corrupted')
    expect(sendErrorCalls[0]!.message).toContain('pi-presets.json.corrupt-')
    expect(replies).toHaveLength(0)
  })
})
