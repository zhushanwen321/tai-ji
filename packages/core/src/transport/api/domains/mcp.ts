/**
 * MCP 域 —— 设置页 MCP 分区对 pi 用户级 mcp.json 的管理面（pi-mcp-management 设计）。
 *
 * 五操作：list（清单 + 损坏错误态，打开分区拉取一次，§3.1）/ add / update（编辑写回契约
 * D7 归 runtime store：表单外键原样保留、清空即删键、`type` 键剥离、切换传输类型键级清理）/
 * remove / test（连接测试异步任务句柄，D3）。写入生效语义 = 新会话生效（D1）。
 *
 * 组织方式对齐 settings.ts codemode 段先例：reply 类型直接 import shared ./mcp 具名类型
 *（消息类型字符串与 type→payload 映射登记在 shared protocol.ts，payload/reply 形状 SSOT 在
 * shared mcp.ts；case 分发由 runtime transport 层 handler 登记——u2a/u2b）。保存校验复刻
 *（D4 三不变量 + `type` 例外条款）与重名拦截归 runtime，本域只做类型化转发。
 */
import { command } from '../request'
import { RPC_BACKSTOP_TIMEOUT_MS } from '../pending'
import type {
  McpAddRequest,
  McpListResult,
  McpMutationResult,
  McpRemoveRequest,
  McpTestHandle,
  McpTestRequest,
  McpUpdateRequest,
} from '@taiji/shared'

/** 拉取 MCP 服务器清单（corruption 非空 = mcp.json 损坏错误态，servers 恒空数组，S6）。 */
export async function listMcpServers(): Promise<McpListResult> {
  return command('mcp.list', {}, RPC_BACKSTOP_TIMEOUT_MS)
}

/** 添加服务器（重名拦截报「已存在同名服务器，请编辑该条目」，不采用替换语义，D4；损坏拒入走 ok:false 信封不 reject）。 */
export async function addMcpServer(req: McpAddRequest): Promise<McpMutationResult> {
  return command('mcp.add', req, RPC_BACKSTOP_TIMEOUT_MS)
}

/**
 * 更新服务器（name 定位既有条目——编辑态名称锁定，改名 = 删除后重建，§3.1/D7；条目对象按
 * 编辑写回契约合并进既有条目，归 runtime store 执行）。
 */
export async function updateMcpServer(req: McpUpdateRequest): Promise<McpMutationResult> {
  return command('mcp.update', req, RPC_BACKSTOP_TIMEOUT_MS)
}

/** 删除服务器（界面侧删除确认归 renderer，D8 清单行操作）。 */
export async function removeMcpServer(req: McpRemoveRequest): Promise<McpMutationResult> {
  return command('mcp.remove', req, RPC_BACKSTOP_TIMEOUT_MS)
}

/**
 * 发起连接测试（异步任务句柄，D3/前提 A4：真实连接耗时秒级以上，不占单个 request/reply
 * 往返）。probe 终态徽标（D8① pi 实测类）的回填通道由 runtime 侧实施期登记——renderer 侧
 * 接缝为 McpSection 的 applyProbeResult（徽标渲染与通道解耦）。
 */
export async function testMcpServer(req: McpTestRequest): Promise<McpTestHandle> {
  return command('mcp.test', req, RPC_BACKSTOP_TIMEOUT_MS)
}
