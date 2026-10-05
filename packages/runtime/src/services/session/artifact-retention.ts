/**
 * 会话产物目录保留期扫描（chat-html-support §6.7 D7 回收②）。
 *
 * 背景：agent 生成的 HTML 产物落在 `<dataDir>/artifacts/<sessionId>/`（公式单点 =
 * shared `getSessionArtifactsDir`）。删会话级联（回收①，见 session-lifecycle.ts
 * `purgeSessionSidecars`）覆盖正常删除；级联失败 / 外部删除 / 线会话终结后残留的目录
 * 由本扫描在保留期后兜底回收（与 `apps/electron/main/logs/log-retention.ts` 同型：
 * 启动扫 + 每日复扫 + mtime 判定——只借模式不借落点，本模块属于 runtime 会话服务）。
 *
 * **判据（文件系统级，对齐 main 侧 `image-cache.ts` 先例的判据层级，不依赖任何进程级
 * 在场集）**：
 *   ① 产物目录**子树内最新文件 mtime**（递归 max，不是目录条目 mtime——原地改写已存在
 *      文件不更新父目录 mtime，按目录条目判定会在「改写旧产物」场景误判超龄）超龄；
 *   ② 且目录名 sessionId 在**三棵会话树**中无同名会话文件。
 * 两条同时成立才清；任一条不成立保持原样。
 *
 * **枚举深度承重规格（写错会静默误删活会话产物）**：`pi-paths.ts` 的三个助手是路径
 * 访问器，不是枚举器——枚举须自实现逐层 readdir，且各树层数不同：
 *   - 主树 = `<piAgentDir>/sessions/<encodeCwd>/*.jsonl`（两层）
 *   - subagent 树 = `<piAgentDir>/subagents/<encodeCwd>/sessions/*.jsonl`（三层）
 *   - btw 树 = `<piAgentDir>/btw/<encodeCwd>/<mainSid>/*.jsonl`（三层）
 * 三棵树即全部会话文件写面——P-3 探针（⛔ u-artifacts 门禁）结论：枚举完备，无第四棵树
 * （主/agent 之外仅 `<dataDir>/sessions` 空遗留目录与外部系统 pi 只读导入源，均非写面；
 * btw 真机样本 `<btw>/<encodeCwd>/<mainSid>/<ISO>_<sid>.jsonl`，见 §11 检查点 9）。
 * **不得照 `image-cache.ts` 的 `isOrphanSessionDir` 单层形态实现**——该先例按单层
 * `readdirSync(sessionsDir)` 列举，与生产两层布局失配（判据恒判孤儿），缺陷另登记
 * `docs/todo/image-cache-orphan-depth-mismatch.md`；本模块只借其「判据落文件系统层」
 * 的形态，不借其枚举深度。
 *
 * **解析失配的保守取向**：会话文件 → id 解析用与 `image-cache.ts` 同型的
 * `sessionFileIdFromName`（`<ISO时间戳>_<uuid>.jsonl` → 末段 `_` 后 uuid，sidecar 先剥
 * 后缀）。该解析假定真 sid 为 uuid 形态（不含 `_`），而 pi 的 id 正则允许 `_` 与 `.`
 * ——目录名与解析值不相等时按「首个 `_` 后全串」再比一次，命中即视为「会话文件可能
 * 存在」→ 不清（不误删活会话产物）。
 *
 * **不含不计龄判据**：pi 延迟写入窗口（首条 assistant 前 jsonl 不存在）由超龄门构造性
 * 排除（默认 7 天 ≫ 窗口）；含 `:` 的 btw 虚拟 id（`btw:<sid>`）目录名在 `isPiSessionId`
 * 处被拒（真 sid 不含冒号，虚拟 id 形态构造性不会成为产物目录名）。
 *
 * 纯逻辑（根目录/保留天数/now 参数注入，测试注入 tmpdir——仓规测试红线：禁触碰真实
 * 数据目录），可直接单测。
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getSessionArtifactsDir } from '@taiji/shared/paths'
import {
  getBtwSessionsRoot,
  getSessionsDir,
  getSubagentSessionDir,
  isPiSessionId,
} from '../../infra/pi/pi-paths.js'

/** 产物目录保留天数默认值（env `TAIJI_ARTIFACTS_KEEP_DAYS` 覆盖）。 */
export const DEFAULT_ARTIFACTS_KEEP_DAYS = 7

const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
const HOURS_PER_DAY = 24
const MS_PER_SECOND = 1000
const MS_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND
/** 每日复扫间隔（24h）。 */
const ARTIFACT_RETENTION_INTERVAL_MS = MS_PER_DAY
/** 主会话树枚举深度（root 之下需穿过的目录层数：`<sessionsRoot>/<encodeCwd>/` 下即文件）。 */
const MAIN_TREE_DEPTH = 1
/** subagent 会话树枚举深度（`<subagentsRoot>/<encodeCwd>/sessions/` 下即文件）。 */
const SUBAGENT_TREE_DEPTH = 2
/** btw 会话树枚举深度（`<btwRoot>/<encodeCwd>/<mainSid>/` 下即文件）。 */
const BTW_TREE_DEPTH = 2

/** 保留天数读取（与 shared readLogKeepDays 同语义：env 覆盖 || 默认；非法值回落默认）。 */
export function readArtifactKeepDays(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.TAIJI_ARTIFACTS_KEEP_DAYS) || DEFAULT_ARTIFACTS_KEEP_DAYS
}

/**
 * 扫描根（测试注入 tmpdir；生产缺省经 shared paths / pi-paths 动态推导）。
 * 四个根全部可选——只注入测试关心的树，其余走缺省。
 */
export type ArtifactRetentionRoots = {
  /** 产物目录根（缺省 `<dataDir>/artifacts`，经 getSessionArtifactsDir 公式反推）。 */
  artifactsRoot?: string
  /** 主会话树根（缺省 `getSessionsDir()` = `<piAgentDir>/sessions`）。 */
  sessionsRoot?: string
  /** subagent 会话树根（缺省 `<piAgentDir>/subagents`）。 */
  subagentsRoot?: string
  /** btw 会话树根（缺省 `getBtwSessionsRoot()` = `<piAgentDir>/btw`）。 */
  btwRoot?: string
}

/** 一次保留期扫描的结果计数（调用方日志/测试断言用）。 */
export type ArtifactRetentionResult = {
  /** 产物根下检出的目录条目数（含未超龄 / 受保护目录）。 */
  scanned: number
  /** 实际删除（超龄 且 三棵树无同名会话文件）的产物目录名（sessionId）。 */
  removed: string[]
}

/**
 * 会话文件名 → sessionId（与 main 侧 `image-cache.ts` 的 `sessionFileIdFromName` 同型）。
 *
 * 形态实测锚点（本机真实树取样）：
 *   - 主树 `2026-10-03T10-21-05-097Z_01a10148-...jsonl`（+ `.jsonl.meta.json` sidecar）
 *   - subagent 树 `<ISO>_<uuid>.jsonl`（+ `.alive` / `.record-binding` sidecar）
 *   - btw 树 `2026-09-22T21-48-53-867Z_01a0cb17-...jsonl`（+ `.jsonl.meta.json`）
 * 解析 = 先剥 `.jsonl` 及其后 sidecar 后缀，再取末段 `_` 后的 uuid（用 lastIndexOf 防前缀
 * 未来引入更多 `_`）；无 `_` 的名字（防御未知形态）回退剥后缀全名。
 */
export function sessionFileIdFromName(fileName: string): string {
  const main = fileName.replace(/\.jsonl.*$/, '')
  const underscore = main.lastIndexOf('_')
  return underscore === -1 ? main : main.slice(underscore + 1)
}

/** 保留天数 → cutoff 毫秒（mtime < cutoff 即超龄）。 */
function cutoffMs(keepDays: number, now: number): number {
  return now - keepDays * MS_PER_DAY
}

/** best-effort 单条跳过：错误不中断扫描（对齐 log-retention.ts 的容错形态）。 */
function safeStat(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

/**
 * 产物目录子树内最新文件 mtime（递归 max）。无文件（空目录 / 仅子目录）时回落目录自身
 * mtime——pi 延迟写入窗口期的空目录按创建时间计龄。目录不可读时返回 0（超龄一侧，
 * 但后续会话文件判据仍会保护活会话）。
 */
export function newestFileMtimeMs(dir: string): number {
  let newest = 0
  const stack = [dir]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const current = stack.pop() as string
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      continue
    }
    for (const name of entries) {
      const full = join(current, name)
      const st = safeStat(full)
      if (!st) continue
      if (st.isDirectory()) {
        if (!seen.has(full)) {
          seen.add(full)
          stack.push(full)
        }
      } else if (st.isFile()) {
        const mtimeMs = Number(st.mtimeMs)
        if (mtimeMs > newest) newest = mtimeMs
      }
    }
  }
  if (newest > 0) return newest
  // 空目录回落目录 mtime（延迟写入窗口的计龄基准）；目录不可读 → 0（超龄一侧）
  return Number(safeStat(dir)?.mtimeMs ?? 0)
}

/**
 * 会话文件名是否属于目录名 dirName（含解析失配的保守匹配）。
 *
 * 主通道 = `sessionFileIdFromName` 解析值精确相等；失配通道 = 真 sid 可能含 `_`（解析只取
 * 末段），按「首个 `_` 后全串」再比一次——命中即保护（保守取向，宁可漏清不可误删）。
 */
export function sessionFileNameMatchesDir(fileName: string, dirName: string): boolean {
  if (sessionFileIdFromName(fileName) === dirName) return true
  const stem = fileName.replace(/\.jsonl.*$/, '')
  const first = stem.indexOf('_')
  return first !== -1 && stem.slice(first + 1) === dirName
}

/** 扫描单个叶子目录内的文件名是否命中目标 sessionId。 */
function leafDirHasSessionFile(dir: string, dirName: string): boolean {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return false
  }
  for (const name of entries) {
    if (sessionFileNameMatchesDir(name, dirName)) return true
  }
  return false
}

/**
 * 在某棵会话树根下逐层 readdir 到第 `depth` 层目录，再扫该层目录内的文件名。
 * depth = root 之下还需穿过的目录层数（主树 1 / subagent 与 btw 2）——见文件头
 * 「枚举深度承重规格」。
 */
function treeHasSessionFile(root: string, depth: number, dirName: string): boolean {
  if (depth === 0) return leafDirHasSessionFile(root, dirName)
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return false
  }
  for (const name of entries) {
    const full = join(root, name)
    const st = safeStat(full)
    if (!st || !st.isDirectory()) continue
    if (treeHasSessionFile(full, depth - 1, dirName)) return true
  }
  return false
}

/**
 * 三棵树中是否存在同名会话文件（树内文件形态见 `sessionFileIdFromName` 头注）。
 * 解析失配 / 非 session 形态文件命中一律按「可能存在」保守保护。
 */
export function sessionFileExistsInAnyTree(dirName: string, roots: ArtifactRetentionRoots = {}): boolean {
  const sessionsRoot = roots.sessionsRoot ?? getSessionsDir()
  // subagent 树根 = 访问器上溯两层（`getSubagentSessionDir(x)` = `<root>/<encodeCwd>/sessions`；
  // pi-paths 只暴露「带 cwd 的会话目录」访问器，无根访问器——上溯避免重写层级字面量）
  const subagentsRoot = roots.subagentsRoot ?? dirname(dirname(getSubagentSessionDir('/')))
  const btwRoot = roots.btwRoot ?? getBtwSessionsRoot()
  // 主树两层：<sessionsRoot>/<encodeCwd>/*.jsonl
  if (treeHasSessionFile(sessionsRoot, MAIN_TREE_DEPTH, dirName)) return true
  // subagent 三层：<subagentsRoot>/<encodeCwd>/sessions/*.jsonl
  if (treeHasSessionFile(subagentsRoot, SUBAGENT_TREE_DEPTH, dirName)) return true
  // btw 三层：<btwRoot>/<encodeCwd>/<mainSid>/*.jsonl
  if (treeHasSessionFile(btwRoot, BTW_TREE_DEPTH, dirName)) return true
  return false
}

/** 产物根缺省推导：`<dataDir>/artifacts`（经 shared 公式反推，避免再写一份段名字面量）。 */
function defaultArtifactsRoot(): string {
  return dirname(getSessionArtifactsDir('x'))
}

/**
 * 清理超龄（子树最新文件 mtime < cutoff）且三棵会话树无同名会话文件的产物目录。
 *
 * 语义：
 * - 产物根不存在 → 静默跳过（首次启动可能尚未建立，清理扫描不得反向制造目录）
 * - mtime 阈值在前（递归 max 需遍历子树，但只在候选目录上做——先过 dir 级 gate 再深算可
 *   避免为每个目录付递归代价；此处直接算子树最新 mtime，目录量级 = 会话数）
 * - 目录名非 pi sid 形态（含 `:` 的虚拟 id 等）→ 不入判据（跳过，不删）
 * - 单目录失败（并发删除 / 权限）best-effort 跳过，不影响其他目录
 *
 * @param roots    扫描根注入（测试）；缺省全部动态推导
 * @param keepDays 保留天数；缺省读 env
 * @param now      当前时间（测试注入）
 */
export function cleanExpiredArtifactDirs(
  roots: ArtifactRetentionRoots = {},
  keepDays: number = readArtifactKeepDays(),
  now: number = Date.now(),
): ArtifactRetentionResult {
  const result: ArtifactRetentionResult = { scanned: 0, removed: [] }
  const artifactsRoot = roots.artifactsRoot ?? defaultArtifactsRoot()
  if (!existsSync(artifactsRoot)) return result
  const cutoff = cutoffMs(keepDays, now)
  let names: string[]
  try {
    names = readdirSync(artifactsRoot)
  } catch {
    return result
  }
  for (const name of [...names].sort()) {
    const dir = join(artifactsRoot, name)
    const st = safeStat(dir)
    if (!st || !st.isDirectory()) continue
    result.scanned++
    // 目录名合法性（真 sid 不含 `:`；虚拟 id 形态构造性不会成为目录名——防御外部 junk）
    if (!isPiSessionId(name)) continue
    // ① 子树最新文件 mtime 超龄（原地改写反例由递归 max 覆盖）
    if (newestFileMtimeMs(dir) >= cutoff) continue
    // ② 三棵会话树无同名会话文件（活会话保护）
    if (sessionFileExistsInAnyTree(name, roots)) continue
    try {
      rmSync(dir, { recursive: true, force: true })
      result.removed.push(name)
    // eslint-disable-next-line taste/no-silent-catch -- 单目录清理失败（并发删除/权限）不影响其他目录；best-effort 容错，对齐 log-retention.ts
    } catch {
      // no-op
    }
  }
  return result
}

/**
 * 立即执行一次清理扫描（启动扫入口；保留天数读 env）。
 * 组合根/后台序列调用；返回计数供日志。
 */
export function runArtifactRetentionNow(now: number = Date.now()): ArtifactRetentionResult {
  return cleanExpiredArtifactDirs({}, readArtifactKeepDays(), now)
}

/**
 * 启动扫 + 挂每日复扫定时器（startup-background-init ⑪ 调用一次）。
 *
 * 启动扫放最前（长寿进程窗口的起点兜底），定时器 unref 不 hold 进程退出；单次扫描异常
 * best-effort 消化（清理故障不阻塞启动，下一拍/下次启动重试）。返回 stop 函数。
 */
export function startArtifactRetention(): () => void {
  try {
    const startup = runArtifactRetentionNow()
    if (startup.removed.length > 0) {
      console.log(`[runtime] artifact retention: removed ${startup.removed.length} expired session artifact dir(s) at startup`)
    }
  } catch (e) {
    // best-effort：启动扫失败不阻塞启动（残留仅是磁盘垃圾，下拍/下次启动重试）
    console.warn('[runtime] artifact retention startup sweep failed:', e)
  }
  const timer = setInterval(() => {
    try {
      const tick = runArtifactRetentionNow()
      if (tick.removed.length > 0) {
        console.log(`[runtime] artifact retention: removed ${tick.removed.length} expired session artifact dir(s)`)
      }
    } catch (e) {
      // best-effort：单拍扫描失败不影响后续拍（残留仅是磁盘垃圾，下拍重试）
      console.warn('[runtime] artifact retention daily sweep failed:', e)
    }
  }, ARTIFACT_RETENTION_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}
