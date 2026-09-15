/**
 * ServerMessageBroker — IMessageBroker 实现：消息发送 + 广播 + initial state 推送（C2 从 server.ts 抽出）。
 *
 * 职责：
 * - IMessageBroker 三方法：send（单 ws）/ broadcast（所有 ws）/ sendError（统一 error envelope，D10/P0-B）。
 * - reply（D2）：带请求 id 的回复，E1 泛型化收窄 payload（ADR-0016 双向保护）。
 * - 8 个 broadcast helper：session/provider/skill/agent/skillDirs/agentDirs 列表广播（settings handler 触发）。
 * - sendInitialState（D7）：新连接推送 8 段 descriptor 驱动的初始状态。
 * - pushId 计数器：所有 push 消息的 id 生成（`push_<n>`）。
 *
 * 不含：连接生命周期（ConnectionManager）、消息路由（server.ts）、业务逻辑（handlers）。
 * broadcast 遍历 ConnectionManager.clients；sendInitialState 依赖 services 取数据。
 */
import type { WebSocket as WsType } from 'ws'
import type { ServerMessage, ServerMessageMap, ServerMessageType, SkillCacheScope, ProviderInfo } from '@taiji/shared'
import { OUTBOUND_FRAME_WARN_BYTES, OUTBOUND_FRAME_TRUNCATE_BYTES } from '@taiji/shared'
import type { ISessionService, IConfigService, IModelService, IMessageBroker, IPluginService, IExtensionService } from '../interfaces.js'
import { buildDirConfigs, PRESET_SKILL_DIRS, PRESET_AGENT_DIRS, PRESET_EXTENSION_DIRS } from '../services/skill-dir-config.js'
import { formatReplyOversizeMessage, appendReplyFrameJournal } from '../services/message-bus/outbound-frame-registry.js'
import type { ErrorDetails } from './message-context.js'
import { WS_OPEN } from './connection-manager.js'

/**
 * reply 通路守卫阈值（u4a：阈值参数化——生产默认 shared 常量 8MB/32MB，测试注入小阈值）。
 * 告警/截断档语义与 push 通路（outbound-frame-registry.ts）共用同一标尺。
 */
export interface ReplyGuardOptions {
  warnBytes: number
  truncateBytes: number
  /**
   * 组合根注入的 session 文件路径解析（reply 超限错误 envelope 恢复指引用）——与
   * OutboundFrameGuardOptions.resolveSessionFilePath 同名同语义（push 通路对称接线）。
   * 未注入时占位文案退化为「（见 runtime 日志）」。
   */
  resolveSessionFilePath?: (sessionId: string) => string | null | undefined
}

/** broker 访问连接池的最小契约（由 ConnectionManager 实现：clients Set）。 */
export interface ClientPool {
  readonly clients: Set<WsType>
}

/**
 * config.providers 下发前的 supportedLevels 标注（U5 接线，字段语义见 shared/provider.ts）。
 *
 * IModelService 已声明 attachSupportedLevels（U5 接口扩面），直接调接口方法；
 * 标注失败只 warn 不抛——registry 内部已有 mtime 读取等降级，这里兜底保证 provider 列表
 * 下发永不被能力标注阻断；抛错时返回原 providers（supportedLevels 缺省 = renderer
 * normalizeSupportedLevels(undefined) 归一默认五档语义，U6 后前端无本地推导可回退）。
 */
export function attachSupportedLevelsSafe(
  modelService: IModelService,
  providers: ProviderInfo[],
  piVersion?: string,
): ProviderInfo[] {
  try {
    return modelService.attachSupportedLevels(providers, piVersion)
  } catch (e) {
    console.warn('[broker] attachSupportedLevels failed — providers sent without capability annotation:', e)
    return providers
  }
}

/**
 * sendInitialState 需要的领域依赖（D7 8 段 descriptor 各取所需）。
 * 与 RuntimeServer.setServices 注入的 services 对齐——broker 不直接持有 git/file（initial state 不涉及）。
 */
export interface BrokerServices {
  sessionService: ISessionService
  configService: IConfigService
  modelService: IModelService
  pluginService: IPluginService | undefined
  /** extension service（sendInitialState 推 config.extensions 段需要；可选，未注入则跳过该段）。 */
  extensionService: IExtensionService | undefined
  projectRoot: string
  /** 应用 + pi 版本号（sendInitialState 推 app.info）。 */
  appInfo: { appVersion: string; piVersion: string }
}

export class ServerMessageBroker implements IMessageBroker {
  private pushId = 0

  constructor(
    private pool: ClientPool,
    private services: BrokerServices,
    private replyGuard: ReplyGuardOptions = { warnBytes: OUTBOUND_FRAME_WARN_BYTES, truncateBytes: OUTBOUND_FRAME_TRUNCATE_BYTES },
  ) {}

  /** push 消息 id 生成器（broadcast helper / sendInitialState 共用）。 */
  nextPushId(): string { return `push_${++this.pushId}` }

  // ── IMessageBroker ──────────────────────────────────────────────

  send(ws: WsType, msg: ServerMessage): void {
    if (ws.readyState === WS_OPEN) ws.send(JSON.stringify(msg))
  }

  broadcast(msg: ServerMessage): void {
    // wave:perf-w09（02 文档 D1-2）：broadcast 是纯全局通道——session 级 push 型消息
    //（payload 带 sessionId）必须走 IMessageBus.publish（seq/ring/订阅定向），禁止盲广播。
    // 误用告警（不 throw，不阻断发送）：新增消息类型接错通道时日志立即可见，
    // 是 V1「只推给订阅该 sid 的连接」不变量的运行时哨兵。合法的全局消息 payload 均无
    // sessionId 字段（见 02 文档 D5-1 排除清单）；uiRequest 无 sid 兜底时值为 undefined 不触发。
    const sid = (msg.payload as { sessionId?: unknown } | undefined)?.sessionId
    if (sid !== undefined) {
      console.warn(`[broadcast] session-scoped message "${msg.type}" went through global broadcast — use IMessageBus.publish instead (02 §3.3 D1-2)`)
    }
    // L6（perf-quick-batch）：循环外序列化一次。
    // 旧实现循环内调 this.send → send 内 JSON.stringify(msg)，N 客户端 = N 次重复
    // 序列化同一对象。session.list 等大 payload 广播时主线程被重复 stringify 阻塞。
    // 现在循环前序列化一次得 payload 字符串，循环内直接 ws.send(payload)。
    let payload: string
    try {
      payload = JSON.stringify(msg)
    // D4（不等价语义，刻意取舍）：提级后整次广播只 stringify 一次，
    // 一旦失败 → 本次广播对**所有 client 都丢弃**（连原本可正常收的 client 也收不到）。
    // 旧实现（循环内 per-client send 各自 stringify）失败只影响那一个 client，其余 client 照常收到。
    // 取舍：减少 N×stringify 主线程开销（大 payload 广播时显著）换取 per-client 失败隔离性损失。
    // 失败时显眼告警（[broadcast] 前缀，便于运维日志检索排查）。
    } catch (e) {
      console.error('[broadcast] payload serialization failed — entire broadcast dropped for all clients:', e)
      return
    }
    for (const ws of this.pool.clients) {
      // M6: 单 client send 失败不中断其余 client 广播。
      // TOCTOU：readyState 检查与 ws.send 间连接可能已关闭，ws.send 抛错，
      // 无 try-catch 会中断整个 for 循环，导致其余 client 收不到消息。
      if (ws.readyState !== WS_OPEN) continue
      try {
        ws.send(payload)
      // eslint-disable-next-line taste/no-silent-catch -- broadcast 是 fire-and-forget 推送，单 client 失败不能影响其余 client
      } catch {
        // 单 client 已断连/异常，跳过继续广播给其余 client
      }
    }
  }

  /**
   * 发送请求级操作失败的统一 error envelope（D10/P0-B）。
   * @param details 可选扩展槽：sessionId / hint / path 等附加信息。
   */
  sendError(ws: WsType, code: string, message: string, id?: string, details?: ErrorDetails): void {
    const payload: Record<string, unknown> = { code, message }
    if (details) {
      if (details.sessionId) payload.sessionId = details.sessionId
      // 其余扩展字段（hint/path/...）进 details 子对象，保持 envelope 顶层只有 code/message/sessionId。
      const extras = { ...details }
      delete extras.sessionId
      if (Object.keys(extras).length > 0) payload.details = extras
    }
    this.send(ws, { type: 'error', id, payload })
  }

  /**
   * D2 reply 惯用法：发送带请求 id 的回复，消灭 46 处 `send(ws,{type,id:msg.id,payload})` 样板。
   * E1 泛型化：`type` 字面量收窄 `payload` 到 `ServerMessageMap[T]`，构造侧字段错误在编译期暴露（ADR-0016 双向保护）。
   *
   * u4a reply 通路出站守卫（crash-resilience D3）：序列化后超截断档 → 整个 reply 替换为
   * `payload_too_large` 错误 envelope——前端 pending.resolveEnvelope（core/transport/api/
   * pending.ts:186-214）对 type:'error' 且 id 命中 pending 的 reply 走 reject，Promise 正常
   * 收口不悬挂；envelope message 含「加载更早」分页入口与 session 文件路径恢复指引。
   * 超告警档（未超截断档）写 warn 哨兵日志，不改动 reply。
   *
   * 实现注：本方法序列化一次后直接 ws.send(text)——与 send()（readyState 检查 + stringify）
   * 行为等价，但守卫需要帧字节数，单次序列化避免大 reply 双重 stringify 开销。
   * 序列化失败（循环引用等）→ 复用 sendError 收口为 error envelope（Promise 不悬挂），不抛错。
   */
  reply<T extends ServerMessageType>(ws: WsType, id: string | undefined, type: T, payload: ServerMessageMap[T]): void {
    let text: string
    try {
      text = JSON.stringify({ type, id, payload })
    } catch (e) {
      console.error(`[broker] reply serialization failed (type=${type}) — sending error envelope instead:`, e)
      this.sendError(ws, 'reply_serialization_failed', 'reply payload serialization failed', id)
      return
    }
    const bytes = Buffer.byteLength(text, 'utf8')
    const sid = (payload as { sessionId?: string } | undefined)?.sessionId
    if (bytes > this.replyGuard.truncateBytes) {
      console.warn(`[outbound-frame-guard] oversize reply replaced with error envelope: type=${type} sessionId=${sid ?? 'unknown'} bytes=${bytes}`)
      // u1e（crash-forensics D1）：reply 超限整帧替换 → frame-truncated(trunc-tier)。
      appendReplyFrameJournal('trunc-tier', type, sid, bytes)
      this.sendError(ws, 'payload_too_large', formatReplyOversizeMessage(bytes, sid, {
        warnBytes: this.replyGuard.warnBytes,
        truncateBytes: this.replyGuard.truncateBytes,
        resolveSessionFilePath: this.replyGuard.resolveSessionFilePath,
      }), id, sid !== undefined ? { sessionId: sid } : undefined)
      return
    }
    if (bytes > this.replyGuard.warnBytes) {
      console.warn(`[outbound-frame-guard] large outbound reply (warn): type=${type} sessionId=${sid ?? 'unknown'} bytes=${bytes}`)
      // u1e（crash-forensics D1）：reply 告警档 → frame-truncated(warn-tier)。
      appendReplyFrameJournal('warn-tier', type, sid, bytes)
    }
    if (ws.readyState === WS_OPEN) ws.send(text)
  }

  // ── Shared payload builders ─────────────────────────────────────
  // broadcast helpers 与 sendInitialState 此前各自重建同一组 provider/skill/agent/dir/model
  // payload（两份「initial/config state」表示）。现抽取私有 builder：只负责 load + 构造
  // ServerMessage（id 用 nextPushId），不含路由。broadcast 走 this.broadcast、sendInitialState
  // 走 this.send(ws,·)，共用同一 builder，消除 payload 构造重复。
  // 每个 builder 返回 1~2 条消息（provider 段含 config.providers + model.list）。

  private buildSessionListMsg(): ServerMessage {
    return { type: 'config.sessions', id: this.nextPushId(), payload: { groups: this.services.sessionService.listPersistedSessions() } }
  }
  /**
   * app.info 消息构造（sendInitialState 首推）。
   */
  private buildAppInfoMsg(): ServerMessage {
    return {
      type: 'app.info',
      id: this.nextPushId(),
      payload: { ...this.services.appInfo },
    }
  }
  private buildProviderListMsgs(): ServerMessage[] {
    // U5 接线：下发前标注 supportedLevels。pi 版本与 app.info 同源（services.appInfo.piVersion，
    // D8-2 组合根探测完成后 mutate 同对象，此处总读到当前值）。aggregateModelsWithScoped 的
    // ModelInfo 映射（pickModelCapabilityFields 白名单）不透传 supportedLevels，model.list 不受影响。
    const providers = attachSupportedLevelsSafe(
      this.services.modelService,
      this.services.configService.listProviders(),
      this.services.appInfo.piVersion,
    )
    // scopedModels 只读一次盘、两条消息复用同一值：aggregateModels 内部再读盘的话，
    // 两次读之间有写者落盘会让 config.providers.scopedModels 与 model.list 过滤结果
    // 互相矛盾一帧（review #4）。双参版聚合方法即为此引入（design D2 否决改单参签名）。
    const scopedModels = this.services.configService.getScopedModels()
    return [
      { type: 'config.providers', id: this.nextPushId(), payload: { providers, scopedModels } },
      { type: 'model.list', id: this.nextPushId(), payload: { models: this.services.modelService.aggregateModelsWithScoped(providers, scopedModels) } },
    ]
  }
  private buildSkillListMsg(): ServerMessage {
    return { type: 'config.skills', id: this.nextPushId(), payload: { skills: this.services.configService.loadSkills(this.services.projectRoot) } }
  }
  private buildAgentListMsg(): ServerMessage {
    return { type: 'config.agents', id: this.nextPushId(), payload: { agents: this.services.configService.loadAgents(this.services.projectRoot) } }
  }
  /** skill 加载路径配置（ADR-0021 §1 discovery.json SSOT 的 UI 视图）。 */
  private buildSkillDirsMsg(): ServerMessage {
    return { type: 'config.skillDirs', id: this.nextPushId(), payload: { dirs: buildDirConfigs(PRESET_SKILL_DIRS, this.services.configService.getSkillPathScopes()) } }
  }
  /** agent 加载路径配置（ADR-0021 §1 discovery.json SSOT 的 UI 视图）。 */
  private buildAgentDirsMsg(): ServerMessage {
    return { type: 'config.agentDirs', id: this.nextPushId(), payload: { dirs: buildDirConfigs(PRESET_AGENT_DIRS, this.services.configService.getAgentPathScopes()) } }
  }
  /** extension 加载路径配置（ADR-0021 §1 discovery.json SSOT 的 UI 视图）。 */
  private buildExtensionDirsMsg(): ServerMessage {
    return { type: 'config.extensionDirs', id: this.nextPushId(), payload: { dirs: buildDirConfigs(PRESET_EXTENSION_DIRS, this.services.configService.getExtensionPathScopes()) } }
  }

  // ── Broadcast helpers ──────────────────────────────────────────

  broadcastSessionList(): void {
    this.broadcast(this.buildSessionListMsg())
  }
  /**
   * 广播 app.info（D8-2，06 §3.3）：piVersion 惰性探测的补发入口。
   * sendInitialState 首推后，组合根（index.ts）在 getPiVersion 完成时 mutate services.appInfo
   * 同对象（piVersion 字段）再调本方法——buildAppInfoMsg 的 spread 读到当前值，
   * 侧栏版本标签先显示应用版本、探测完成后 1-2s 内自动补全（唯一消费者 Sidebar.vue 监听 app.info）。
   */
  broadcastAppInfo(): void {
    this.broadcast(this.buildAppInfoMsg())
  }
  broadcastProviderList(): void {
    for (const msg of this.buildProviderListMsgs()) this.broadcast(msg)
  }
  broadcastSkillList(): void {
    this.broadcast(this.buildSkillListMsg())
  }
  /**
   * 广播 skill 缓存失效信号（让 landing useGlobalSkills/useProjectSkills 失效缓存重拉）。
   * 与 broadcastSkillList 区分：
   *   - broadcastSkillList = 全量列表推送到 settingsStore.skills（settings 弹窗用）
   *   - broadcastSkillCacheInvalidated = 失效信号给 landing composable（runtime 已重扫缓存，前端重拉即拿新值）
   */
  broadcastSkillCacheInvalidated(scope: SkillCacheScope, cwd?: string): void {
    const msg = {
      type: 'config.skillCacheInvalidated' as const,
      id: this.nextPushId(),
      payload: { scope, cwd },
    } satisfies ServerMessage<'config.skillCacheInvalidated'>
    this.broadcast(msg)
  }
  broadcastAgentList(): void {
    this.broadcast(this.buildAgentListMsg())
  }
  /** 广播 skill 加载路径配置（ADR-0021 §1 discovery.json SSOT 的 UI 视图）。 */
  broadcastSkillDirs(): void {
    this.broadcast(this.buildSkillDirsMsg())
  }
  /** 广播 agent 加载路径配置（ADR-0021 §1 discovery.json SSOT 的 UI 视图）。 */
  broadcastAgentDirs(): void {
    this.broadcast(this.buildAgentDirsMsg())
  }
  /** 广播 extension 加载路径配置（ADR-0021 §1 discovery.json SSOT 的 UI 视图）。 */
  broadcastExtensionDirs(): void {
    this.broadcast(this.buildExtensionDirsMsg())
  }

  /**
   * D7: sendInitialState 改 descriptor 驱动。
   * 此前 6 段同构 best-effort try/catch（eslint-disable 注释也复制了 6 次）。
   * 现在每段是一个 { label, run } descriptor，共享 try/catch 包装器只写一次。
   * run 内含 load + 条件 + send，领域差异保留在各自 descriptor。
   *
   * 与 broadcast helper 去重：前 7 段（session/provider+model/skills/skillDirs/agents/agentDirs）
   * 改为调用与 broadcast helper 共享的 buildXxx builder，消除此前两处独立重建同一 payload。
   * 仅 config.defaults / config.plugins 两段为 initial-state 独有（无对应 broadcast helper），保留 inline。
   */
  sendInitialState(ws: WsType): void {
    const { configService, pluginService, extensionService } = this.services
    const steps: Array<{ label: string; run: () => void }> = [
      {
        label: 'app.info',
        run: () => this.send(ws, this.buildAppInfoMsg()),
      },
      {
        label: 'config.sessions',
        run: () => this.send(ws, this.buildSessionListMsg()),
      },
      {
        label: 'config.providers/model.list',
        run: () => { for (const msg of this.buildProviderListMsgs()) this.send(ws, msg) },
      },
      {
        label: 'config.defaults',
        run: () => {
          const defaultModel = configService.getDefaultModel()
          if (defaultModel) {
            this.send(ws, { type: 'config.defaults', id: this.nextPushId(), payload: { defaultModel: `${defaultModel.provider}/${defaultModel.modelId}` } })
          }
        },
      },
      {
        label: 'config.skills',
        run: () => this.send(ws, this.buildSkillListMsg()),
      },
      {
        label: 'config.skillDirs',
        run: () => this.send(ws, this.buildSkillDirsMsg()),
      },
      {
        label: 'config.agents',
        run: () => this.send(ws, this.buildAgentListMsg()),
      },
      {
        label: 'config.agentDirs',
        run: () => this.send(ws, this.buildAgentDirsMsg()),
      },
      {
        label: 'config.extensionDirs',
        run: () => this.send(ws, this.buildExtensionDirsMsg()),
      },
      {
        // config.systemPrompt（FR-4/FR-5）：spec §6 要求「reply + broadcast + 初始推送三用」。
        // 前两用在 settings handler + ConfigService 变更广播，此段补 initial-state 推送，
        // 前端首次打开 Settings · SystemPromptPage 无需额外 getSystemPrompt 往返即可填充编辑态。
        label: 'config.systemPrompt',
        run: () => {
          const r = configService.getSystemPromptConfig()
          this.send(ws, { type: 'config.systemPrompt', id: this.nextPushId(), payload: { config: r.config, corrupted: r.corrupted } })
        },
      },
      {
        // config.terminalConfig（Phase 6）：复刻 config.systemPrompt 范式，初始推送 terminal 配置，
        // 前端首次打开 Settings · TerminalPage 无需额外 getTerminalConfig 往返即可填充编辑态。
        label: 'config.terminalConfig',
        run: () => {
          const r = configService.getTerminalConfig()
          this.send(ws, { type: 'config.terminalConfig', id: this.nextPushId(), payload: { config: r.config, corrupted: r.corrupted } })
        },
      },
      {
        label: 'config.plugins',
        run: () => {
          if (pluginService) {
            this.send(ws, { type: 'config.plugins', id: this.nextPushId(), payload: { plugins: pluginService.getDiscoveredPlugins() } })
          }
        },
      },
      {
        // extension 列表（已装的 pi extension）。前端 Settings · ExtensionPage 的
        // 「已安装」区 + 推荐区的 installed 状态都依赖此初始推送。install/uninstall/toggle
        // 后的 reply（config.extensions）会增量更新，但首次打开需要 initial state。
        //
        // scanExtensions 是 async（读文件系统），而 sendInitialState 的 for 循环是同步的
        // （onConnect 签名 void）。这里 fire-and-forget + 自带 catch：扫描完成后异步 send，
        // 失败仅记日志，不阻塞其他 step，也不影响外层同步 try-catch（Promise reject 自消费）。
        label: 'config.extensions',
        run: () => {
          if (!extensionService) return
          extensionService.scanExtensions()
            .then((extensions) => {
              this.send(ws, { type: 'config.extensions', id: this.nextPushId(), payload: { extensions } })
            })
            .catch((e) => console.error(`[runtime] sendInitialState: config.extensions scan failed:`, e))
        },
      },
    ]
    for (const step of steps) {
      try {
        step.run()
      // eslint-disable-next-line taste/no-silent-catch -- init: best-effort, single failure must not block others
      } catch (e) { console.error(`[runtime] sendInitialState: ${step.label} failed:`, e) }
    }
  }
}
