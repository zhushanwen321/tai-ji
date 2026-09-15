/**
 * Project 域 —— project 列表持久化 RPC（D14，2026-08-04 迁 runtime projects.json）。
 *
 * 依赖方向：command（类型化原语，统一 pending.createCommandId + register + transport.send）。
 *
 * 与 workspace 域同模式：load 全量拉取，save 全量写入（前端 store 是权威内存，
 * deep watch 变化后全量 save；runtime WriteBackCache debounce 落盘）。
 */
import type { ProjectStoreState } from '@taiji/shared'
import { RPC_BACKSTOP_TIMEOUT_MS } from '../pending'
import { command } from '../request'

/** 全量加载 project 列表（runtime project.load → project.loaded reply）。 */
export async function load(): Promise<ProjectStoreState> {
  return command('project.load', {}, RPC_BACKSTOP_TIMEOUT_MS)
}

/** 全量保存（runtime project.save → project.loaded reply；ack 语义，前端不读 reply 数据）。 */
export async function save(state: ProjectStoreState): Promise<void> {
  await command('project.save', state, RPC_BACKSTOP_TIMEOUT_MS)
}
