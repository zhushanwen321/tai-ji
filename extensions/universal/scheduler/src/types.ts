// entry 契约与折叠器单源于 @zhushanwen/extension-protocol（U2 折叠器下沉：扩展与 taiji plugin
// 同源消费，杜绝双实现漂移）。本文件保持既有 import 路径不变（re-export），仅保留
// 扩展侧写面私有物（toTaskSnapshot / 旧 store 形状 / 工具参数）。

export {
  appendExecutionRecord,
  HISTORY_LIMIT,
  snapshotToTask,
  TASK_ENTRY_TYPE,
} from '@zhushanwen/extension-protocol'
export type {
  ExecutionRecord,
  ScheduleSpec,
  ScheduledTask,
  SchedulerEntryOp,
  TaskKind,
  TaskSnapshot,
  TaskStatus,
} from '@zhushanwen/extension-protocol'

// 本地保留面（写侧 helper / 旧 store 形状 / 工具参数）签名引用的类型——re-export 不引入作用域，需显式 import
import type { ScheduledTask, TaskKind, TaskSnapshot } from '@zhushanwen/extension-protocol'

/**
 * ScheduledTask → TaskSnapshot（ext-simplify-17 B2 canonical，解构剥离式）：剥离
 * ownerSessionFile（在 op 顶层）与 pending（运行时标记），history 用 slice() 拷贝数组
 * （元素为不可变值对象 {at,status}，无元素级 mutate 路径，数组级拷贝即隔离 push/shift）。
 *
 * 选解构式而非显式逐字段列举：快照字段自动跟随 ScheduledTask 演进——显式列举漏写
 * （可选字段）时无编译错误，upsert 快照静默缺字段、replay 恢复丢数据。
 * importer 侧输入是 normalizeLegacyTask 补全的旧 store 数据，本无 ownerSessionFile/
 * pending 运行时字段，剥离子集对其 no-op，同一实现覆盖新任务与导入两条路径。
 */
export function toTaskSnapshot(task: ScheduledTask): TaskSnapshot {
  const { ownerSessionFile: _o, pending: _p, history, ...rest } = task
  return { ...rest, history: history.slice() }
}

// ── 持久化 ──

export interface SchedulerStore {
  /**
   * 形状忠实保留（ext-simplify-08 L8）：旧 store 文件（npm 0.1.1 store.ts）顶层携带
   * version:1，importer 只读 tasks、version 零读点——字段是磁盘格式的文档而非消费面，
   * 删除会让类型与迁移源文件的真实形状静默漂移。
   */
  version: 1
  tasks: ScheduledTask[]
}

// ── 添加选项 ──

export interface AddOptions {
  name?: string
  kind?: TaskKind
  expires?: string
  /** 任务执行模型（scoped model id，provider/model）；缺省 = 跟随会话当前模型 */
  model?: string
}
