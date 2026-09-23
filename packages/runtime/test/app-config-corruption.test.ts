/**
 * config.json 损坏防覆写单测（code-harden M4 / RT-7#1）。
 *
 * 修复语义链（app-config-store.ts）：损坏读（JSON 畸形 / 顶层非对象）→
 * quarantineCorruptFile 隔离保现场 + 置降级标志 → 任一 setter 的 save 拒绝以
 * 空骨架覆写（{ok:false, code:'app_config_corrupted'}，message 指明隔离副本路径）→
 * 原位文件恢复健康后降级态自愈。
 *
 * 覆盖三层：
 * - 纯函数层：loadAppConfig / saveAppConfig
 * - service 层：ConfigService setter（updateToolPermissions / setWorktreeRootDir）
 * - transport 层：RPC 回包为 error 信封带 code（透传验收）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ClientMessage } from '@taiji/shared'
import { loadAppConfig, saveAppConfig } from '../src/services/app-config-store.js'
import { ConfigService } from '../src/services/config-service.js'
import { PiConfigStore } from '../src/infra/pi/pi-config-store.js'
import { setModelsPath, refreshModels } from '../src/infra/pi/pi-provider-store.js'
import { setSettingsPath } from '../src/infra/pi/pi-settings-store.js'
import { ConfigPreferencesMessageHandler } from '../src/transport/config-preferences-message-handler.js'
import { ToolPermissionsMessageHandler } from '../src/transport/tool-permissions-message-handler.js'
import type { SettingsHandlerContext } from '../src/transport/settings-message-handler.js'

let tmpDir: string
let savedEnv: string | undefined

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'app-config-corruption-'))
  savedEnv = process.env.TAIJI_AGENT_DATA_DIR
  process.env.TAIJI_AGENT_DATA_DIR = tmpDir
  // pi 各模块单例路径隔离（ConfigService 构造需要 IConfigStore；app-config 路径 =
  // getConfigDir() = dataDir 根，本测试只读写 <tmpDir>/config.json）
  setModelsPath(join(tmpDir, 'agent', 'models.json'))
  setSettingsPath(join(tmpDir, 'agent', 'settings.json'))
  refreshModels()
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
  else process.env.TAIJI_AGENT_DATA_DIR = savedEnv
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** 找到 config.json 的 .corrupt-<ts> 隔离副本路径（无则 undefined）。 */
function findCorruptCopy(): string | undefined {
  return readdirSync(tmpDir).find(name => name.startsWith('config.json.corrupt-'))
}

function makeConfigService(): ConfigService {
  return new ConfigService(tmpDir, new PiConfigStore())
}

/** 最小 handler ctx（真实 ConfigService + mock reply/sendError，验证错误信封透传）。 */
function makeHandlerCtx(configService: ConfigService): {
  ctx: SettingsHandlerContext
  replies: unknown[]
  sendErrorCalls: Array<{ code: string; message: string; id?: string }>
} {
  const replies: unknown[] = []
  const sendErrorCalls: Array<{ code: string; message: string; id?: string }> = []
  const ctx = {
    reply: vi.fn((_ws: unknown, _id: string | undefined, _type: string, payload: unknown) => {
      replies.push(payload)
    }),
    sendError: vi.fn((_ws: unknown, code: string, message: string, id?: string) => {
      sendErrorCalls.push({ code, message, id })
    }),
    configService,
  }
  return { ctx: ctx as unknown as SettingsHandlerContext, replies, sendErrorCalls }
}

function msg(type: string, payload: Record<string, unknown>, id = 'm1'): ClientMessage {
  return { type, id, payload } as unknown as ClientMessage
}

const WS = {} as never

describe('RT-7#1 app-config-store 纯函数层：损坏读隔离 + 拒绝空骨架覆写', () => {
  it('JSON 畸形：读回 {} + 隔离副本保现场；save 拒绝覆写并返回错误', () => {
    const broken = '{ "worktreeRootDir": "oop'
    writeFileSync(join(tmpDir, 'config.json'), broken, 'utf-8')

    expect(loadAppConfig(tmpDir)).toEqual({})

    // ① 原损坏内容未被空骨架覆盖：被隔离为 .corrupt-* 副本、原信息可找回
    const copyName = findCorruptCopy()
    expect(copyName).toBeDefined()
    expect(readFileSync(join(tmpDir, copyName!), 'utf-8')).toBe(broken)
    expect(existsSync(join(tmpDir, 'config.json'))).toBe(false)

    // ② save 返回错误而非成功；错误消息含恢复指引与副本路径
    const result = saveAppConfig(tmpDir, { worktreeRootDir: '/new' })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('app_config_corrupted')
    expect(result.error).toContain(copyName!)
    // 拒绝写盘：原位文件不因被拒绝的 save 重建
    expect(existsSync(join(tmpDir, 'config.json'))).toBe(false)
  })

  it('顶层非对象（数组）：同样隔离 + 拒绝覆写', () => {
    const broken = '[1, 2, 3]'
    writeFileSync(join(tmpDir, 'config.json'), broken, 'utf-8')

    expect(loadAppConfig(tmpDir)).toEqual({})
    expect(readFileSync(join(tmpDir, findCorruptCopy()!), 'utf-8')).toBe(broken)

    const result = saveAppConfig(tmpDir, { k: 'v' })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('app_config_corrupted')
  })

  it('健康文件：load 正常返回 + save ok；降级态在文件恢复健康后自愈', () => {
    // 先制造降级态
    writeFileSync(join(tmpDir, 'config.json'), 'not-json', 'utf-8')
    loadAppConfig(tmpDir)
    expect(saveAppConfig(tmpDir, { k: 'v' }).ok).toBe(false)

    // 用户从 .corrupt 副本找回原配置写回原位 → 下一次 load 清降级态 → save 恢复可用
    writeFileSync(join(tmpDir, 'config.json'), JSON.stringify({ recovered: true }), 'utf-8')
    expect(loadAppConfig(tmpDir)).toEqual({ recovered: true })
    const result = saveAppConfig(tmpDir, { recovered: true, extra: 1 })
    expect(result.ok).toBe(true)
    expect(JSON.parse(readFileSync(join(tmpDir, 'config.json'), 'utf-8'))).toEqual({ recovered: true, extra: 1 })
  })

  it('文件不存在：load 返回 {} 且 save 正常写入（全新环境不受降级语义影响）', () => {
    expect(loadAppConfig(tmpDir)).toEqual({})
    const result = saveAppConfig(tmpDir, { fresh: true })
    expect(result.ok).toBe(true)
    expect(JSON.parse(readFileSync(join(tmpDir, 'config.json'), 'utf-8'))).toEqual({ fresh: true })
  })
})

describe('RT-7#1 ConfigService setter：损坏态拒绝空骨架覆写', () => {
  it('updateToolPermissions / setWorktreeRootDir 在降级态返回 {ok:false} 且不写盘', () => {
    const broken = '{ "toolPermissions": "x'
    writeFileSync(join(tmpDir, 'config.json'), broken, 'utf-8')
    const service = makeConfigService()

    // 触发读取（setter 内部 load → 隔离 + 置降级态）
    const r1 = service.updateToolPermissions({ 'bash(npm:*)': 'allow' })
    expect(r1.ok).toBe(false)
    expect(r1.code).toBe('app_config_corrupted')

    // 降级态粘滞：第二个 setter 同样拒绝（隔离后原位文件已移走，load 不再重检）
    const r2 = service.setWorktreeRootDir('/tmp/wt')
    expect(r2.ok).toBe(false)
    expect(r2.code).toBe('app_config_corrupted')

    // ① 原损坏内容可找回：.corrupt 副本保留原始字节，原位未被空骨架重建
    expect(readFileSync(join(tmpDir, findCorruptCopy()!), 'utf-8')).toBe(broken)
    expect(existsSync(join(tmpDir, 'config.json'))).toBe(false)
  })
})

describe('RT-7#1 RPC 错误透传：损坏态回包为 error 信封带 code', () => {
  it('config.setWorktreeRootDir → sendError(code=app_config_corrupted)，不 reply 成功', async () => {
    writeFileSync(join(tmpDir, 'config.json'), '[[[', 'utf-8')
    const { ctx, replies, sendErrorCalls } = makeHandlerCtx(makeConfigService())
    const handler = new ConfigPreferencesMessageHandler(ctx)

    const handled = await handler.handle(
      msg('config.setWorktreeRootDir', { dir: '/tmp/wt' }),
      WS,
    )

    expect(handled).toBe(true)
    expect(sendErrorCalls).toHaveLength(1)
    expect(sendErrorCalls[0]!.code).toBe('app_config_corrupted')
    expect(sendErrorCalls[0]!.message).toContain('config.json.corrupt-')
    expect(replies).toHaveLength(0)
  })

  it('config.setToolPermissions → sendError(code=app_config_corrupted)，不 reply saved:true', async () => {
    writeFileSync(join(tmpDir, 'config.json'), '"scalar-top-level"', 'utf-8')
    const { ctx, replies, sendErrorCalls } = makeHandlerCtx(makeConfigService())
    const handler = new ToolPermissionsMessageHandler(ctx)

    const handled = await handler.handle(
      msg('config.setToolPermissions', { permissions: { 'bash(git:*)': 'allow' } }),
      WS,
    )

    expect(handled).toBe(true)
    expect(sendErrorCalls).toHaveLength(1)
    expect(sendErrorCalls[0]!.code).toBe('app_config_corrupted')
    expect(replies).toHaveLength(0)
  })
})
