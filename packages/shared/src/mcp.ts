/**
 * mcp 域 WS 协议契约（runtime ↔ renderer 共享，接口先行）。
 *
 * 命令族 `mcp.list` / `mcp.add` / `mcp.update` / `mcp.setEnabled` / `mcp.remove` / `mcp.test`
 * / `mcp.testCancel`（pi-mcp-management 设计：设置页 MCP 分区经 runtime 唯一读写层管理
 * pi 1.0 用户级 mcp.json——文件层管理方案 A，写入生效语义 = 新会话生效，设计 D1）。
 * 本文件只承载 payload/reply 的类型定义，供两端共同
 * import 防止裁量漂移；消息类型字符串与 type→reply 映射登记在 shared protocol.ts
 *（ClientMessageType + ReplyPayloadMap），case 分发由 runtime transport 层 handler 登记。
 *
 * 形状锚点：
 * - 条目值对象 = pi 1.0.0 实装 McpServerConfig 的 taiji 协议投影：传输字段由 command/url 有无
 *   表达（设计 D7 映射表，不落 `type` 键为表单序列化语义）；表单外键穷举按 D7 外键清单
 *  （type/timeout/toolExposure/auth/oauth），读侧原样保留投影——清单以文件为准；
 * - 损坏错误态对齐 codemode 域 CodemodeSettingsCorruption / CodemodeEnabledResult 形态；
 * - 连接测试状态徽标 = 设计 D8 三类来源判别联合（每个状态可回答「值从哪来」，测试时刻快照
 *   而非运行中会话实时状态，范围 = 用户级文件）。
 *
 * 类型只承载协议形状，不含实现逻辑：读写互斥（D2 磁盘锁）、保存校验复刻（D4 三不变量 +
 * `type` 例外条款）、编辑写回契约（D7 外键保留 / type 剥离 / 键级清理）、连接测试通道
 *（D3 spawn `pi mcp list --json`）均归 runtime 侧实装。
 */

// oe-exempt:20261004:framework:WS 协议契约类型（runtime↔renderer 共享防裁量漂移），协议形状先行单实现常态

/**
 * 暴露档位（服务器工具到达模型的方式，设计 D6：默认 codemode）。
 * 值域 = pi 1.0.0 实装 McpExposure 原值闭集（codemode 档下工具不直接声明给模型，只供
 * codemode 脚本调用；deferred 经工具检索加载后直接调用；direct 直接声明给模型；hidden
 * 注册但不可达）。
 */
export type McpExposureLevel = 'codemode' | 'deferred' | 'direct' | 'hidden'

/**
 * mcp.json 条目值对象（`mcpServers` 键名下的对象本体，不含名称键——名称是聚合唯一键，
 * 协议面独立承载）。两族传输字段全部可选：文件里已存在的坏条目（command 与 url 均缺，
 * pi 报错跳过类）照原样保留投影并以 `configError` 标注（设计 D4，不阻塞其余条目管理）；
 * 写侧（add/update payload）的合法性由 runtime 保存校验 fail-fast 把关，类型不强约束
 *（command/url 同填的互斥拦截是运行时校验，D4 有意收紧项）。
 */
export interface McpServerEntryValue { // oe-exempt:20261004:framework:WS 协议契约类型（两端共同 import），协议形状先行单实现常态
  // ── stdio 传输字段（设计 D7：本地命令；command 为单个可执行文件，非 shell 语句）──
  command?: string
  args?: string[]
  /** 值支持 `${VAR}` 环境变量引用与 `!cmd` 命令引用（pi 实装语义） */
  env?: Record<string, string>
  /** 相对路径按 pi 语义解析（相对会话工作目录） */
  cwd?: string
  // ── http 传输字段（设计 D7：远程地址，streamable HTTP）──
  url?: string
  /** 值支持 `${VAR}` 与 `!command` 引用（pi 实装语义） */
  headers?: Record<string, string>
  // ── 共同可选键（设计 D7 映射表）──
  /** 一句话描述，进 pi 的 mcp_servers 系统提示词清单 */
  description?: string
  /** 启停（false = 保留条目但不连接）；缺省 = 启用 */
  enabled?: boolean
  /** 暴露档位；缺省 = codemode（设计 D6） */
  exposure?: McpExposureLevel
  // ── 表单外键（设计 D7 外键清单穷举 = pi 1.0.0 实装键集；本期不进表单，读侧原样保留、
  // 代码模式可粘贴；编辑写回契约 = runtime store 按 D7 裁决保留/剥离）──
  /**
   * 显式传输类型键。表单序列化不落该键（传输类型由 command/url 有无表达）；文件中已有的
   * 显式值原样投影。合法值闭集 = `"stdio"` / `"http"` / `"streamable-http"`（旧称，pi 实装
   * 照常接受，设计 D7 代码模式段）——类型不收窄为闭集：坏值条目须照文件投影并由
   * `configError` 标注，闭集校验归 runtime（D4 例外条款）。
   */
  type?: string
  /** 逐请求超时秒数（进度通知会重置计时；pi 实装默认 60） */
  timeout?: number
  /** 逐工具覆写档位（键 = 工具名或 `*` 通配模式）；工具级编辑本期后置（设计 I5） */
  toolExposure?: Record<string, McpExposureLevel>
  /** 改发 pi provider 令牌而非 OAuth（pi 实装约束：仅 https/回环地址可用） */
  auth?: { provider: string }
  /** OAuth 预注册参数段（本期整体走手编文件 + 终端登录引导，设计 I3/D7） */
  oauth?: McpOauthConfig
}

/**
 * OAuth 预注册参数（pi 1.0.0 实装 McpOAuthConfig 键集 7 键，全部可选——无预注册参数时
 * pi 动态客户端注册）。
 */
export interface McpOauthConfig { // oe-exempt:20261004:framework:WS 协议契约类型（两端共同 import），协议形状先行单实现常态
  clientId?: string
  /** 值支持 `${VAR}` 与 `!cmd` 引用（pi 实装语义） */
  clientSecret?: string
  callbackPort?: number
  callbackUrl?: string
  /** 空格分隔的 scope 列表；缺省 = 服务器广告值 */
  scope?: string
  /** 动态客户端注册携带的 client_name；缺省 = pi */
  clientName?: string
  authServerMetadataUrl?: string
}

/**
 * 清单条目（`mcp.list` reply 的服务器投影）：名称 + 条目值对象 + 校验错误标注。
 * 坏条目形态 = `configError` 非空（「配置有误」+ 错误摘要，设计 D8③ 读侧复刻校验探明），
 * 条目本体照文件原样保留，不阻塞其余条目管理（设计 D4）。
 */
export interface McpServerEntry { // oe-exempt:20261004:framework:WS 协议契约类型（两端共同 import），协议形状先行单实现常态
  /** 服务器名（聚合唯一键；合法字符集与 `-`/`_` 归并同名规则由 runtime 校验执行） */
  name: string
  value: McpServerEntryValue
  /** 非空 = 该条目配置有误，值为错误摘要（读侧标注；合法条目缺省） */
  configError?: string
}

/**
 * mcp.json 损坏错误态形状（对齐 codemode 域 CodemodeSettingsCorruption）：①原路径存在但
 * JSON 非法；②原路径已被自动隔离为 `.corrupt-<时间戳>` 副本。字段即损坏提示渲染所需：
 * 完整路径（用户定位与修复入口）+ 隔离副本提示。损坏期间写侧拒入（fail-fast，设计 D2/S6
 *——不覆盖外部手编内容），用户修复文件后重试即恢复。
 */
export interface McpConfigCorruption { // oe-exempt:20261004:framework:WS 协议契约类型（两端共同 import），协议形状先行单实现常态
  /** mcp.json 完整路径（用户定位与修复入口） */
  filePath: string
  /** 已被自动隔离时的副本路径（原内容可从此找回）；未被隔离 = null */
  corruptCopyPath: string | null
}

/** `mcp.list` 请求（无参数；打开分区时拉取一次，§3.1 拉取一次模型）。 */
export type McpListRequest = Record<string, never>

/**
 * `mcp.list` reply：清单 + 损坏错误态（codemode CodemodeEnabledResult 同款两态）。
 * 文件不存在 = 空数组 + corruption null（与「文件存在但无条目」同形态，§3.1）；损坏 =
 * servers 空数组 + corruption 有值（渲染损坏提示与文件路径而非空白，S6）。
 */
export interface McpListResult { // oe-exempt:20261004:framework:WS 协议契约类型（两端共同 import），协议形状先行单实现常态
  servers: McpServerEntry[]
  corruption: McpConfigCorruption | null
  /**
   * pi agent 目录绝对路径（`<数据目录>/agent/`，getPiAgentDir SSOT）：needs-auth 条目的
   * I3 登录引导数据源——界面拼装完整可复制登录命令 `PI_CODING_AGENT_DIR=<agentDir>
   * pi mcp login <name>`（路径由界面填实际值；缺环境变量指引时凭据会写到 `~/.pi/agent`
   * 成为会话读不到的孤岛，复刻 F1）。
   */
  agentDir: string
}

/**
 * `mcp.add` 请求：名称 + 条目对象（传输字段与可选键见 McpServerEntryValue；保存校验与
 * 重名拦截归 runtime——重名报「已存在同名服务器，请编辑该条目」，不采用替换语义，D4）。
 */
export interface McpAddRequest { // oe-exempt:20261004:framework:WS 协议契约类型（两端共同 import），协议形状先行单实现常态
  name: string
  entry: McpServerEntryValue
}

/**
 * `mcp.update` 请求：名称定位既有条目（编辑态名称锁定——名称是聚合唯一键，改名 = 删除后
 * 重建，§3.1/D7）；条目对象按编辑写回契约合并进既有条目（表单外键原样保留、清空即删键、
 * type 键剥离、切换传输类型键级清理——全部归 runtime store 执行，D7）。
 */
export interface McpUpdateRequest { // oe-exempt:20261004:framework:WS 协议契约类型（两端共同 import），协议形状先行单实现常态
  name: string
  entry: McpServerEntryValue
}

/** `mcp.remove` 请求：待删除条目名。 */
export interface McpRemoveRequest { // oe-exempt:20261004:framework:WS 协议契约类型（两端共同 import），协议形状先行单实现常态
  name: string
}

/**
 * `mcp.setEnabled` 请求：目标条目名与目标启停态（§3.1「可启停（写入 enabled 字段）」最小
 * 语义的专用操作——runtime store 锁内仅翻转 enabled 键、其余键一律不触，不带清单投影
 * 回写，D2 丢失窗口保持锁内亚秒级）。
 */
export interface McpSetEnabledRequest { // oe-exempt:20261004:framework:WS 协议契约类型（两端共同 import），协议形状先行单实现常态
  name: string
  enabled: boolean
}

/**
 * add/update/remove 共用两态信封（同 CodemodeSetEnabledResult 判别式风格）：成功 = 写后
 * 落盘终态条目（renderer 以服务端终态校准清单，生效语义 = 新会话读取，D1）；失败 = 拒绝
 * 原因（保存校验不过 / 重名 / 损坏拒入——fail-fast 不落坏数据，D4/S6），corruption 仅
 * 损坏拒入时携带（「先修复文件」指引的数据源）。
 */
export type McpMutationResult = // oe-exempt:20261004:framework:WS 协议契约类型（两端共同 import），协议形状先行单实现常态
  | {
      ok: true
      entry: McpServerEntry
    }
  | {
      ok: false
      error: string
      corruption?: McpConfigCorruption
    }

/**
 * `mcp.test` 请求：目标条目名。连接测试通道（D3）按全量执行——`pi mcp list --json` 不接受
 * 单服务器参数，name 承载触发行参照，结果投影口径归 runtime 实装。
 */
export interface McpTestRequest { // oe-exempt:20261004:framework:WS 协议契约类型（两端共同 import），协议形状先行单实现常态
  name: string
}

/**
 * `mcp.test` reply：异步任务句柄（设计 D3/前提 A4：连接测试以异步任务呈现，真实连接耗时
 * 秒级以上，不占单个 request/reply 往返；D3 超时语义 = 整体无本次结果并保留上次成功结果）。
 * testId 供 UI 关联「测试中」过程态；终态经 `mcp:testResult` 广播帧回收（下方 McpTestResultEvent）。
 */
export interface McpTestHandle { // oe-exempt:20261004:framework:WS 协议契约类型（两端共同 import），协议形状先行单实现常态
  testId: string
}

/** `mcp.testCancel` 请求：待取消的连接测试任务句柄 id（D3「取消」按钮——等价于超时到点杀进程的主动形态）。 */
export interface McpTestCancelRequest { // oe-exempt:20261004:framework:WS 协议契约类型（两端共同 import），协议形状先行单实现常态
  testId: string
}

/**
 * `mcp.testCancel` reply：cancelled true = 取消生效（probe 被杀、以 cancelled 终态收敛，
 * 不再回填徽标——renderer 恢复取消前徽标，本次无结果语义与 D3 超时同源）；false = 任务
 * 已结束（含取消晚到窗口），结果徽标经 `mcp:testResult` 广播照常回填，renderer 不动。
 */
export interface McpTestCancelResult { // oe-exempt:20261004:framework:WS 协议契约类型（两端共同 import），协议形状先行单实现常态
  cancelled: boolean
}

/**
 * `mcp:testResult` 广播 payload（server→client 推送帧，probe 终态回填——`mcp.test` 异步
 * 任务句柄的完成侧通道，设计 D8① pi 实测类徽标的数据源；u5b 打回修复接线）。测试发起连接
 * 的分区未打开时广播结果自然丢失（徽标是 UI 本地态，D8②「本次界面会话未跑过测试」语义，
 * 重开分区回落「未测试」为既定形态，非缺陷）。
 */
export interface McpTestResultEvent { // oe-exempt:20261004:framework:WS 协议契约类型（两端共同 import），协议形状先行单实现常态
  /** 本帧结果对应的条目名：probe ok = 全清单回填逐条目各发一帧（§3.1，CLI 全量测试一次得全部结果）；整体降级帧 = 触发条目名 */
  name: string
  /** 任务句柄 id（`mcp.test` reply 的 testId 回显，供 UI 关联「测试中」过程态） */
  testId: string
  /**
   * 终态徽标：probe 全量成功 = D8① pi 实测类（state/toolCount/errorDetail/testedAt）；
   * probe 整体降级（超时/spawn 失败/输出非法）= 该条目 failed 徽标或 ui-local timeout 徽标
   *（D3 超时语义：整体无本次结果，renderer 保留上次成功结果展示）。
   */
  badge: McpServerStatusBadge
}

/**
 * pi 实测 state 原值闭集（设计 D8①）：pi 1.0.0 ServerState 枚举（connecting/connected/
 * disconnected/needs-auth/failed/closed）+ 连接测试报告的 disabled（条目 enabled=false）。
 * UI 文案映射（已连接（N 个工具）/ 连接失败 / 需要登录 / 已停用）归 renderer。
 */
export type McpProbeState =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'needs-auth'
  | 'failed'
  | 'closed'
  | 'disabled'

/**
 * 连接测试状态徽标（设计 D8 三类来源判别联合——每个徽标都能回答「值从哪来」；状态是测试
 * 时刻的快照而非运行中会话的实时状态，徽标与清单反映用户级文件）。config 变体的摘要与
 * McpServerEntry.configError 同源。
 */
export type McpServerStatusBadge = // oe-exempt:20261004:framework:WS 协议契约类型（两端共同 import），协议形状先行单实现常态
  | {
      /** pi 实测：真实连接测试返回的 state（D8①） */
      source: 'probe'
      state: McpProbeState
      /** 已连接时的工具数（「已连接（N 个工具）」） */
      toolCount?: number
      /** 连接失败完整错误详情（连接测试结果自身的 error 字段全文，含 stderr 尾部——详情入口展开该全文；D8①） */
      errorDetail?: string
      /** 测试完成时刻（epoch ms；D3 超时语义保留上次成功结果并标注其时间戳） */
      testedAt: number
    }
  | {
      /** UI 本地过程态：界面自有状态，不经 pi（D8②） */
      source: 'ui-local'
      /** 未测试（本次界面会话未跑过测试）/ 测试中 / 测试超时（D3：整体无本次结果，保留上次结果） */
      state: 'untested' | 'testing' | 'timeout'
    }
  | {
      /** 配置校验：taiji 读侧复刻校验探明（D8③） */
      source: 'config'
      /** 配置有误的错误摘要 */
      errorSummary: string
    }
