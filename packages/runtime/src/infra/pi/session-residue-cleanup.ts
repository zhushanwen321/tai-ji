/**
 * Session 残留清扫（崩溃/退役残留家族）。
 *
 * 自 session-file-utils.ts 拆出（lint max-lines 预算，同 session-binding-fields.ts /
 * session-file-streaming.ts 先例）：cleanupMigrateResidues（session 级，附着前 / delete
 * 链时机）与 cleanupTmpMigrateResidue（启动期目录级兜底）承载同一残留家族语义
 * （`.tmp-migrate-` / `.tmp-import-` 崩溃残留 + 退役 model sidecar）。原文件经
 * re-export 维持原导出路径（消费方 import 路径零改动）。
 */

import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'

/**
 * 清扫该 session 文件的 `.tmp-migrate-*.jsonl` 残留（差距复审 suggestion 6）。
 *
 * 残留来源 = normalizeSessionFileInPlace 在 writeFileSync 与 renameSync 之间崩溃
 * （或回滚删除失败的极端场景）。残留不被 scanner 收录（isScannableSessionFile 排除，
 * 不会错位附着），但属永久磁盘垃圾，本函数在两个自然时机将其回收：
 * ① 附着前（normalizeInactiveSessionFileIfNeeded 顶部，restore / 非活跃 rename 共用）
 * ——此刻本会话无归一化在途（restore 已销毁同 id 会话），同 basename 的残留必然 stale；
 * ② delete 链（与 sidecar 四后缀清理同点）——session 已删，残留随之清走。
 *
 * best-effort：目录列举失败 / 单个删除失败静默跳过（不阻塞附着/删除主流程）；
 * 只删「basename 前缀精确匹配 + .jsonl 后缀」的文件，不碰其他 session 的文件。
 */
export function cleanupMigrateResidues(filePath: string): void {
  const dir = dirname(filePath)
  const prefix = basename(filePath) + '.tmp-migrate-'
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (name.startsWith(prefix) && name.endsWith('.jsonl')) {
      // 删除逐条 debug 留痕（RT-3#10）：session 级清扫是数据删除动作，文件名必须可见
      console.debug(`[session-residue-cleanup] cleanupMigrateResidues: removing ${join(dir, name)}`)
      try { unlinkSync(join(dir, name)) } catch { void 0 }
    }
  }
}

/**
 * 残留默认过期阈值（1 小时）。为什么是 1h：归一化临时文件的 lifecycle 是毫秒级
 * （writeFileSync 后立即 renameSync），1h ≫ 生命周期，即使时钟精度/调度延迟极端放大
 * 也留足「不误删进行中临时文件」的余量；同时残留（磁盘垃圾）留 1h 无任何成本。
 */
const TMP_MIGRATE_RESIDUE_MAX_AGE_MS = 3_600_000

/**
 * 崩溃残留标记家族（import-session D1/r2-S1）：`.tmp-migrate-`（restore 归一化）与
 * `.tmp-import-`（导入 tmp+rename 复制）同规则——两类临时文件的 lifecycle 同为毫秒级
 * （写临时名后立即 rename），崩溃残留的形态与风险同构，清扫与扫描过滤按家族扩展。
 * isScannableSessionFile 的文件名过滤消费同一集合（候选侧与清扫侧同规则）。
 * r1-S5 起导出：import-service 的导入拒绝校验消费同一常量（消灭双副本漂移面）。
 */
export const TMP_RESIDUE_MARKERS = ['.tmp-migrate-', '.tmp-import-'] as const

/**
 * tmp 残留家族的精确文件名形态（RT-3#10）：`<原名>.tmp-(migrate|import)-<纯数字 ts>.jsonl`。
 *
 * 为什么不用 `name.includes(marker)` 子串判定：两类临时名的 marker 固定出现在 basename
 * 之后、且后接毫秒时间戳数字再收 `.jsonl` 尾——session id 本身中段含标记串的真实会话
 * 文件（实测 fixture：`a.tmp-migrate-b.jsonl`）会被子串判定误伤，既被 scanner 排除出
 * 列表又被本清扫删除（数据丢失）。后缀正则锚定「标记 + 纯数字 ts + .jsonl 结尾」的
 * 真实形态，真判定只对崩溃中间态成立。
 *
 * 消费方（三处同规则，禁再写第四份 includes）：候选侧 isScannableSessionFile
 * （session-file-utils）、清扫侧 removeResiduesInDir（本文件）、导入拒绝侧
 * import-source-external-file 的文件名校验。
 */
const TMP_RESIDUE_NAME_RE = /\.tmp-(?:migrate|import)-\d+\.jsonl$/

/** tmp 残留家族的精确判定（形态见 TMP_RESIDUE_NAME_RE；三消费点统一走本谓词）。 */
export function isTmpResidueFileName(name: string): boolean {
  return TMP_RESIDUE_NAME_RE.test(name)
}

/**
 * [缓存治理 U9] 退役 model sidecar 残留后缀：`<session>.jsonl.model.json`
 * （sidecar 读写点已随缓存治理批 3 全部退役，session-model-sidecar.ts 模块已删除）。
 *
 * 清扫策略与 tmp 标记家族不同——**年龄无关全删**（不适用 maxAgeMs 阈值）：
 * - 无「进行中写」需要保护：现役代码零写点（U8），唯一潜在写入方是回滚期的旧版本
 *   taiji，删除幂等无害——值可从 session JSONL 反向读重推导（U7 读侧已切 JSONL 真源），
 *   多实例并发删除竞态预期无害（cache-governance §3.3.5 风险行：目标文件名确定，
 *   重复删除走既有 warn 容错路径不抛出）。
 * tmp 标记家族保持 1h 按龄闸不变（防并发误删进行中的归一化/导入临时文件）。
 */
const MODEL_SIDECAR_RESIDUE_SUFFIX = '.jsonl.model.json'

/**
 * 启动期清扫 sessions 目录下的崩溃/退役残留（目录级兜底，两家族）：
 * - `.tmp-migrate-*.jsonl` / `.tmp-import-*.jsonl`（W3 残留清理；import-session D1
 *   扩展 `.tmp-import-` 家族）——按龄删（maxAgeMs，默认 1 小时）；
 * - `<session>.jsonl.model.json`（缓存治理 U9 退役 sidecar 家族）——年龄无关全删。
 *
 * cleanupMigrateResidues 只在「附着前 / delete 链」两个 session 级时机触发——若某
 * session 从此不再被 restore/删除，其残留永久留存（磁盘垃圾 + 排查困惑源）。本函数在
 * runtime 启动后台序列补上目录级兜底：一次性枚举整个 sessions 目录（含按 cwd 分组的
 * 子目录结构，与 scanPiSessionsFromDisk 同构）。
 *
 * 新鲜度阈值（maxAgeMs，默认 1 小时，仅约束 tmp 标记家族）：mtime 早于 now-maxAgeMs
 * 才删——正在进行的归一化临时文件必然秒级新鲜（normalizeSessionFileInPlace 写后立即
 * rename），阈值内不删可防并发误删扩大 S3 交错窗口。1 小时 ≫ 归一化的毫秒级生命周期，
 * 即使时钟精度/调度延迟极端放大也留足余量。U9 sidecar 家族不适用该阈值（年龄无关全删，
 * 理由见 MODEL_SIDECAR_RESIDUE_SUFFIX 注释）——设计裁决「删除全部残留而非按龄清理」
 * 以「sidecar 家族内年龄无关」落地而非调用点传 maxAgeMs=0：传 0 会连带取消 tmp 家族
 * 的防并发误删闸（对既有调用方行为零破坏）。
 *
 * 只删「标记家族（TMP_RESIDUE_MARKERS）任一命中 + `.jsonl` 后缀」或
 * 「MODEL_SIDECAR_RESIDUE_SUFFIX 后缀命中」的文件，其余零触碰；目录不存在 no-op。
 * 单个删除失败（权限等）跳过不中断（调用方接线在启动链，失败不得阻断启动）。
 *
 * @param sessionsDir sessions 根目录（getSessionsDir() 产出）
 * @param maxAgeMs    tmp 标记家族残留被认为是 stale 的最小年龄（ms；sidecar 家族不受此参约束）
 * @returns 实际删除的文件数，两家族合计（诊断用）
 */
export function cleanupTmpMigrateResidue(sessionsDir: string, maxAgeMs = TMP_MIGRATE_RESIDUE_MAX_AGE_MS): number {
  if (!existsSync(sessionsDir)) return 0
  // 与 scanPiSessionsFromDisk 同构的两层结构：根目录直接文件 + cwd 分组子目录
  //（normalizeSessionFileInPlace 的临时文件写在 dirname(filePath)，即 session 所在层）。
  const dirs = collectResidueScanDirs(sessionsDir)
  if (dirs === null) return 0 // 根目录不可读：no-op（启动链兜底，失败不上抛）
  const cutoff = Date.now() - maxAgeMs
  let removed = 0
  for (const dir of dirs) {
    removed += removeResiduesInDir(dir, cutoff)
  }
  return removed
}

/**
 * 枚举清扫目标目录：根目录 + 一层 cwd 分组子目录（与 scanPiSessionsFromDisk 同构）。
 * 根目录不可读返回 null（整体 no-op）；单项 stat 失败跳过（不影响其余子目录）。
 */
function collectResidueScanDirs(sessionsDir: string): string[] | null {
  const dirs: string[] = [sessionsDir]
  try {
    for (const name of readdirSync(sessionsDir)) {
      const entryPath = join(sessionsDir, name)
      try {
        if (statSync(entryPath).isDirectory()) dirs.push(entryPath)
      } catch { void 0 /* 单项 stat 失败跳过，不影响整体清扫 */ }
    }
  } catch {
    return null
  }
  return dirs
}

/** 清扫单目录内的残留（两家族：tmp 标记家族按龄删、U9 sidecar 家族年龄无关全删，
 * 家族判定与年龄策略见 cleanupTmpMigrateResidue 注释），返回删除数（两家族合计）。
 * 目录不可读返回 0；单文件 stat/unlink 失败跳过不中断（启动链兜底语义）。 */
function removeResiduesInDir(dir: string, cutoff: number): number {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    // RT-3#10：tmp 家族走精确后缀形态判定（isTmpResidueFileName），不再 includes 子串——
    // 中段含标记的真实会话文件（`a.tmp-migrate-b.jsonl`）曾既被收录排除又被这里删除。
    const isTmpResidue = isTmpResidueFileName(name)
    const isSidecarResidue = name.endsWith(MODEL_SIDECAR_RESIDUE_SUFFIX)
    if (!isTmpResidue && !isSidecarResidue) continue
    const filePath = join(dir, name)
    try {
      // 仅 tmp 家族受按龄闸约束（防并发误删进行中的归一化/导入临时文件）；sidecar 家族全删。
      if (isTmpResidue && statSync(filePath).mtimeMs >= cutoff) continue
      // 删除逐条 debug 留痕（RT-3#10）：目录级清扫是数据删除动作，文件名必须可见
      console.debug(`[session-residue-cleanup] cleanupTmpMigrateResidue: removing ${filePath}`)
      unlinkSync(filePath)
      removed++
    // eslint-disable-next-line taste/no-silent-catch -- best-effort: 单文件失败跳过，不阻断启动链
    } catch (e) {
      console.warn(`[session-file-utils] cleanupTmpMigrateResidue: failed to remove residue: ${filePath}`, e)
    }
  }
  return removed
}
