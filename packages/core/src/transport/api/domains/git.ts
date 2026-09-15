/**
 * Git 域 —— status/stage/unstage/commit（issues.md #1 / code-architecture §3.1）。
 *
 * 三类形态：
 * - 请求-响应：status（→ 'git.status:result' 同步 reply，经 pending.resolve 消费）
 * - 动作-ack：stage/unstage/commit（→ 'message.status' ack，payload {sessionId, status}）
 *
 * 依赖方向：command（类型化原语，统一 pending.createCommandId + register + transport.send）。不 import events（git 无 server-push 订阅）。
 *
 * 注：stage/unstage/commit 的 ack 复用 'message.status' type（protocol.ts 既有），前端 routeInbound
 * 按 msg.id resolve pending；domain 返回 Promise<void>，忽略 ack payload。失败走 error envelope
 * （routeInbound 对 type==='error' 走 pending.reject），domain Promise 抛出。
 */
import type { GitStatusResult } from '@taiji/shared'
import { RPC_BACKSTOP_TIMEOUT_MS } from '../pending'
import { command } from '../request'

/** 查询 session cwd 的全量 git 状态（FR-12）。session 不存在 / 非 git 仓库 → isRepo=false 降级结果。 */
export function status(sessionId: string): Promise<GitStatusResult> {
  return command('git.status', { sessionId }, RPC_BACKSTOP_TIMEOUT_MS)
}

/** 单文件 diff patch（#5，UC-6 点文件预览）。越界/超时/非 repo → Promise reject（error envelope）。 */
export async function getDiff(
  sessionId: string,
  path: string,
): Promise<{ patch: string; binary: boolean }> {
  const reply = await command('git.diff', { sessionId, path }, RPC_BACKSTOP_TIMEOUT_MS)
  return { patch: reply.patch, binary: reply.binary }
}

/** 暂存文件。空 filePaths → git add -A（全量暂存）。 */
export function stage(sessionId: string, filePaths?: string[]): Promise<void> {
  return command('git.stage', { sessionId, filePaths }, RPC_BACKSTOP_TIMEOUT_MS)
}

/** 取消暂存。空 filePaths → git reset HEAD（全量取消暂存）。 */
export function unstage(sessionId: string, filePaths?: string[]): Promise<void> {
  return command('git.unstage', { sessionId, filePaths }, RPC_BACKSTOP_TIMEOUT_MS)
}

/**
 * 提交。message 可选（与 ClientMessageMap 一致；runtime 在空 message 时返回 'commit_message_required' error）。
 * 冲突态 → runtime 返回 'git_conflict' error（domain Promise reject）。
 */
export function commit(sessionId: string, message?: string): Promise<void> {
  return command('git.commit', { sessionId, message: message ?? '' }, RPC_BACKSTOP_TIMEOUT_MS)
}

/**
 * 切换分支（#6 选分支 popover）。ack 复用 'message.status' {status:'switched'}。
 * 分支不存在 / dirty 冲突 / 非 git → runtime GitError → Promise reject（调用方留 popover 显错）。
 */
export function checkout(sessionId: string, name: string): Promise<void> {
  return command('git.checkout', { sessionId, name }, RPC_BACKSTOP_TIMEOUT_MS)
}

/**
 * 按 cwd 检出分支（landing 态无 session，plain-repo 模式切分支用）。
 * 与 checkout(sessionId,name) 同语义，但不经 session 解析，直接对 cwd 跑 git checkout。
 */
export function checkoutByCwd(cwd: string, name: string): Promise<void> {
  return command('git.checkoutCwd', { cwd, name }, RPC_BACKSTOP_TIMEOUT_MS)
}

/**
 * 创建并检出分支（#7 创建分支 modal）。ack 复用 'message.status' {status:'branch_created'}。
 * 分支名非法/已存在/超时→runtime GitError→Promise reject（调用方留 modal 显错，D-7）。
 */
export function createBranch(sessionId: string, name: string): Promise<void> {
  return command('git.createBranch', { sessionId, name }, RPC_BACKSTOP_TIMEOUT_MS)
}
