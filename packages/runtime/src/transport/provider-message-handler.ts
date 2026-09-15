/**
 * Provider 域 config.* message handler（provider CRUD/启停/按体系移除 + 远程目录刷新 +
 * 环境变量检查 + 内置模板与跨 agent 导入迁移 + 源检测，11 条 case）。
 *
 * Extracted from settings-message-handler.ts to reduce file size（该文件同类先例：
 * config-preferences-message-handler.ts 同款 class + handle() switch 形态；case 体自
 * 原文件逐一原样迁移，行为保持）。本域共享编排收口：reconcileDefaultModelAfterProviderChange
 * （defaultModel 对账广播）+ broadcastProviderList（provider 列表变更广播）。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, DefaultModelSource, ProviderSource, ProviderId } from '@xyz-agent/shared'
import type { IConfigService } from '../interfaces.js'
import type { SettingsHandlerContext } from './settings-message-handler.js'
import { attachSupportedLevelsSafe } from './message-broker.js'

/**
 * provider 增删后统一维护 defaultModel（design provider-arch-hardening §3.3 D3 / Phase 3）。
 *
 * 二选一：有 newDefault 直接用（不读盘）；无则 getDefaultModel 兜底（内部 findValidDefaultModel +
 * wasFixed:true 时写回 settings.json）。config.defaults 广播收敛在本 helper 内一次，消除 5 handler
 * 各自编排的遗漏根因（applyImportProviders 曾漏维护，commit cd41254ba 局部补）。
 *
 * broadcastProviderList 不在此收口（决策 D3：语义正交——provider 列表变更 vs defaultModel 对账；
 * 且 applyImport 只成功时广播、其它总广播，留各 handler 更清晰）。
 */
function reconcileDefaultModelAfterProviderChange(
  ctx: SettingsHandlerContext,
  source: DefaultModelSource,
  existingNewDefault?: { provider: ProviderId; modelId: string },
): void {
  const dm = existingNewDefault ?? ctx.configService.getDefaultModel()
  if (!dm) return
  // source 用 shared DefaultModelSource 联合的合法成员，按调用场景映射
  //（provider-updated=增改/启停/导入，provider-deleted=删除），由本参数的类型在调用点
  // 强制校验。ServerMessage 大联合实例化下 type/payload 联动约束仍缺失（broadcast 非
  // 泛型，无法在此钉死单一消息类型），但 source 参数已把非法字面量挡在编译期。
  ctx.broadcast({
    type: 'config.defaults',
    id: ctx.nextPushId(),
    payload: { defaultModel: `${dm.provider}/${dm.modelId}`, source },
  })
}

export class ProviderMessageHandler {
  constructor(private ctx: SettingsHandlerContext) {}

  /** 处理 provider 域消息；不匹配返回 false（由 SettingsMessageHandler 继续路由）。 */
  async handle(msg: ClientMessage, ws: WsType): Promise<boolean> {
    switch (msg.type) {
      // scoped-model design §3.3 D7：reply 与广播（message-broker.buildProviderListMsgs）均含 scopedModels。
      // supportedLevels 同样两路同标（U5 接线）：本 ctx 无 appInfo，piVersion 缺省（registry 以
      // 逐模型签名兜底，缓存正确性不依赖该组分——见 model-capability.ts 头注）。
      case 'config.getProviders': {
        this.ctx.reply(ws, msg.id, 'config.providers', {
          providers: attachSupportedLevelsSafe(this.ctx.modelService, this.ctx.configService.listProviders()),
          scopedModels: this.ctx.configService.getScopedModels(),
        })
        return true
      }
      case 'config.refreshProviderCatalogs': {
        // settings-provider 页进入时触发：远程模型目录 ETag 协商刷新（单请求 4s 超时，
        // 全部 fail-safe），完成后广播新列表（store 常驻订阅自动更新，renderer 零状态管理）。
        const result = await this.ctx.configService.refreshProviderCatalogs()
        this.ctx.reply(ws, msg.id, 'config.providerCatalogsRefreshed', result)
        this.ctx.broadcastProviderList()
        return true
      }
      case 'config.setProvider': {
        const { providerId, ...data } = msg.payload
        const setResult = await this.ctx.configService.setProvider(providerId, data as Parameters<IConfigService['setProvider']>[1])
        this.ctx.reply(ws, msg.id, 'config.providerUpdated', { providerId })
        this.ctx.broadcastProviderList()
        reconcileDefaultModelAfterProviderChange(this.ctx, 'provider-updated', setResult.newDefault)
        return true
      }
      case 'config.deleteProvider': {
        const delResult = await this.ctx.configService.deleteProvider(msg.payload.providerId)
        this.ctx.reply(ws, msg.id, 'config.providerUpdated', { providerId: msg.payload.providerId, deleted: true })
        this.ctx.broadcastProviderList()
        reconcileDefaultModelAfterProviderChange(this.ctx, 'provider-deleted', delResult.newDefault)
        return true
      }
      case 'config.toggleProviderEnabled': {
        // wave4 C1：provider 启用切换走 toggleProviderEnabled（写 enabledModels 白名单），
        // 替代旧 setProvider({enabled})。reply config.providerUpdated + broadcastProviderList
        // （wave2 双源聚合 + deriveEnabled 派生新启用状态）+ newDefault 广播（边界2 default 重选）。
        const { providerId, enabled } = msg.payload
        const toggleResult = this.ctx.configService.toggleProviderEnabled(providerId, enabled)
        this.ctx.reply(ws, msg.id, 'config.providerUpdated', { providerId })
        this.ctx.broadcastProviderList()
        reconcileDefaultModelAfterProviderChange(this.ctx, 'provider-updated', toggleResult.newDefault)
        return true
      }
      case 'config.removeProviderByKind': {
        // wave4 IF3：按体系移除 provider。catalog 清凭据/override/残留（不删 pi 定义），
        // custom 删条目 + 清残留。reply config.providerUpdated + broadcastProviderList +
        // newDefault 广播（custom 分支 removeProvider 内 default 重选）。
        const { providerId, kind } = msg.payload
        const removeResult = await this.ctx.configService.removeProviderByKind(providerId, kind)
        this.ctx.reply(ws, msg.id, 'config.providerUpdated', { providerId, deleted: true })
        this.ctx.broadcastProviderList()
        reconcileDefaultModelAfterProviderChange(this.ctx, 'provider-deleted', removeResult.newDefault)
        return true
      }
      case 'config.checkEnvVars': {
        // I3 契约：names 必须是字符串数组，非法 payload → sendError invalid_payload（对齐 D10 错误 envelope）
        const names = msg.payload.names
        if (!Array.isArray(names) || names.some(n => typeof n !== 'string')) {
          this.ctx.sendError(ws, 'invalid_payload', 'names 必须是字符串数组')
          return true
        }
        const results = this.ctx.configService.checkEnvVars(names)
        this.ctx.reply(ws, msg.id, 'config.envVarsChecked', { results })
        return true
      }
      case 'config.detectSources': {
        // W1 迁移功能：检测本机其他 agent（Claude/Codex/Pi/ZCode）的 skill/agent 配置目录。
        // 只读检测（不读文件内容），reply 检测结果数组。无副作用，无需广播。
        const sources = this.ctx.configService.detectSources()
        this.ctx.reply(ws, msg.id, 'config.sourcesDetected', { sources })
        return true
      }
      case 'config.listBuiltinProviders': {
        // wave 2：列出内置 provider 模板（import generated JSON，无参只读）。reply config.builtinProviders。
        this.ctx.reply(ws, msg.id, 'config.builtinProviders', { providers: this.ctx.configService.listBuiltinProviders() })
        return true
      }
      case 'config.previewImportProviders': {
        // W2 迁移：Step1 预览从其他 agent 源导入的 provider 列表（脱敏，apiKey 不进前端）。
        // result 可能是 { importId, preview }（成功）或 { error }（源未安装等），reply 原样转发。
        // 前端按有无 error 字段判断成败。无广播（按需 RPC，apply 后才广播 provider 列表）。
        // W1：payload 字段校验——source 必须是已知 ProviderSource，否则 sendError。
        const source = msg.payload?.source
        const VALID_SOURCES: ProviderSource[] = ['pi', 'zcode', 'codex', 'claude']
        if (typeof source !== 'string' || !VALID_SOURCES.includes(source as ProviderSource)) {
          this.ctx.sendError(ws, 'invalid_payload', 'config.previewImportProviders requires a valid "source" (pi|zcode|codex|claude)', msg.id)
          return true
        }
        const result = this.ctx.configService.previewImportProviders(source as ProviderSource)
        this.ctx.reply(ws, msg.id, 'config.providersPreviewed', result)
        return true
      }
      case 'config.applyImportProviders': {
        // W2 迁移：Step2 应用导入（写 models.json）。result 可能是 { result }（成功）或 { error }（缓存过期等）。
        // apply 成功后广播 provider 列表（与 setProvider/deleteProvider 对称，让所有 panel 同步新增的 provider）。
        // W1：payload 字段校验——importId 必须是字符串，selectedIds 必须是字符串数组，否则 sendError。
        const importId = msg.payload?.importId
        const selectedIds = msg.payload?.selectedIds
        if (typeof importId !== 'string' || !importId.trim() ||
            !Array.isArray(selectedIds) || !selectedIds.every((id: unknown) => typeof id === 'string')) {
          this.ctx.sendError(ws, 'invalid_payload', 'config.applyImportProviders requires a non-empty "importId" string and "selectedIds" string array', msg.id)
          return true
        }
        const result = await this.ctx.configService.applyImportProviders(importId, selectedIds as string[])
        this.ctx.reply(ws, msg.id, 'config.providersImported', result)
        // 仅成功时广播（result 有 result 字段 = 成功；有 error 字段 = 失败，不广播）
        if ('result' in result) {
          this.ctx.broadcastProviderList()
          // 导入后重选 defaultModel：不传 newDefault → reconcile 自动走 getDefaultModel 兜底
          //（内部 findValidDefaultModel + wasFixed:true 时写回 settings.json）。
          reconcileDefaultModelAfterProviderChange(this.ctx, 'provider-updated')
          // D9（pi-evolution-consistency-and-project-switcher §3.3）：导入成功后 fire-and-forget
          // 刷新远程模型目录（overlay 通道）——导入的 catalog provider 此刻才进 listProviders，
          // 不刷则其模型列表停留在快照（「导入后模型列表不新鲜」的原始场景）。完成后广播新列表
          //（与 config.refreshProviderCatalogs case 的 refresh→broadcast 模式同构）；不阻塞导入
          // reply，失败仅日志（refresh 自身 4s 超时 fail-safe，导入主语义已成功，失败可重进页面重试）。
          void this.ctx.configService.refreshProviderCatalogs()
            .then(() => { this.ctx.broadcastProviderList() })
            .catch((e: unknown) => {
              console.warn('[settings-handler] applyImportProviders: provider catalog refresh failed:', e)
            })
        }
        return true
      }
      default:
        return false
    }
  }
}
