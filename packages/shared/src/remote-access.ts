/**
 * 远程访问配置契约 SSOT：remote-access.json 的文件名与内容形态，
 * main（写入侧：生成/轮换 token、开关状态落盘）与 runtime（读取侧：每次
 * WS auth 握手热读 remote token 入鉴权集合）两端共用，禁止复制定义。
 *
 * 另承载 remote-access IPC 信封类型（RemoteAccessInfo /
 * RemoteAccessToggleResult）：main bridge（产出侧）/ preload / renderer
 * （消费侧）三端共同 import——信封扩展字段（urls / mobileDistReady /
 * restarted）的形状声明曾三处内联且一处异名，形状分叉会造成「main 产出、
 * renderer 读缺字段」的静默断裂，故上收至此，禁止本地重抄。
 *
 * 职责边界：本模块只声明契约（类型 + 文件名 + 无策略 shape 谓词），不实现读写与
 * 严格度策略——落盘/热读逻辑归 main 配置面与 runtime 连接层各自实现，严格度差异
 * （写侧从严重建 vs 读侧 fail-closed 条件校验）也归两侧各自的策略层，不上收、
 * 不参数化 strict/loose（双侧不对称是文档化的刻意设计）。
 *
 * 纯类型/常量/纯函数无 node 依赖，barrel 安全（renderer 可整包 import）。
 */

/**
 * remote-access.json 文件名。落位与安全语义：
 * - 位于数据目录根（路径由 `@taiji/shared/paths` 的 getDataDir() 推导，
 *   禁止硬编码）；
 * - 权限 0600（与 dataDir 内其他凭据文件同级）；
 * - main 原子写（同目录 `.tmp` 文件 + renameSync，防热读撕裂），
 *   runtime 每次 WS auth 握手热读——token 轮换 = main 重写文件即生效，
 *   无需重启 runtime。
 */
export const REMOTE_ACCESS_FILENAME = 'remote-access.json'

/**
 * remote-access.json 内容形态。
 */
export interface RemoteAccessConfig {
  /** 是否开启远程访问（关态时文件留存，再开启复活原 token） */
  enabled: boolean
  /**
   * remote token：64 位 hex 小写字符串。
   * 生成方式 = 32 字节随机值经 hex 编码（main 侧生成）。
   */
  token: string
  /** 创建时间，ISO 8601 格式字符串 */
  createdAt: string
}

/**
 * remote token 契约形态判据：64 位 hex 小写（32 字节随机值的 hex 编码）。
 * main 写侧守卫（isValidRemoteAccessConfig，从严校验）与 runtime 读侧
 * （parseRemoteAccessToken 的 token 分支）import 同一正则——判据分叉会造成
 * 「写侧放行、读侧拒绝」的静默通道失效，故 SSOT 上收至此，禁止本地重抄。
 */
export const REMOTE_TOKEN_HEX64 = /^[0-9a-f]{64}$/

/**
 * remote-access.json 内容的无策略 shape 谓词：value 是对象 && enabled 是 boolean
 * && token 是 string，仅此三条。不含 hex / createdAt 判定——那是严格度策略，
 * 归两侧策略层（main 写侧守卫从严恒校验 hex+createdAt；runtime 读侧 enabled=false
 * 早退跳过 hex、fail-closed）。
 *
 * main（isValidRemoteAccessConfig）与 runtime（parseRemoteAccessToken）import 同一
 * 谓词作为 shape 判据单源——判据分叉会造成「写侧放行、读侧拒绝」的静默通道失效
 * （与 REMOTE_TOKEN_HEX64 上收同理），禁止两侧本地重抄。类型收窄刻意只到
 * Pick<enabled|token>（谓词验证过的字段），未验证的 createdAt 留给调用方守卫。
 */
export function isRemoteAccessConfigShape(value: unknown): value is Pick<RemoteAccessConfig, 'enabled' | 'token'> {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.enabled === 'boolean' && typeof record.token === 'string'
}

/**
 * remote-access 连接信息（get-remote-access-info / rotate-remote-access-token
 * IPC 返回形态）：配置字段 extends 契约 SSOT RemoteAccessConfig（零复制）+
 * main bridge 侧实时探测的信封扩展字段。
 */
export interface RemoteAccessInfo extends RemoteAccessConfig {
  /** LAN 直连候选（`http://<ip>:<port>`，不含 token；runtime 未启动为空数组） */
  urls: string[]
  /** 移动壳 dist 产物就绪（bridge 读时点测；false = E5 静态面禁用，面板显形警告） */
  mobileDistReady: boolean
}

/**
 * set-remote-access-enabled IPC 返回形态：连接信息 + 本次切换是否触发了
 * runtime 重启（runtime 未跑时仅落盘，restarted=false）。
 */
export interface RemoteAccessToggleResult extends RemoteAccessInfo {
  restarted: boolean
}
