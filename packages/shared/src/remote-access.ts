/**
 * 远程访问配置契约 SSOT：remote-access.json 的文件名与内容形态，
 * main（写入侧：生成/轮换 token、开关状态落盘）与 runtime（读取侧：每次
 * WS auth 握手热读 remote token 入鉴权集合）两端共用，禁止复制定义。
 *
 * 职责边界：本模块只声明契约（类型 + 文件名），不实现读写——
 * 落盘/热读逻辑归 main 配置面与 runtime 连接层各自实现。
 *
 * 纯类型/常量无 node 依赖，barrel 安全（renderer 可整包 import）。
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
