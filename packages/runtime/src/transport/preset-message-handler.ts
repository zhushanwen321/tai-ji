/**
 * PresetMessageHandler — pi 启动预设域的 WS 消息处理。
 *
 * 设计文档：docs/architecture/pi-launch-presets.md（§8.1 API）
 *
 * 处理 preset.* 消息类型（6 CRUD + 4 Phase 2 增强）：
 * - preset.list / getDefault / setDefault / create / update / delete（CRUD）
 * - preset.recordUsage / getUsage（FR-14 使用统计）
 * - preset.export / import（FR-13 导入/导出）
 * [HISTORICAL] preset.getCwdDefault / setCwdDefault / getCwdDefaults（FR-15 per-cwd 默认）
 * 已随 state-truth-sync U9 全链删除（renderer/core 零消费的纯死链）。
 *
 * 与 SettingsMessageHandler 对称（独立 handler，非 SettingsMessageHandler 内部 case）。
 * 职责单一：只做消息→PresetService 调用→reply，不含领域计算。
 *
 * 错误处理：PresetService.savePreset/deletePreset 抛 PresetGuardError 时，
 * handler 捕获后发 error envelope（code='preset_guard_error'），前端 toast 展示。
 * S-TR-4：importPresets 的格式错误（JSON 畸形 / 顶层非对象 / 无合法 preset）用独立 code
 * 'preset_import_format_error'（guard 是 builtin 保护语义，格式错误不算 guard 违规）。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage } from '@xyz-agent/shared'
import type { PresetService } from '../services/preset-service.js'
import type { MessageHandlerContext } from './message-context.js'

/** PresetMessageHandler 的上下文接口（与 SettingsHandlerContext 对称）。 */
export interface PresetHandlerContext extends MessageHandlerContext {
  presetService: PresetService
}

/** preset.* 消息类型清单（供 server.ts routes Map spread）。 */
const PRESET_HANDLES = [
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
] as const

/**
 * importPresets 格式错误的特征消息（S-TR-4）。
 *
 * preset-service.importPresets 在三种场景抛普通 Error（非 PresetGuardError）：
 *   - JSON 畸形：'Invalid JSON format'
 *   - 顶层非对象：'Import file must be a JSON object'
 *   - 无合法 preset：'No valid presets found in import file'
 * 这些是用户提供的导入文件问题，不属于 builtin 保护（guard）范畴，handler 据消息文本识别后
 * 用独立的 'preset_import_format_error' code（前端可据 code 给出「文件格式错误」针对性提示，
 * 而非笼统的 guard 违规 toast）。匹配失败（未知 Error）仍回退 'preset_guard_error' 兜底。
 */
const PRESET_IMPORT_FORMAT_ERROR_MESSAGES = new Set([
  'Invalid JSON format',
  'Import file must be a JSON object',
  'No valid presets found in import file',
])

/**
 * 分发表项统一签名（复杂度债清偿 U07）。具体 payload 形状在各表项内以 Extract 收窄
 * 后传给命名 case 方法——对齐 server.ts D1 路由表的既有范式。
 */
type PresetCaseHandler = (msg: ClientMessage, ws: WsType) => boolean

/** 按消息类型收窄 ClientMessage 的别名（缩短表项与 case 方法的类型标注）。 */
type PresetMsg<T extends (typeof PRESET_HANDLES)[number]> = Extract<ClientMessage, { type: T }>

export class PresetMessageHandler {
  constructor(private ctx: PresetHandlerContext) {}

  /** 本 handler 认领的消息类型清单（server.ts D1 路由表用）。 */
  get handles() {
    return PRESET_HANDLES
  }

  /**
   * 分发表（复杂度债清偿 U07）：原 13 个 case 直排 switch（cyclo 19）改为查表 + 落空语义。
   * 表项 = 各 case 体逐字搬移到命名私有方法（同步 case 保持同步，微任务时序不变）；
   * 落空返回 false 与原 default 一致；异常统一走 sendPresetError（原 catch 块）。
   * S-TR-2 参数化用例继续守卫 handles 清单与表的同步（漏登记的 type 会返回 false 落红）。
   */
  private readonly caseHandlers = new Map<string, PresetCaseHandler>([
    ['preset.list', (msg, ws) => this.replyList(msg as PresetMsg<'preset.list'>, ws)],
    ['preset.getDefault', (msg, ws) => this.replyGetDefault(msg as PresetMsg<'preset.getDefault'>, ws)],
    ['preset.setDefault', (msg, ws) => this.replySetDefault(msg as PresetMsg<'preset.setDefault'>, ws)],
    ['preset.create', (msg, ws) => this.replyCreate(msg as PresetMsg<'preset.create'>, ws)],
    ['preset.update', (msg, ws) => this.replyUpdate(msg as PresetMsg<'preset.update'>, ws)],
    ['preset.delete', (msg, ws) => this.replyDelete(msg as PresetMsg<'preset.delete'>, ws)],
    ['preset.recordUsage', (msg, ws) => this.replyRecordUsage(msg as PresetMsg<'preset.recordUsage'>, ws)],
    ['preset.getUsage', (msg, ws) => this.replyGetUsage(msg as PresetMsg<'preset.getUsage'>, ws)],
    ['preset.export', (msg, ws) => this.replyExport(msg as PresetMsg<'preset.export'>, ws)],
    ['preset.import', (msg, ws) => this.replyImport(msg as PresetMsg<'preset.import'>, ws)],
  ])

  /**
   * 处理 preset.* 消息。
   *
   * 返回 true 表示已认领（即使出错也已 reply），false 不应出现（handles 保证匹配）。
   * 错误统一走 sendError（D10 error envelope），前端 catch 后 toast。
   */
  async handlePresetMessage(msg: ClientMessage, ws: WsType): Promise<boolean> {
    try {
      const handler = this.caseHandlers.get(msg.type)
      if (!handler) return false
      return handler(msg, ws)
    } catch (e) {
      return this.sendPresetError(ws, msg, e)
    }
  }

  private replyList(msg: PresetMsg<'preset.list'>, ws: WsType): boolean {
    const presets = this.ctx.presetService.getAllPresets()
    this.ctx.reply(ws, msg.id, 'preset.list', { presets })
    return true
  }

  private replyGetDefault(msg: PresetMsg<'preset.getDefault'>, ws: WsType): boolean {
    const presetId = this.ctx.presetService.getDefaultPresetId()
    this.ctx.reply(ws, msg.id, 'preset.getDefault', { presetId })
    return true
  }

  private replySetDefault(msg: PresetMsg<'preset.setDefault'>, ws: WsType): boolean {
    const { presetId } = msg.payload
    this.ctx.presetService.setDefaultPresetId(presetId)
    // S-TR-1：preset.setDefault 在 ReplyPayloadMap 登记为 void（ack 型，domain register<void> 不读 reply），
    // 但 reply() 的 payload 形参类型用的是 ServerMessageMap[T]（server-push 映射，此处为
    // { presetId: string }），不是 ReplyPayloadMap。故仍须传一个对象占位（{} as Record<string, never>
    // 可赋值给任意 Record），domain 侧 register<void> 不解构 payload，传什么都被忽略。
    this.ctx.reply(ws, msg.id, 'preset.setDefault', {} as Record<string, never>)
    return true
  }

  private replyCreate(msg: PresetMsg<'preset.create'>, ws: WsType): boolean {
    const { preset } = msg.payload
    // W-TR-1：savePreset 返 void，不再二次调 getPreset（避免触发第二次 loadPresetsFile）。
    // 直接用传入的 preset reply——runtime 可能 merge DEFAULT 字段（builtin preset 的
    // id/builtin/order/name 会被保护为 DEFAULT 值），前端如需精确形状应以 preset.list 重新拉取为准。
    this.ctx.presetService.savePreset(preset)
    this.ctx.reply(ws, msg.id, 'preset.create', { preset })
    return true
  }

  private replyUpdate(msg: PresetMsg<'preset.update'>, ws: WsType): boolean {
    const { preset } = msg.payload
    // W-TR-1：同 preset.create，不再二次调 getPreset，直接用传入 preset reply。
    this.ctx.presetService.savePreset(preset)
    this.ctx.reply(ws, msg.id, 'preset.update', { preset })
    return true
  }

  private replyDelete(msg: PresetMsg<'preset.delete'>, ws: WsType): boolean {
    const { presetId } = msg.payload
    this.ctx.presetService.deletePreset(presetId)
    // S-TR-1：preset.delete 在 ReplyPayloadMap 为 void（ack 型），但 reply() 用 ServerMessageMap[T]
    // 占位对象（同 setDefault 注释）。domain register<void> 忽略 payload。
    this.ctx.reply(ws, msg.id, 'preset.delete', {} as Record<string, never>)
    return true
  }

  // ── FR-14：使用统计 ──

  private replyRecordUsage(msg: PresetMsg<'preset.recordUsage'>, ws: WsType): boolean {
    const { presetId } = msg.payload
    this.ctx.presetService.recordUsage(presetId)
    // S-TR-1：preset.recordUsage 在 ReplyPayloadMap 为 void（ack 型），reply() 用 ServerMessageMap[T]
    // 占位对象（同 setDefault 注释）。
    this.ctx.reply(ws, msg.id, 'preset.recordUsage', {} as Record<string, never>)
    return true
  }

  private replyGetUsage(msg: PresetMsg<'preset.getUsage'>, ws: WsType): boolean {
    const usage = this.ctx.presetService.getUsage()
    this.ctx.reply(ws, msg.id, 'preset.getUsage', { usage })
    return true
  }

  // ── FR-13：导入/导出 ──

  private replyExport(msg: PresetMsg<'preset.export'>, ws: WsType): boolean {
    const json = this.ctx.presetService.exportPresets()
    this.ctx.reply(ws, msg.id, 'preset.export', { json })
    return true
  }

  private replyImport(msg: PresetMsg<'preset.import'>, ws: WsType): boolean {
    const { json } = msg.payload
    const count = this.ctx.presetService.importPresets(json)
    this.ctx.reply(ws, msg.id, 'preset.import', { count })
    return true
  }

  /**
   * 统一错误回复（原 handlePresetMessage catch 块，逐行保持）。
   * 返回 true：错误也已认领（已 reply error envelope）。
   */
  private sendPresetError(ws: WsType, msg: ClientMessage, e: unknown): true {
    const message = e instanceof Error ? e.message : String(e)
    // S-TR-4：优先透传 Error 自带 code（如 PresetGuardError 未来带 code）。
    // 其次区分 importPresets 的格式错误（S-TR-4）：消息命中 PRESET_IMPORT_FORMAT_ERROR_MESSAGES
    // 时用独立的 'preset_import_format_error' code（guard 是 builtin 保护语义，格式错误不算 guard 违规）。
    // 其余无 code 的 Error 回退 'preset_guard_error' 兜底（保持向后兼容）。
    const explicitCode = (e as Error & { code?: string }).code
    const code = explicitCode
      ?? (message && PRESET_IMPORT_FORMAT_ERROR_MESSAGES.has(message) ? 'preset_import_format_error' : 'preset_guard_error')
    this.ctx.sendError(ws, code, message, msg.id)
    return true
  }
}
