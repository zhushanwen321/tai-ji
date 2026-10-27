/**
 * Project 域 —— project 列表持久化 RPC（D14，2026-08-04 迁 runtime projects.json）。
 *
 * 依赖方向：command（类型化原语，统一 pending.createCommandId + register + transport.send）。
 *
 * 写通道两代并存（旧代由 u6b 拆除）：
 * - 命令通道（connection-datasync-ssot §6.6，现行权威）：createProject / renameProject /
 *   removeProject / setActiveProject——请求携带期望 revision（最近一次读到的，load 回执
 *   或上一条命令回执），runtime 校验一致才执行、执行后 +1；回执 = 完整新状态 + revision
 *   新值；失败走 error envelope reject（调用方保持命令前状态 + toast）。
 * - save 通道（legacy，renderer deep-watch 整表回写旧载体）：原样保留，随 u6b 删除。
 */
import type { ProjectCommandReply, ProjectLoadReply, ProjectStoreState } from '@taiji/shared'
import { RPC_BACKSTOP_TIMEOUT_MS } from '../pending'
import { command } from '../request'

/** 全量加载 project 列表（runtime project.load → project.loaded reply，含 revision 水位）。 */
export async function load(): Promise<ProjectLoadReply> {
  return command('project.load', {}, RPC_BACKSTOP_TIMEOUT_MS)
}

/** 全量保存（legacy 通道，runtime project.save → project.loaded reply；ack 语义，前端不读 reply 数据）。 */
export async function save(state: ProjectStoreState): Promise<void> {
  await command('project.save', state, RPC_BACKSTOP_TIMEOUT_MS)
}

/** 新建 project（runtime 生成 id、追加、设为活跃）。 */
export async function createProject(name: string, revision: number): Promise<ProjectCommandReply> {
  return command('project.createProject', { name, revision }, RPC_BACKSTOP_TIMEOUT_MS)
}

/** 重命名 project（默认项目不可改名，runtime 侧拒绝）。 */
export async function renameProject(projectId: string, name: string, revision: number): Promise<ProjectCommandReply> {
  return command('project.renameProject', { projectId, name, revision }, RPC_BACKSTOP_TIMEOUT_MS)
}

/** 删除 project（默认项目不可删；删活跃项则锚定回落默认项目）。 */
export async function removeProject(projectId: string, revision: number): Promise<ProjectCommandReply> {
  return command('project.removeProject', { projectId, revision }, RPC_BACKSTOP_TIMEOUT_MS)
}

/** 锚定切换（不更新 lastUsedAt——排序键仅创建时写入）。 */
export async function setActiveProject(projectId: string, revision: number): Promise<ProjectCommandReply> {
  return command('project.setActiveProject', { projectId, revision }, RPC_BACKSTOP_TIMEOUT_MS)
}
