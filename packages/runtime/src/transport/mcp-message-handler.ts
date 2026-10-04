/**
 * MCP 服务器管理域 message handler（mcp.list / mcp.add / mcp.update / mcp.setEnabled /
 * mcp.remove / mcp.test / mcp.testCancel，7 条 case）。
 *
 * pi-mcp-management 设计的 runtime 端（先例：codemode-message-handler.ts 同款
 * class + handle() switch 形态）。错误语义与 retry 不同（shared mcp.ts 协议定死）：
 * 损坏拒入与校验失败的数据（error + corruption）在 reply 两态信封内返回而非 error
 * envelope——renderer 的内联错误渲染（D4「错误 → 原因 → 修复动作」）与损坏提示
 *（S6 路径 + 隔离副本提示）直接消费信封字段。
 *
 * 清单变更无广播帧：§3.1 打开时拉取一次 + D8 快照语义（ADR-0097 拉为主），清单变更的
 * 可见性由 renderer 以 reply 终态校准承担，与 codemode 先例的「set 成功不广播」同构。
 * 唯一例外 = 连接测试终态经 mcp:testResult 广播帧回填（probe 完成侧推送帧，允许丢失
 * ——分区未打开时自然丢失，重开分区回落「未测试」，D8② 既定形态）。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage } from '@taiji/shared'
import type { MessageHandlerContext } from './message-context.js'
import type { McpServersService } from '../services/mcp-servers-service.js'

/** 本域 handler 所需的最小 ctx 契约（结构兼容：组合根的 SettingsHandlerContext 注入
 * mcpServersService 后即满足，u2b 装配）。 */
export interface McpHandlerContext extends MessageHandlerContext { // oe-exempt:20261004:framework:handler 注入缝上下文（组合根装配的最小 ctx 协议面）
  mcpServersService: McpServersService
}

export class McpMessageHandler {
  constructor(private ctx: McpHandlerContext) {}

  /** 处理 mcp 管理域消息；不匹配返回 false（由 SettingsMessageHandler 继续路由）。 */
  async handle(msg: ClientMessage, ws: WsType): Promise<boolean> {
    switch (msg.type) {
      case 'mcp.list': {
        // 清单读（§3.1 打开时拉取一次）：读以文件为准——损坏 → servers 空 + corruption
        // 有值（S6 损坏提示渲染数据源），文件不存在 = 空清单同形态；坏条目照原样投影
        // 带 configError 标注（D4）。
        const result = this.ctx.mcpServersService.list()
        this.ctx.reply(ws, msg.id, 'mcp.list:result', result)
        return true
      }
      case 'mcp.add': {
        // 添加（D4 保存校验 + S6 损坏拒入）：拒入走 ok:false 信封（error 含修复动作 +
        // corruption 仅损坏拒入携带），不 sendError；成功 reply 写后落盘终态条目。
        const { name, entry } = msg.payload
        const result = this.ctx.mcpServersService.add(name, entry)
        this.ctx.reply(ws, msg.id, 'mcp.add:result', result)
        return true
      }
      case 'mcp.update': {
        // 编辑（名称锁定 + D7 编辑写回契约归 store）：reply entry = 合并后落盘终态
        //（请求 entry 经外键保留 / type 剥离 / 键级清理变换，ADR-0065 分支一生效值）。
        const { name, entry } = msg.payload
        const result = this.ctx.mcpServersService.update(name, entry)
        this.ctx.reply(ws, msg.id, 'mcp.update:result', result)
        return true
      }
      case 'mcp.setEnabled': {
        // 启停（§3.1「写入 enabled 字段」最小语义）：专用操作仅翻转 enabled 键、不带
        // 清单投影回写（D2 丢失窗口保持锁内亚秒级），reply entry = 写后落盘终态。
        const { name, enabled } = msg.payload
        const result = this.ctx.mcpServersService.setEnabled(name, enabled)
        this.ctx.reply(ws, msg.id, 'mcp.setEnabled:result', result)
        return true
      }
      case 'mcp.remove': {
        // 删除：reply ok 分支 entry = 被删条目删除前落盘值（回显），renderer 按名移除。
        const { name } = msg.payload
        const result = this.ctx.mcpServersService.remove(name)
        this.ctx.reply(ws, msg.id, 'mcp.remove:result', result)
        return true
      }
      case 'mcp.test': {
        // 连接测试（D3 异步任务形态）：立即 reply 任务句柄（testId 供「测试中」过程态
        // 关联），真实连接测试后台执行，不占 request/reply 往返。
        const { name } = msg.payload
        const handle = this.ctx.mcpServersService.test(name)
        this.ctx.reply(ws, msg.id, 'mcp.test:result', handle)
        return true
      }
      case 'mcp.testCancel': {
        // 取消连接测试（D3「取消」按钮——等价于超时到点杀进程的主动形态）：cancelled
        // true = 取消生效（probe 以 cancelled 终态收敛、不回填徽标，renderer 恢复取消前
        // 徽标）；false = 任务已结束，结果徽标照常经 mcp:testResult 广播回填。
        const { testId } = msg.payload
        const cancelled = this.ctx.mcpServersService.testCancel(testId)
        this.ctx.reply(ws, msg.id, 'mcp.testCancel:result', { cancelled })
        return true
      }
      default:
        return false
    }
  }
}
