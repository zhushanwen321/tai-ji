/**
 * 模型域 message handler（model.list / model.switch / config.setDefaultModel /
 * config.setScopedModels / session.setThinkingLevel / config.discoverModels，6 条 case）。
 *
 * Extracted from settings-message-handler.ts to reduce file size（该文件同类先例：
 * config-preferences-message-handler.ts 同款 class + handle() switch 形态；case 体自
 * 原文件逐一原样迁移，行为保持）。统一变化轴：模型解析与档位控制——列表聚合、会话
 * 切换/档位（modelService）、默认值与 scoped 白名单（configService + default 同步）、
 * 模型发现与测试连接（凭据 resolver 唯一通道 + connectionTester）。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage } from '@xyz-agent/shared'
import type { SettingsHandlerContext } from './settings-message-handler.js'
import { SCOPED_MODEL_REGEX } from '../services/provider-extras-store.js'
import { toErrorMessage } from '../utils/errors.js'
import { PROVIDER_CONNECTION_TEST_ERRORS } from '../services/model-service.js'
import type { ProviderConnectionTestOutcome } from '../services/model-service.js'

export class ModelMessageHandler {
  constructor(private ctx: SettingsHandlerContext) {}

  /**
   * 处理模型域消息；不匹配返回 false。
   *
   * 本方法刻意不做 async 包装（返回 boolean | Promise<boolean>，与原主文件 case 分发的
   * 同步时序逐拍一致）：M2c 装配测试（settings-message-handler.test.ts「config.discoverModels
   * 经该 resolver 取凭据」）锁定 discover 回执链的微拍时序——其 waitFor 只等 discover 调用
   * 便立即断言 ws.send；async 包装会让 handleSettingsMessage 的 promise 采纳晚 1-2 个微拍，
   * 使该测试 waitFor 首查从「未命中」（走 50ms 轮询安全路径）翻为「命中」（回执尚未发出即断言），
   * 稳定误报回执丢失。其余域子 handler 无此微拍锁定，保持先例 async 形态。
   */
  handle(msg: ClientMessage, ws: WsType): boolean | Promise<boolean> {
    switch (msg.type) {
      case 'model.list':
        return this.handleModelList(msg, ws)
      case 'model.switch':
        return this.handleModelSwitch(msg, ws)
      case 'config.setDefaultModel':
        return this.handleConfigSetDefaultModel(msg, ws)
      case 'session.setThinkingLevel':
        return this.handleSessionSetThinkingLevel(msg, ws)
      case 'config.setScopedModels':
        return this.handleConfigSetScopedModels(msg, ws)
      case 'config.discoverModels':
        return this.handleDiscoverModels(msg, ws)
      default:
        return false
    }
  }

  private handleModelList(msg: Extract<ClientMessage, { type: 'model.list' }>, ws: WsType): boolean {
    this.ctx.reply(ws, msg.id, 'model.list', { models: this.ctx.modelService.aggregateModels(this.ctx.configService.listProviders()) })
    return true
  }

  private async handleModelSwitch(msg: Extract<ClientMessage, { type: 'model.switch' }>, ws: WsType): Promise<boolean> {
    const { sessionId, provider, modelId } = msg.payload
    console.log(`[runtime] model.switch: sessionId=${sessionId}, provider=${provider}, modelId=${modelId}`)
    // C-pi-13 回执修型（U6）：reply 回传生效值——pi pattern 引擎可能把请求模型
    // 静默换成同族条目（事故 A 形态），switchModel 经 set→get_state 读回
    // 'provider/id' 复合串（请求 ≠ 生效），拆解回填保持 reply 协议形状；
    // 无 '/' 形态（无活跃进程早退等 fallback）按请求值回显（旧行为兜底）。
    const effectiveModel = await this.ctx.modelService.switchModel(sessionId, provider, modelId)
    const slash = effectiveModel.indexOf('/')
    this.ctx.reply(ws, msg.id, 'model.switched', {
      sessionId,
      provider: slash === -1 ? provider : effectiveModel.slice(0, slash),
      modelId: slash === -1 ? modelId : effectiveModel.slice(slash + 1),
    })
    return true
  }

  private handleConfigSetDefaultModel(msg: Extract<ClientMessage, { type: 'config.setDefaultModel' }>, ws: WsType): boolean {
    // W3 默认模型持久化：configService.setDefaultModel 已存在（写 settings.json）。
    // reply 回发起端（不带 source） + 广播给所有 panel（带 source='default-set'），与
    // setProvider/deleteProvider 的 newDefault 广播同构，让其它打开的设置面板同步默认模型下拉。
    // reply 与 broadcast 共用 ServerMessageMap['config.defaults'] 类型，source 为 optional。
    const { provider, modelId } = msg.payload
    this.ctx.configService.setDefaultModel(provider, modelId)
    this.ctx.reply(ws, msg.id, 'config.defaults', {
      defaultModel: `${provider}/${modelId}`,
    })
    this.ctx.broadcast({
      type: 'config.defaults',
      id: this.ctx.nextPushId(),
      payload: { defaultModel: `${provider}/${modelId}`, source: 'default-set' },
    })
    return true
  }

  private async handleSessionSetThinkingLevel(msg: Extract<ClientMessage, { type: 'session.setThinkingLevel' }>, ws: WsType): Promise<boolean> {
    const { sessionId: sid, level } = msg.payload
    // P3（final gate）：reply 生效值而非请求值——pi 会钳制模型族不支持的档位
    //（mimo 族 max → high；钳制后 effective ≠ previous 时 pi 仍必发
    // thinking_level_changed 事件，isChanging=false 仅「值未变」场景——PS-04），
    // 回显请求值会污染前端 pending 确认
    const effective = await this.ctx.modelService.setThinkingLevel(sid as string, level as string)
    this.ctx.reply(ws, msg.id, 'session.thinkingLevelSet', { sessionId: sid, level: effective })
    return true
  }

  private async handleConfigSetScopedModels(msg: Extract<ClientMessage, { type: 'config.setScopedModels' }>, ws: WsType): Promise<boolean> {
    const { models } = msg.payload
    // 格式校验：每条 ^[^/]+/.+$，非法整单拒绝
    if (!Array.isArray(models) || models.some(m => typeof m !== 'string')) {
      this.ctx.sendError(ws, 'invalid_payload', 'models 必须是字符串数组', msg.id)
      return true
    }
    // 格式契约与读侧 sanitize 单点（provider-extras-store SCOPED_MODEL_REGEX）
    const invalid = (models as string[]).filter(m => !SCOPED_MODEL_REGEX.test(m))
    if (invalid.length > 0) {
      this.ctx.sendError(ws, 'invalid_scoped_models', `以下模型格式非法（需 provider/modelId）：${invalid.join(', ')}`, msg.id)
      return true
    }
    // 去重保序（Set 迭代序 = 插入序）
    const deduped = [...new Set(models as string[])]
    // 写入（IConfigService.modifyScopedModels → XyzProviderStore RMW）
    const result = await this.ctx.configService.modifyScopedModels(() => deduped)
    const defaultSynced = this.syncDefaultToScopedModels(result)
    // 广播
    this.ctx.broadcastProviderList()
    if (defaultSynced) {
      this.ctx.broadcast({
        type: 'config.defaults',
        id: this.ctx.nextPushId(),
        payload: { defaultModel: result[0], source: 'default-set' },
      })
    }
    this.ctx.reply(ws, msg.id, 'config.scopedModels', { scopedModels: result })
    return true
  }

  /**
   * 列表非空且 scoped[0] ≠ 当前 default 时同步 default = scoped[0]（config.setScopedModels 编排步骤）。
   * 返回 defaultSynced：同步生效（含已是 default 的幂等情形）才广播 config.defaults；
   * 同步被跳过/失败时保留现有 default，不广播未落盘的假默认。
   */
  private syncDefaultToScopedModels(result: string[]): boolean {
    if (result.length === 0) return false
    const firstModel = result[0]
    try {
      const [provider, ...modelParts] = firstModel.split('/')
      const modelId = modelParts.join('/')
      // scoped[0] 的 provider 须在当前列表且未禁用：把禁用 provider 的模型写成
      // default 会被 getDefaultModel 内 findValidDefaultModel 随后冲掉（静默破坏
      // 「第一位即默认」），跳过同步、保留现有 default
      const providerInfo = this.ctx.configService.listProviders().find(p => p.id === provider)
      if (!providerInfo || providerInfo.enabled === false) {
        console.warn(`[settings-handler] setScopedModels: scoped[0] "${firstModel}" 的 provider 不可用（${providerInfo ? '已禁用' : '不在 providers 列表'}），跳过 default 同步，保留现有 default`)
        return false
      }
      const currentDefault = this.ctx.configService.getDefaultModel()
      if (!currentDefault || `${currentDefault.provider}/${currentDefault.modelId}` !== firstModel) {
        this.ctx.configService.setDefaultModel(provider, modelId)
      }
      return true
    } catch (err) {
      // best-effort 降级：scoped 白名单写入是主语义，default 同步失败（读 default/
      // 写 default 抛错）只 warn 不上抛——上抛会跳过广播与 reply，造成磁盘/前端/
      // 选择器三方状态撕裂（对齐 provider-config-helper cleanAuthCredential 惯例）
      console.warn(`[settings-handler] setScopedModels: default 同步到 "${firstModel}" 失败（scopedModels 已写入 ${result.length} 条），保留现有 default：`, err)
      return false
    }
  }

  private handleDiscoverModels(msg: Extract<ClientMessage, { type: 'config.discoverModels' }>, ws: WsType): boolean {
    const { baseUrl, apiKey, providerType, providerId, mode } = msg.payload
    // test 模式（D4）：按模型协议分组发真实最小请求——baseUrl / apiKey 忽略（凭据经 resolver
    // 唯一通道取，代表模型与端点回落链归 runtime）。缺省 / 'discover' 保持既有 GET /v1/models
    // 行为逐字节不变（CLI 与旧调用方零改动，向后兼容）。
    if (mode === 'test') return this.handleTestConnections(msg, ws, providerId)
    // 链 2（D3 收口）：payload 未带 apiKey 时经 resolver async 版解析（auth.json → models.json），
    // 修复「catalog 凭据只在 auth.json 时恒 miss」。
    const credentialPromise: Promise<string | undefined> = apiKey
      ? Promise.resolve(apiKey)
      : providerId
        ? this.resolveProviderApiKey(providerId)
        : Promise.resolve(undefined)
    // 错误文案翻译（ByteString / fetch failed → 中文）已下沉 model-service；
    // handler 只 reply service 返回的 models 或 error.message。
    credentialPromise
      .then((resolvedApiKey) => this.ctx.modelService.discoverModelsFromApi(baseUrl, resolvedApiKey, providerType))
      .then((models) => { this.ctx.reply(ws, msg.id, 'config.discoveredModels', { models, success: true }) })
      .catch((e: unknown) => {
        this.ctx.reply(ws, msg.id, 'config.discoveredModels', { models: [], success: false, error: toErrorMessage(e) })
      })
    return true
  }

  /**
   * test 模式编排：凭据经 resolver → modelService 发 per-协议真实最小请求 → reply results。
   * 行级失败（协议不支持 / 无 baseUrl / 无启用模型 / HTTP / 网络）不改变顶层 success，
   * 顶层 success:false 仅承载 provider 级失败 code（见 PROVIDER_CONNECTION_TEST_ERRORS）。
   */
  private handleTestConnections(
    msg: Extract<ClientMessage, { type: 'config.discoverModels' }>,
    ws: WsType,
    providerId: string | undefined,
  ): boolean {
    if (!providerId) {
      this.replyTestResult(ws, msg.id, { success: false, error: PROVIDER_CONNECTION_TEST_ERRORS.providerNotFound })
      return true
    }
    // 交集类型的可选方法：解构后判函数（运行时守卫，替代对 IModelService 的强制断言）
    const testProviderConnections = this.ctx.modelService.testProviderConnections
    if (typeof testProviderConnections !== 'function') {
      this.replyTestResult(ws, msg.id, { success: false, error: PROVIDER_CONNECTION_TEST_ERRORS.testUnavailable })
      return true
    }
    this.resolveProviderApiKey(providerId)
      .then(apiKey => testProviderConnections.call(this.ctx.modelService, providerId, apiKey, this.ctx.connectionTester))
      .then(outcome => { this.replyTestResult(ws, msg.id, outcome) })
      .catch((e: unknown) => {
        this.replyTestResult(ws, msg.id, { success: false, error: toErrorMessage(e) })
      })
    return true
  }

  /** test 模式 reply 装配（成功带 results、失败带 provider 级 code；`models` 恒空——test 不发现模型）。 */
  private replyTestResult(ws: WsType, id: string | undefined, outcome: ProviderConnectionTestOutcome): void {
    this.ctx.reply(ws, id, 'config.discoveredModels', outcome.success
      ? { models: [], success: true, results: outcome.results }
      : { models: [], success: false, error: outcome.error, results: [] })
  }

  /** discover 凭据回查（链 2）：唯一通道（auth.json → models.json，ctx 构造必需注入）。 */
  private async resolveProviderApiKey(providerId: string): Promise<string | undefined> {
    const resolved = await this.ctx.providerCredentialResolver.resolveProviderCredential(providerId)
    return resolved?.key
  }
}
