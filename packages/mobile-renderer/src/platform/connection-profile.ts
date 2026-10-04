// connection-profile —— 移动壳连接凭据派生（remote-use D4 三分支，纯逻辑可单测）。
//
// 职责：经 U0.2 收口点（use-connection 远程 profile 分支）注入的 ConnectionProfilePort 实现
// + auth 结果的凭据处置。三分支（D4）：
//   1. URL query ?token= 优先（显式携带的新凭据 = 用户新意图；轮换重扫恢复路径）——内存持有
//      用于首连，auth 成功才落 storage + 抹地址栏（replaceState）；失败**不动**既有 storage
//      （坏链接不毁好凭据），地址栏 query 刻意保留（刷新重试入口，D4 显式判定）
//   2. storage 兜底（验身过的持久凭据，G3 免重扫）——auth 失败才清空（已失效，E11）
//   3. 皆无 → 不携带凭据发起连接（runtime fail-closed 拒绝 → onAuthRejected → token 输入
//      视图，E2 同一通路闭合，免 throw 协议穿 core——凭据缺失与其他验身失败同视图同出口）
//
// core 零 location/storage 直读（headless 约束），宿主环境经 deps 注入；本模块是壳侧注入实现。

import type { ConnectionProfilePort, KVStorage, ResolvedConnectionProfile } from '@taiji/core'

/** remote token 在 storage 的持久 key（验身成功才写入，G3 免重扫；登记 = data-source-registry 主表 #54） */
export const REMOTE_TOKEN_STORAGE_KEY = 'taiji.remote-access.token'

/** 凭据来源：URL query / storage / 手输（token 输入视图提交；语义同 query——验身成功落盘 + 抹地址栏） */
export type CredentialSource = 'query' | 'storage' | 'manual'

/** 已采纳待验身的凭据（内存持有；落盘只发生在 auth 成功处置，坏凭据不顶掉好 storage） */
export interface PendingCredential {
  token: string
  source: CredentialSource
}

export type CredentialAdoption =
  | { action: 'adopt'; credential: PendingCredential }
  | { action: 'need-input' }

/**
 * token 三分支裁决（D4 纯函数）：query 优先 → storage → 皆无 need-input。
 * 空串等同缺失（URLSearchParams 有 key 无值 / 空值形态）。
 */
export function resolveCredential(
  queryToken: string | null,
  storedToken: string | null,
): CredentialAdoption {
  if (queryToken !== null && queryToken !== '') {
    return { action: 'adopt', credential: { token: queryToken, source: 'query' } }
  }
  if (storedToken !== null && storedToken !== '') {
    return { action: 'adopt', credential: { token: storedToken, source: 'storage' } }
  }
  return { action: 'need-input' }
}

/** 从 location.search 原文（形如 '?token=xxx&a=b'）提取 query token；缺失返回 null。 */
export function readQueryToken(search: string): string | null {
  return new URLSearchParams(search).get('token')
}

/**
 * 同源 WS URL 派生（D4：WS URL = <ws|wss>://<location.host>，页面同源托管）。
 * scheme 按页面协议派生（location.protocol 由 deps 注入，本模块零 location 直读）：
 * http: → ws://，其余（https: 及未知协议）→ wss://——https 页面下发 ws 会被浏览器
 * 混合内容（mixed content）拦截，未知协议按安全侧缺省。
 */
export function wsUrlFromHost(host: string, protocol: string): string {
  return `${protocol === 'http:' ? 'ws' : 'wss'}://${host}`
}

export interface ConnectionProfileDeps {
  /** PlatformPort.storage（凭据持久化；bootstrap 注入 adapter.storage） */
  storage: KVStorage
  /** location.host（WS 同源派生） */
  host: string
  /** location.protocol（WS scheme 派生：http: → ws，其余 → wss） */
  protocol: string
  /** location.search 原文（query token 摄取） */
  search: string
  /** 抹地址栏 query（D4：query/manual 验身成功后调用；实现 = history.replaceState 剥 query） */
  stripQuery(): void
  /** 落 token 输入视图的通知（验身失败 / 皆无凭据被拒后；移动壳 UI 态切换） */
  onTokenInputRequired(): void
}

/** auth 结果处置 + 手输采纳（bootstrap 接线面；TokenInputView 提交路径用 adoptManualToken） */
export interface ConnectionCredentialController {
  /**
   * auth 成功（ws-client connected）处置：query/manual 来源落 storage + 抹地址栏（manual
   * 同抹——手输前地址栏可能残留旧 ?token=，不抹则刷新/同会话再 resolve 时旧值压过已落盘
   * 新凭据成循环；stripQuery 抛错降级 warn 不上抛，storage 已落盘即自愈）。storage 来源
   * 幂等（已在盘上）。无待定凭据（普通重连）no-op。
   */
  handleAuthSuccess(): Promise<void>
  /**
   * auth 失败（onAuthRejected）处置：storage 来源清空（E11 已失效）；query/manual 来源不动
   * 既有 storage（D4：坏链接不毁好凭据，重开无 query 首页免重扫恢复）。均通知落 token 输入视图。
   */
  handleAuthFailure(): Promise<void>
  /** 手输 token 采纳（token 重试路径：adoptManualToken → 抑制位 reset → 重走连接编排） */
  adoptManualToken(token: string): void
}

export function createConnectionProfilePort(
  deps: ConnectionProfileDeps,
): ConnectionProfilePort & ConnectionCredentialController {
  let pending: PendingCredential | null = null
  // 本页会话内已验身消费的 query 值：deps.search 是 bootstrap 时刻的字符串快照，
  // replaceState 抹地址栏不会回写快照——不消歧则后续 resolve（token 重试 / HMR 重连再走
  // connectRemoteProfile）会从旧快照重复采纳已处置的 query 值，压过已落盘的新凭据。
  let consumedQueryToken: string | null = null

  // stripQuery 安全包装（query/manual 验身成功共用）：实装 = history.replaceState（bootstrap
  // 注入），受限环境会抛——storage 此刻已落盘，下次刷新走 storage 分支即自愈，失败只 warn
  // 不上抛（connection-view 对 handleAuthSuccess 是 void 调用，直抛 = unhandled rejection）。
  // 消费消歧与 replaceState 成败无关（验身落盘即消费），先记后抹。
  const stripAddressBarQuery = (): void => {
    consumedQueryToken = readQueryToken(deps.search)
    try {
      deps.stripQuery()
    } catch (e) {
      // 降级策略（best-effort 抹地址栏）：受限环境 replaceState 抛错不向上传播——storage
      // 已落盘，下次刷新走 storage 分支即自愈；warn 留排障依据（connection-view 对
      // handleAuthSuccess 是 void 调用，直抛 = unhandled rejection）。
      console.warn('[connection-profile] stripQuery failed, address bar keeps old query:', e)
    }
  }

  return {
    async resolve(): Promise<ResolvedConnectionProfile> {
      // 手输采纳优先（token 重试路径的显式新意图，晚于页面加载发生，压过 query/storage）
      if (pending?.source === 'manual') {
        return { url: wsUrlFromHost(deps.host, deps.protocol), token: pending.token }
      }
      const queryToken = readQueryToken(deps.search)
      const storedToken = await deps.storage.get(REMOTE_TOKEN_STORAGE_KEY)
      // 已消费的 query 值不再采纳（见 consumedQueryToken）：归 null 后走 storage / need-input
      const adoption = resolveCredential(
        queryToken === consumedQueryToken ? null : queryToken,
        storedToken,
      )
      if (adoption.action === 'adopt') {
        pending = adoption.credential
        return { url: wsUrlFromHost(deps.host, deps.protocol), token: pending.token }
      }
      // 皆无：不带凭据发起（E2 通路——runtime fail-closed 拒绝 → onAuthRejected →
      // handleAuthFailure → onTokenInputRequired）。不在此直接切视图：凭据缺失与其他验身
      // 失败同出口，连接发起面保持无异常路径。
      return { url: wsUrlFromHost(deps.host, deps.protocol) }
    },

    async handleAuthSuccess(): Promise<void> {
      if (pending && (pending.source === 'query' || pending.source === 'manual')) {
        await deps.storage.set(REMOTE_TOKEN_STORAGE_KEY, pending.token)
        // query 与 manual 都抹地址栏：manual 漏抹是历史缺陷——手输成功后地址栏残留旧
        // ?token=，刷新时 query 优先级压过已落盘新凭据，坏旧值反复被采纳形成循环
        stripAddressBarQuery()
      }
      pending = null
    },

    async handleAuthFailure(): Promise<void> {
      // D4 来源分支：storage 来源失败 = 凭据已失效 → 清空（E11）；query/manual 来源失败不动
      // 既有 storage（坏链接不毁好凭据——storage 里可能是仍有效的好凭据）。地址栏 query
      // 刻意保留（刷新重试入口，D4 显式判定）。
      if (pending?.source === 'storage') {
        await deps.storage.remove(REMOTE_TOKEN_STORAGE_KEY)
      }
      pending = null
      deps.onTokenInputRequired()
    },

    adoptManualToken(token: string): void {
      pending = { token, source: 'manual' }
    },
  }
}
