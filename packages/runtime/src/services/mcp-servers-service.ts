/**
 * MCP 服务器管理域 service —— 组合 IMcpServers port（pi-mcp-management 设计）。
 *
 * 职责边界：单行委托透传（ConfigService 的 codemode 域同款形态）。损坏错误态
 *（McpConfigCorruption：文件路径 + 隔离副本提示）与校验错误信封（D4「错误 → 原因 →
 * 修复动作」结构文案）在此层原样透传给 transport——错误数据协议定死在 reply 信封内，
 * 本层不吞错不降级不 throw；损坏拒入的 fail-fast 契约（S6）由 port 实现（pi-mcp-store
 * 损坏单点）执行，本层保证错误态形状无损到达 handler。
 *
 * 不建缓存不建推送（§3.1 + ADR-0075 拉为主）：清单每次现读 port（读以文件为准），
 * 变更可见性由 renderer 以 reply 终态校准 + 重开分区拉取承担。
 *
 * port 必参构造：装配遗漏在构造期即 TS 报错（组合根唯一装配点，u2b），不设可选注入
 * 的运行时抛错回退——独立新类无「既有测试不传」的兼容负担，编译期拦截强于运行时。
 */

import type { IMcpServers } from './ports/mcp-servers.js'
import type {
  McpListResult,
  McpMutationResult,
  McpServerEntryValue,
  McpTestHandle,
} from '@taiji/shared'

export class McpServersService {
  constructor(private readonly mcpServers: IMcpServers) {}

  list(): McpListResult {
    return this.mcpServers.list()
  }

  add(name: string, entry: McpServerEntryValue): McpMutationResult {
    return this.mcpServers.add(name, entry)
  }

  update(name: string, entry: McpServerEntryValue): McpMutationResult {
    return this.mcpServers.update(name, entry)
  }

  setEnabled(name: string, enabled: boolean): McpMutationResult {
    return this.mcpServers.setEnabled(name, enabled)
  }

  remove(name: string): McpMutationResult {
    return this.mcpServers.remove(name)
  }

  test(name: string): McpTestHandle {
    return this.mcpServers.test(name)
  }

  testCancel(testId: string): boolean {
    return this.mcpServers.testCancel(testId)
  }
}
