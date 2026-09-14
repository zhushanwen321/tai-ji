import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { getAgentDir } from '@earendil-works/pi-coding-agent'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { isEnoentError, toErrorMessage } from '@zhushanwen/pi-ext-guards'
import { getLogger } from '@zhushanwen/pi-extension-logger'

import { TASK_ENTRY_TYPE, toTaskSnapshot } from './types.js'
import type { ScheduledTask, SchedulerEntryOp, SchedulerStore } from './types.js'

const logger = getLogger('scheduler')

/**
 * 获取旧 store 文件路径：scheduler/<root>/<segments>/scheduler.json，双候选探测。
 *
 * 内联自 store.ts getStorePath——store.ts 本 wave 删除后此函数是旧路径的唯一推导实现，
 * 不能 import 已删 store。workspace 路径隔离，不同 cwd 存不同文件。
 *
 * export 供测试推导期望路径（断言 renameSync/unlinkSync 参数）。
 *
 * 双候选探测（合并 feat-auto-name-session-refactor 分支 4b5513b5e 后落实）：
 * 候选 1 用 pi 的 getAgentDir()（读 PI_CODING_AGENT_DIR，xyz-agent 数据目录隔离时指向隔离目录），
 * 候选 2 是已发布版（npm 0.1.1）store.ts 的硬编码 `~/.pi/agent/scheduler/`。探测规则：
 * 候选 1 存在则用候选 1（隔离实例的旧任务），否则 fallback 候选 2（0.1.1 版写入的真实数据源，
 * 必须按此路径探测才能迁移）。getAgentDir() 未设置 env 时默认 ~/.pi/agent，两候选同路径，探测无副作用。
 */
export function getLegacyStorePath(cwd: string): string {
  const resolved = path.resolve(cwd)
  const parsed = path.parse(resolved)
  const segments = resolved.slice(parsed.root.length)
    .split(path.sep).filter(Boolean)
  const root = parsed.root
    .replaceAll(/[^a-zA-Z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .toLowerCase() || 'root'
  const agentDirPath = path.join(getAgentDir(), 'scheduler', root, ...segments, 'scheduler.json')
  const legacyPath = path.join(os.homedir(), '.pi', 'agent', 'scheduler', root, ...segments, 'scheduler.json')
  return fs.existsSync(agentDirPath) ? agentDirPath : legacyPath
}

/**
 * 旧 store 任务字段补全（参考 store.ts load() 默认值兜底）：旧数据可能缺字段，逐字段给默认值。
 * ownerSessionFile/pending 不补全——旧数据本无此二字段，由 toTaskSnapshot 剥离。
 */
function normalizeLegacyTask(t: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: t.id ?? '',
    name: t.name ?? '',
    prompt: t.prompt ?? '',
    kind: t.kind ?? 'recurring',
    schedule: t.schedule ?? { mode: 'interval', intervalMs: 60000 },
    createdAt: t.createdAt ?? 0,
    nextRunAt: t.nextRunAt ?? 0,
    runCount: t.runCount ?? 0,
    enabled: t.enabled ?? true,
    history: t.history ?? [],
    expiresAt: t.expiresAt,
    lastRunAt: t.lastRunAt,
    lastStatus: t.lastStatus,
    lastError: t.lastError,
  }
}

/**
 * 从 .imported 路径读取旧 store JSON、逐任务 pi.appendEntry upsert、按 flush 状态删除 .imported。
 * read/parse/append 任一异常由外层 importLegacyStore 的 try/catch 兜底（C1 整体降级）。
 *
 * 返回值为延迟删除 cleanup（未 flush 的新 session 场景），由 index.ts 在首个 turn_end 与
 * session_shutdown 时调用（cleanup 幂等，可重复调用）；已安全删除或无需导入时返回 undefined。
 *
 * ⚠️ unlink 时机（IMPORT-FLUSH-GUARD，MF-1 修复）：pi SessionManager._persist 延迟写入——
 * 新 session（sessionFile 尚不存在 → flushed=false）的 appendEntry 只进内存 fileEntries，
 * 首个 assistant message 到达才 flush 落盘（openSync "wx" 全量写 fileEntries）。若紧随 append
 * 循环 unlink，未 flush 即退出（打开未发消息即关闭、xyz-agent 自动打开/恢复的 session）→
 * 全部旧任务永久丢失且源文件已销毁，崩溃恢复路径（.imported 残留）同时失效。
 * resumed session（sessionFile 已存在 → _setSessionFile 载入时 flushed=true）每次 append
 * 即时写盘，unlink 安全。
 *
 * 判定依据（pi SDK 源码，非推理）：dist/core/session-manager.js `_persist` 的 !hasAssistant
 * 分支——flushed=true 时 appendFileSync 直写盘，flushed=false 时仅内存；flushed 仅在
 * _setSessionFile 载入已存在文件（或零字节文件重写）时置 true，新 session 恒 false。
 * sessionFile 进程内只可能由首次 flush 创建（openSync "wx" 全量写），故
 * fs.existsSync(currentSessionFile) 在 session_start 时点与 flushed 状态等价。
 */
function importFromFile(
  importedPath: string,
  pi: Pick<ExtensionAPI, 'appendEntry'>,
  currentSessionFile: string,
): (() => void) | undefined {
  const content = fs.readFileSync(importedPath, 'utf-8')
  const data = JSON.parse(content) as Partial<SchedulerStore>
  const tasks = (data.tasks ?? []).map(normalizeLegacyTask)

  for (const task of tasks) {
    const op: SchedulerEntryOp = {
      op: 'upsert',
      taskId: task.id,
      ownerSessionFile: currentSessionFile,
      task: toTaskSnapshot(task),
    }
    pi.appendEntry(TASK_ENTRY_TYPE, op)
  }

  // 空 store（0 任务）无持久化依赖，直接删；resumed session（sessionFile 已存在）已即时落盘，删
  if (tasks.length === 0 || fs.existsSync(currentSessionFile)) {
    fs.unlinkSync(importedPath)
    // 内部诊断日志（非用户可见消息）：经共享 logger.warn → appendEntry 持久化为 custom entry，
    // 不污染 TUI（logging-conventions SSOT：诊断走 logger.warn，禁裸 console）。
    logger.warn('imported legacy tasks', { count: tasks.length, path: importedPath })
    return undefined
  }

  // 新 session（未 flush）：延迟删除，cleanup 由 index.ts 在首个 turn_end（该轮 message_end 已全部
  // 持久化，flush 必已发生——agent-session.js _handleAgentEvent 在 message_end 处理中调
  // appendMessage 触发 _persist 全量落盘）与 session_shutdown 时重复调用——flush 后 sessionFile
  // 出现 → 删；仍未 flush → 静默保留 .imported 供下次 session_start 的 handleImportedResidue
  // 崩溃恢复重导入。跨 session 重导入窗口 = session_start → 首个 turn_end（秒级）：turn_end 后
  // .imported 已删，后续 session 启动看不到残留 → 双导入窗口闭合（R-CONCURRENT-IMPORT 已更新）
  logger.warn('imported legacy tasks (session not flushed; deferring removal)', {
    count: tasks.length,
    path: importedPath,
  })
  return () => {
    // 幂等：已删（本进程或并发另一进程已处理）→ no-op。cleanup 在每次 turn_end 都会调用，重复调用安全
    if (!fs.existsSync(importedPath)) return
    if (fs.existsSync(currentSessionFile)) {
      // flush 已发生（sessionFile 由首次 flush 创建，fileEntries 全量落盘）→ 安全删除
      try {
        fs.unlinkSync(importedPath)
      } catch (err) {
        // MF-2：并发——另一进程（resumed B）已 unlink → ENOENT 静默；其他 fs 错误（EACCES）不吞
        if (!isEnoentError(err)) throw err
      }
    }
    // 从未 flush：保留 .imported，下次 session_start 崩溃恢复重导入（不 unlink；不告警——
    // 每次 turn_end 都会走到这里，避免刷屏；保留依据见上方 IMPORT-FLUSH-GUARD 注释）
  }
}

/**
 * 残留恢复：rename 抛 ENOENT（别人已把 scheduler.json rename 走）后处理 .imported 残留。
 *
 * 并发 + 崩溃恢复交叉窗口（R-CONCURRENT-IMPORT）：若 .imported 存在，可能是
 *   a) 本进程上次崩溃留下的 .imported（崩溃恢复）→ 导入正确
 *   b) 另一进程 winner rename 后、unlinkSync 前的 .imported（rename 竞态）→ 本进程也会导入
 *   c) 另一进程新 session 延迟删除窗口内的 .imported（IMPORT-FLUSH-GUARD：session_start →
 *      首个 turn_end 之间）→ 本进程也会导入
 * 窗口：b 为 rename→unlinkSync 毫秒级（需两进程同时 session_start 同 cwd，罕见）；c 为秒级
 * （A 存活且首 turn 未完成时 B 启动）。c 由 turn_end 触发的清理收敛：A 首个 turn 完成后
 * .imported 删除，此后 B 启动 → 双不存在 → skip。
 *
 * ⚠️ 双导入后果（如实记录，非「已被消除」）：情况 b/c 下 A/B 各自导入一份副本、owner 各为自己，
 * 同一个逻辑任务会在两个 session 各触发一次（跨 session 双触发，正是 G5 要防的）。owner 过滤
 * （按 ownerSessionFile）只保证「单一 session 内不重复」，并不能消除此跨 session 双触发——
 * owner 过滤针对的是 fork 继承的「owner=他者」任务，而此处两副本的 owner 各自匹配本 session。
 * 窗口（毫秒级竞态 + 秒级延迟删除窗口）远小于「.imported 全程驻留」，可接受，不引入锁机制（过度工程）。
 */
function handleImportedResidue(
  importedPath: string,
  pi: Pick<ExtensionAPI, 'appendEntry'>,
  currentSessionFile: string,
): (() => void) | undefined {
  if (fs.existsSync(importedPath)) {
    return importFromFile(importedPath, pi, currentSessionFile)
  }
  // else: 双不存在（TC3），no-op
  return undefined
}

/**
 * 导入旧 scheduler store 到当前 session（append-only event sourcing 迁移，IF-IMPORT-LEGACY）。
 *
 * 策略：原子 rename scheduler.json → scheduler.json.imported 独占迁移；成功者读取 .imported
 * 逐任务 pi.appendEntry(TASK_ENTRY_TYPE, upsert) 后删除 .imported；rename 抛 ENOENT
 * 说明并发场景下别人已 rename 走，走 handleImportedResidue 幂等恢复。
 *
 * 时序（CL3 方案A）：必须在 backend.loadTasks() 之前执行——append 的 upsert entry 进入 pi
 * 内存 fileEntries，紧接的 loadTasks replay 统一重放读到导入任务（pi _appendEntry 同步 push
 * fileEntries，design-review 已实测验证）。
 *
 * 整体降级（C1）：read/parse/appendEntry 任一异常 → logger.warn + 不 rethrow，不让
 * session_start 崩溃（与 replay gap4 / ER-APPEND-FAIL 同款降级语义）。append 中途失败时
 * .imported 保留（不 unlink）——下次 session 的 handleImportedResidue 会重导入全部任务，
 * 已成功 append 的子集可能跨 session 双触发；取舍：删除则失败任务永久丢失（更糟），
 * 保留则与 R-CONCURRENT-IMPORT / IMPORT-FLUSH-GUARD 同属 at-least-once 已接受窗口（SG-1）。
 *
 * nextRunAt 原样保留不重算、不 gc 过滤（CL4）：导入后首个 tick 立即 dispatch（D3 立即触发语义）。
 *
 * 返回值：延迟删除 cleanup（新 session 未 flush 时保留 .imported 待首个 turn_end /
 * session_shutdown 确认 flush 后删除；cleanup 幂等，可重复调用），已安全处理时为 undefined。
 * index.ts 在 turn_end 与 session_shutdown 调用它。
 */
export function importLegacyStore(
  cwd: string,
  pi: Pick<ExtensionAPI, 'appendEntry'>,
  currentSessionFile: string | undefined,
): (() => void) | undefined {
  // TC5：--no-session 模式无 owner session 可归属，导入无意义，早 return 不碰 fs
  if (currentSessionFile === undefined) return undefined

  const storePath = getLegacyStorePath(cwd)
  const importedPath = storePath + '.imported'

  try {
    try {
      fs.renameSync(storePath, importedPath)
    } catch (err) {
      if (isEnoentError(err)) {
        // 并发 S10 / 崩溃恢复：scheduler.json 已不在（被别人 rename 走或上次崩溃）→ 残留恢复
        return handleImportedResidue(importedPath, pi, currentSessionFile)
      }
      // 其他 fs 错误走整体降级 warn
      throw err
    }

    // 成功 rename → 导入 .imported
    return importFromFile(importedPath, pi, currentSessionFile)
  } catch (err) {
    // C1 整体降级：read/parse/appendEntry 任一异常不崩 session_start
    logger.warn('import failed', { error: toErrorMessage(err) })
    return undefined
  }
}
