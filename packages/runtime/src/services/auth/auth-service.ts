/**
 * AuthService — OAuth login 编排服务（slice design I1/T5）。
 *
 * 职责：
 * - login(providerId)：启动 OAuth flow（异步跑 runOAuthLogin），中间态经 broadcast
 *   推 auth.deviceCode / auth.authUrl，终态 auth.success / auth.error
 * - cancel(providerId)：abort 进行中的 flow（停轮询 / 关 callback server / 清 state）
 * - hasOAuth(providerId)：读 auth.json 是否有 oauth 凭据（provider 列表徽章数据源）
 * - logout(providerId)：退出登录——移除 auth.json 凭证（B-1 场景 C，先中止进行中 flow）
 * - getCredential/saveCredential(providerId)：auth.json 凭证的收口读/写通道（A1-4）
 *   ——全 runtime 对 auth.json 的写入唯一入口（三 Store 收口，架构 §3.4）
 * - both 清理②（I9）：login 成功后清 models.json apiKey——authMode='both' 的 provider
 *   切换认证方式时清另一种凭据，避免 pi 优先级困惑
 *
 * 装配对齐 HandoffService 先例：broadcast + nextPushId 由组合根注入（server/broker），
 * 不直接依赖 server；clearApiKey 是窄函数（组合根闭包包 pi-provider-store），避免
 * 与 configService 形成依赖环。
 *
 * 安全红线：auth.* 事件 payload 只含 providerId/url/userCode，token 永不出现在
 * 事件与日志中；错误消息只含 HTTP 状态/字段名，不含响应体。
 */
import type { BuiltinOAuthConfig, ServerMessage, ServerMessageMap } from '@taiji/shared'
import type { IAuthService } from '../../interfaces.js'
import type { AuthStorage, Credential } from './auth-storage.js'
import { runOAuthLogin } from './oauth-flow.js'

export interface AuthServiceDeps {
  /** auth.json 存储（组合根按 getPiAgentDir()/auth.json 构造） */
  authStorage: Pick<AuthStorage, 'get' | 'getAll' | 'set' | 'remove' | 'hasOAuth'>
  /** 取 provider 的 oauthConfig（builtin-providers.json，无则返回 undefined） */
  getOAuthConfig(providerId: string): BuiltinOAuthConfig | undefined
  /** 推 server→client 事件（auth.* 系列） */
  broadcast(msg: ServerMessage): void
  /** 事件 id 生成（对齐 broker.nextPushId） */
  nextPushId(): string
  /** I9 清理②：OAuth 授权成功后清 models.json apiKey（幂等，无 apiKey 时 no-op） */
  clearApiKey(providerId: string): void
}

type AuthEventType = 'auth.deviceCode' | 'auth.authUrl' | 'auth.success' | 'auth.error'

export class AuthService implements IAuthService {
  /** 进行中的 flow：providerId → abort controller（并发多 provider 互不干扰） */
  private activeFlows = new Map<string, AbortController>()

  constructor(private readonly deps: AuthServiceDeps) {}

  /**
   * 启动 OAuth login（异步执行，立即返回 started 状态）。
   * 已有进行中 flow 或 provider 无 oauthConfig → 返回 started:false + error。
   */
  login(providerId: string): { started: boolean; error?: string } {
    const config = this.deps.getOAuthConfig(providerId)
    if (!config) {
      return { started: false, error: `provider "${providerId}" 不支持 OAuth` }
    }
    if (this.activeFlows.has(providerId)) {
      return { started: false, error: '已有进行中的 OAuth 授权流程' }
    }
    const controller = new AbortController()
    this.activeFlows.set(providerId, controller)
    void this.runFlow(providerId, config, controller)
    return { started: true }
  }

  /**
   * 中止进行中的 OAuth flow。幂等：无进行中 flow 返回 cancelled:false（不报错）。
   * 同步清 activeFlows（不等 abort 异步链走完）——cancel 后立即重新 login 不被拒。
   * finally 的 delete 带身份守卫（Map 条目仍是本 controller 才删除），不误删新 flow 条目。
   */
  cancel(providerId: string): { cancelled: boolean } {
    const controller = this.activeFlows.get(providerId)
    if (!controller) return { cancelled: false }
    controller.abort()
    this.activeFlows.delete(providerId)
    return { cancelled: true }
  }

  /** 读 auth.json：该 provider 是否有 oauth 凭据（列表徽章 / OAuthDialog 已授权态） */
  async hasOAuth(providerId: string): Promise<boolean> {
    return this.deps.authStorage.hasOAuth(providerId)
  }

  /**
   * 退出登录（B-1 场景 C）：移除 auth.json 中该 provider 的凭证。
   * 先 cancel 进行中 flow（防 remove 后 flow 完成把新凭证写回）。幂等：无凭证时
   * authStorage.remove 本身 no-op（且不物化空 auth.json）。
   */
  async logout(providerId: string): Promise<void> {
    this.cancel(providerId)
    await this.deps.authStorage.remove(providerId)
  }

  /**
   * 读 auth.json 凭证（A1-4 读通道；Phase A2 的 QuotaService 凭证源将经此取
   * api_key.key / oauth.access）。直读不缓存——pi 侧 resolveStoredOAuth 刷新写回
   * auth.json 后必须能立即读到新值（D6：额度查询只读现值，不自行 refresh）。
   */
  async getCredential(providerId: string): Promise<Credential | undefined> {
    return this.deps.authStorage.get(providerId)
  }

  /**
   * 写 auth.json 凭证（A1-4 写收口）：全 runtime 对 authStorage.set 的直接调用只剩
   * 本方法（catalog apiKey 保存 / provider 导入 / legacy 迁移 / OAuth 登录全部经此）。
   * AuthStorage 的锁语义（@zhushanwen/pi-file-lock/core 统一 mkdir 锁 + 原子写 + 0600）不变，只是调用点收拢。
   */
  async saveCredential(providerId: string, credential: Credential): Promise<void> {
    await this.deps.authStorage.set(providerId, credential)
  }

  private async runFlow(providerId: string, config: BuiltinOAuthConfig, controller: AbortController): Promise<void> {
    const signal = controller.signal
    try {
      const credential = await runOAuthLogin(providerId, config, {
        onDeviceCode: (info) => this.broadcastAuth('auth.deviceCode', {
          providerId,
          userCode: info.userCode,
          verificationUri: info.verificationUri,
          verificationUriComplete: info.verificationUriComplete,
          expiresIn: info.expiresIn,
          interval: info.interval,
        }),
        onAuthUrl: (info) => this.broadcastAuth('auth.authUrl', {
          providerId,
          url: info.url,
          callbackPort: info.callbackPort,
        }),
      }, signal)
      // S-7（R3 review）：cancel 落在「token 获取完成 → 写盘」窗口时，不落盘、不广播——
      // cancel() 已返回 {cancelled:true}，迟到 success 会让前端状态机 cancelled/authorized 并存。
      // abort 检查只在 catch 块不够：token 正常返回不代表用户没取消。
      if (signal.aborted) return
      // token 写 auth.json（0600 + per-file mutex + 原子写），pi 侧 resolveStoredOAuth 自动 refresh
      await this.deps.authStorage.set(providerId, credential)
      // S-8（R4 review）：S-7 早退只挡 set() 之前的窗口——cancel 落在 set() 的锁等待期间
      // （统一 mkdir 锁，pi 侧 refresh 持锁时重试可达秒级）凭据已写盘，迟到的 auth.success
      // 仍会造成 cancelled/authorized 并存。broadcast 前再查一次 abort，且 best-effort 移除
      // 刚写入的凭据（用户已取消，不留盘）；失败仅 warn 不改变早退语义。
      if (signal.aborted) {
        try {
          await this.deps.authStorage.remove(providerId)
        } catch (error) {
          // best-effort 清理：凭据移除失败仅 warn，不改变早退语义（用户已取消，残留凭据不广播）
          console.warn(`[auth-service] remove cancelled OAuth credential failed for ${providerId}:`, error)
        }
        return
      }
      // I9 清理②：OAuth 授权成功 → 清 models.json apiKey（both provider 切换凭据源，防冲突）。
      // 清理是次要副作用：失败降级为警告日志，不改变 auth.success（凭据已写入，pi 侧可正常使用）。
      try {
        this.deps.clearApiKey(providerId)
      } catch (error) {
        // best-effort 降级（见上方 try 前注释）：apiKey 残留仅造成凭据源歧义风险，
        // 凭据已写入 auth.json，不改变 auth.success 语义
        console.warn(`[auth-service] clearApiKey failed for ${providerId} (models.json apiKey 残留):`, error)
      }
      // 第三道 abort 检查（M4 review）：第二道检查后至 broadcast 前的残余窗口
      // （当前 clearApiKey 是同步闭包窗口为 0，防御未来引入 await 后 cancel 到达）——
      // 迟到的 auth.success 会让前端状态机 cancelled/authorized 并存（S-7/S-8 同根因）。
      if (signal.aborted) return
      this.broadcastAuth('auth.success', { providerId })
    } catch (error) {
      if (signal.aborted) {
        // 用户取消：前端对话框已关闭，不发错误事件（cancel RPC 已确认）
        return
      }
      const message = error instanceof Error ? error.message : 'OAuth 授权失败'
      this.broadcastAuth('auth.error', { providerId, message })
    } finally {
      // ABA 防护（M4-01）：cancel() 同步 abort+delete 后用户立即 re-login（新 controller
      // 入 Map），旧 flow 的 abort 异步链走完后 finally 若无条件 delete 会删掉新 flow 的
      // 条目（用户无法取消新 flow / 可并发双流 / 迟到 success）。身份守卫：只有 Map 中
      // 仍是本 controller 时才删除。
      if (this.activeFlows.get(providerId) === controller) {
        this.activeFlows.delete(providerId)
      }
    }
  }

  private broadcastAuth<T extends AuthEventType>(type: T, payload: ServerMessageMap[T]): void {
    this.deps.broadcast({ type, id: this.deps.nextPushId(), payload })
  }
}
