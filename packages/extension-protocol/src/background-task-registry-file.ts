/**
 * registry.json 文件行为原语（解析防御 / corrupt 隔离 / 原子写 / 终态 LRU 裁剪 /
 * 序列化）——跨端单一实现。
 *
 * 契约两端（此前各持一份同构实现，对齐手段是注释）：
 *  - extension 侧：@zhushanwen/pi-base-tool-enhance background/registry.ts（bte 的
 *    readRegistry 返回 Map、锁壳用 pi-file-lock）
 *  - runtime 侧：xyz-agent background-task-reaper / services/background-task/
 *    registry-write.ts（数组形态、锁壳用统一锁）
 *
 * 本模块只提供无锁原语与纯函数；锁壳（withFileLockSync RMW 编排）留在各侧——
 * 两侧锁实现不同（pi-file-lock vs runtime 统一锁）是产品决策，不下沉。
 *
 * 日志通道：本模块零日志依赖——warn 级诊断（registry 读失败 / corrupt 隔离 /
 * tmp 清理失败）经可选回调 `onLog('warn', event, detail)` 上报，extension 侧注入
 * extension-logger 适配、runtime 侧注入 console 适配。corrupt 隔离 warn 是排障
 * 生命线，两侧适配必接。锁壳层的「registry write failed」warn 属各侧锁壳职责
 * （写失败时条目停留 running 的降级决策在锁壳），不在本模块。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  BACKGROUND_TASK_REGISTRY_VERSION,
  isBackgroundTaskRegistryEntry,
  isTerminalBackgroundTaskState,
  type BackgroundTaskRegistryEntry,
  type BackgroundTaskRegistryFile,
  type BackgroundTaskState,
} from './background-task'

/** registry 文件原语日志回调（落盘/console 通道由调用方适配注入）。 */
export type RegistryFileLogFn = (level: 'warn' | 'debug', event: string, detail?: unknown) => void

/** registry 序列化缩进（契约：JSON indent 2 + 尾部换行）。 */
const JSON_INDENT = 2
// tmp 随机段参数（两侧既有实现同款：36 进制随机串，跳过 "0." 前缀）
const TMP_RADIX = 36
const TMP_SLICE_START = 2
const TMP_SLICE_END = 10

/** 终态裁剪入参的最小结构约束（泛型透传，保留调用方条目类型）。 */
export interface TrimTerminalEntryLike {
  taskId: string
  startedAt: number
  endedAt?: number
  state: BackgroundTaskState
}

/**
 * 校验并归一化 registry 文件内容；形状非法返回 undefined（走 corrupt 隔离路径）。
 * version 不匹配 / entries 非数组 → 整体非法；单条脏数据丢弃、不报废全表
 * （契约 guard isBackgroundTaskRegistryEntry 复用）。
 */
export function parseRegistryContent(raw: string): BackgroundTaskRegistryEntry[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { version, entries } = parsed as Record<string, unknown>
  if (version !== BACKGROUND_TASK_REGISTRY_VERSION || !Array.isArray(entries)) return undefined
  return entries.filter(isBackgroundTaskRegistryEntry)
}

/** .corrupt 落点：固定名优先；已存在则带时间戳，不覆盖前一份现场。 */
export function corruptPathFor(registryPath: string): string {
  const base = `${registryPath}.corrupt`
  return existsSync(base) ? `${base}-${Date.now()}` : base
}

/**
 * 读取 registry 全量条目 + 损坏标记（runtime 现形态为超集；extension 侧 Map 形态
 * 由各侧薄壳投影）。UI 读侧需要区分「真的空表」与「损坏被隔离的空表」。
 *
 * 文件不存在 / 读失败 → 空表 + corrupted:false（常态/降级，非损坏）；解析失败 →
 * 重命名 .corrupt 保留现场 + onLog warn + 空表 + corrupted:true（「空表重建」由
 * 后续写入自然完成，不立即写空文件）。
 */
export function readRegistry(registryPath: string, onLog?: RegistryFileLogFn): { entries: BackgroundTaskRegistryEntry[]; corrupted: boolean } {
  if (!existsSync(registryPath)) return { entries: [], corrupted: false }
  let raw: string
  try {
    raw = readFileSync(registryPath, 'utf8')
  } catch (err) {
    // best-effort 降级：读失败（权限等）按空表继续——调用方不因 registry 问题崩溃
    onLog?.('warn', 'registry read failed, treating as empty', { path: registryPath, err })
    return { entries: [], corrupted: false }
  }
  const parsed = parseRegistryContent(raw)
  if (parsed === undefined) {
    const corruptPath = corruptPathFor(registryPath)
    try {
      renameSync(registryPath, corruptPath)
      onLog?.('warn', 'registry corrupted, quarantined and continuing with empty table', {
        path: registryPath,
        corruptPath,
      })
    } catch (err) {
      // best-effort 降级：隔离 rename 失败（目录只读等）原文件保留原位，仍按空表继续
      onLog?.('warn', 'registry corrupted and quarantine rename failed, continuing with empty table in place', {
        path: registryPath,
        err,
      })
    }
    return { entries: [], corrupted: true }
  }
  return { entries: parsed, corrupted: false }
}

/**
 * registry 文件序列化（字节契约单点：version 锁定 + JSON indent 2 + 尾部换行）。
 * 两侧写路径共用本函数——文件字节形态归一是 V4/P2 验收的前提。
 */
export function serializeRegistryFile(entries: BackgroundTaskRegistryEntry[]): string {
  const shape: BackgroundTaskRegistryFile = { version: BACKGROUND_TASK_REGISTRY_VERSION, entries }
  return `${JSON.stringify(shape, null, JSON_INDENT)}\n`
}

/**
 * 原子写：tmp（pid+随机段唯一化防并发碰撞）+ rename（POSIX/Windows 均原子）；
 * 失败清理 tmp 后向上抛原错误（锁壳层决定降级语义）。tmp 清理失败不掩盖原错误，
 * 仅经 onLog 上报诊断。
 */
export function atomicWriteRegistry(registryPath: string, content: string, onLog?: RegistryFileLogFn): void {
  mkdirSync(dirname(registryPath), { recursive: true })
  const tmpPath = `${registryPath}.tmp_${process.pid}_${Math.random().toString(TMP_RADIX).slice(TMP_SLICE_START, TMP_SLICE_END)}`
  try {
    writeFileSync(tmpPath, content, 'utf8')
    renameSync(tmpPath, registryPath)
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath)
    } catch (cleanupErr) {
      // best-effort：tmp 清理失败不掩盖原错误，仅留诊断
      onLog?.('warn', 'registry tmp cleanup failed', { tmpPath, err: cleanupErr })
    }
    throw err
  }
}

/**
 * 终态条目 LRU 裁剪（纯函数）：终态（exited/orphaned）按 `endedAt ?? startedAt`
 * 升序、超上限淘汰最老；活跃条目（running/killing）永不淘汰；未超上限原样保留。
 * 入参数组不被修改（sort 作用于 filter 产生的新数组），返回保留集新数组。
 * extension task-store 与 registry 写侧、runtime registry-write 共用（max 由各侧
 * 传参，上限值不变）。
 */
export function trimTerminalEntries<T extends TrimTerminalEntryLike>(entries: T[], max: number): T[] {
  const terminal = entries
    .filter((e) => isTerminalBackgroundTaskState(e.state))
    .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt))
  const excess = terminal.length - max
  if (excess <= 0) return [...entries]
  const evicted = new Set(terminal.slice(0, excess).map((e) => e.taskId))
  return entries.filter((e) => !evicted.has(e.taskId))
}
