/**
 * MCP 服务器管理域 port —— pi 用户级 mcp.json 的结构化读写 + 连接测试触发
 *（pi-mcp-management 设计，方案 A 文件层管理）。
 *
 * 🔒 三层架构（同 ICodemodeSettings 分层理由）：services 定义 port，infra 实现组合
 * pi-mcp-store（唯一写入入口，D2 磁盘锁 + 校验复刻 D4 + 编辑写回契约 D7）与
 * pi-mcp-probe（连接测试通道 D3）。ConfigService 与 transport handler 不直接触碰
 * 存储与探针（A1 判定入口唯一）。
 *
 * 返回形状与 shared WS 协议类型直接对齐（pi-mcp-management §3）：list 回 McpListResult
 *（清单 + 损坏错误态两态，S6 渲染数据源），写操作回 McpMutationResult 两态信封——
 * 损坏拒入与校验失败不走 throw / error envelope（协议定死错误数据在信封内：
 * error 含「错误 → 原因 → 修复动作」结构文案，corruption 仅损坏拒入携带），renderer
 * 据信封字段渲染内联错误（D4 失败样例）。
 *
 * 清单语义（§3.1 + ADR-0075）：读以文件为准，打开时拉取一次；本 port 无缓存无推送
 *（pi 无状态推送通道，外部改动重开分区后可见），清单变更的可见性由 renderer 以
 * reply 终态校准承担。
 */

import type {
  McpListResult,
  McpMutationResult,
  McpServerEntryValue,
  McpTestHandle,
} from '@taiji/shared'

export interface IMcpServers { // oe-exempt:20261004:framework:services 出站端口契约（transport→services 跨层，PiMcpServers 唯一实现）
  /**
   * 读清单：现读文件（无缓存）。文件不存在 = 空清单 + corruption null（与「文件存在但
   * 无条目」同形态，§3.1）；文件损坏（非法 JSON）= servers 空数组 + corruption 有值
   *（filePath 用户定位与修复入口，S6 fail-fast 读侧错误态）；既有坏条目照原样保留投影
   * 并以 configError 标注（D4，不阻塞其余条目管理）。agentDir = pi agent 目录绝对路径
   *（I3 登录引导数据源：needs-auth 条目的可复制登录命令 PI_CODING_AGENT_DIR 值）。
   */
  list(): McpListResult
  /**
   * 添加条目：进写入前先查损坏——损坏拒入（ok:false 信封 + corruption，S6 不覆盖外部
   * 手编内容）；校验按 D4（三不变量 + 名称字符集与 `-`/`_` 归并同名 + command/url 互斥
   * 有意收紧 + 重名拦截报「已存在同名服务器，请编辑该条目」不采用替换语义 + type 三值
   * 闭集例外条款），不过即 ok:false 信封；成功 ok:true，entry = 写后落盘终态条目。
   */
  add(name: string, entry: McpServerEntryValue): McpMutationResult
  /**
   * 编辑条目（名称定位既有条目，编辑态名称锁定——改名 = 删除后重建，不做原地改名）：
   * 按编辑写回契约（D7 写死）合并落盘——表单外键（timeout/toolExposure/auth/oauth）原样
   * 保留禁全量替换、type 键无条件剥离、切换传输类型键级清理、清空即删键——请求 entry
   * ≠ 落盘终态（ADR-0065 分支一实态，reply 携带合并后生效值）。条目不存在 = ok:false
   * 信封（修复动作指向清单刷新）；损坏拒入同 add。
   */
  update(name: string, entry: McpServerEntryValue): McpMutationResult
  /**
   * 启停切换专用操作（§3.1「可启停（写入 enabled 字段）」最小语义）：store 锁内仅翻转
   * enabled 键、其余键一律不触——不带清单投影回写，外部并发改动的丢失窗口保持 D2 声明
   * 的锁内亚秒级。成功 ok:true，entry = 写后落盘终态条目（renderer 以服务端终态校准
   * 清单）；条目不存在 / 损坏拒入 / 坏条目（非对象）= ok:false 信封。
   */
  setEnabled(name: string, enabled: boolean): McpMutationResult
  /**
   * 删除条目：成功 ok:true，entry = 被删条目的删除前落盘值（回显「删掉的是这个」；
   * renderer 消费侧按 ok 分支从清单移除该 name，不渲染 entry 本体）。条目不存在 /
   * 损坏拒入 = ok:false 信封。
   */
  remove(name: string): McpMutationResult
  /**
   * 触发连接测试（D3 异步任务形态，前提 A4）：立即返回任务句柄（testId 由实现生成），
   * 真实连接测试（spawn `pi mcp list --json`，秒级以上）在后台执行，不占单个
   * request/reply 往返。测试结果的回收通道（推送帧或拉取扩展）由装配层（u2b）与
   * renderer 域契约（u3）实施期登记，本 port 只承载触发与句柄。
   */
  test(name: string): McpTestHandle
  /**
   * 取消进行中的连接测试（D3「取消」按钮——等价于超时到点杀进程的主动形态）：按 testId
   * 杀 probe 子进程。返回 true = 取消生效（probe 以 cancelled 终态收敛，不回填徽标）；
   * false = 该 testId 无进行中的任务或进程已自行退出（结果徽标照常经 mcp:testResult
   * 广播回填）。
   */
  testCancel(testId: string): boolean
}
