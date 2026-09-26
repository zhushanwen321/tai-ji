/**
 * plan-state entry legacy 读取（plan-mode-audit-remediation D-B4-1：旧 entry 映射单源下沉）。
 *
 * plan-state entry 是磁盘持久化数据，真实跨版本存在：新 schema（state / resumeHint，状态机
 * 显式化 D2 取代式演进）与旧 schema（reviewState / reviewStateSource 已停写）在历史 session
 * 文件中长期并存。读取规则与 entry schema 同属一个变化原因——未来停支持旧 entry 时删除点
 * 唯一（本模块）。
 *
 * 消费方 = 扩展 reconstructPlanState（读方①）+ runtime plan-state-extractor（读方②）直引；
 * renderer 侧兜底映射已随批次 3 条目 1 删除（不引）。原 shared fixture 等价表与双套平行断言
 * 随下沉删除——映射契约唯一断言面 = 本目录 legacy-entries.test.ts。
 *
 * 范围注记：本模块只承载 lifecycle/resumeHint 两个跨包映射；templateProvidedPath 等其余旧
 * 字段映射仍留扩展读侧（extension 域私有，无第二消费方，无跨包单源诉求）。
 *
 * 纯数据 + 纯函数，零依赖（仅同包 state-machine 值域），与 state-machine.ts（纯契约模块）
 * 刻意分文件——legacy 读取规则有自己的退役时钟，不混入长期契约面。
 */
import { PLAN_LIFECYCLE_STATES } from './state-machine'
import type { PlanLifecycleState } from './state-machine'

/**
 * plan-state entry 的 customType（pi appendEntry custom entry 判别键）。磁盘形态冻结：
 * 扩展写侧 persistPlanState 以同字面量落盘（两侧独立表达式，值域单源在本常量），
 * runtime 投影链（plan-state-extractor / session-records）经包出口消费——改字面量即
 * 历史会话全部失联，禁改。
 */
export const PLAN_STATE_CUSTOM_TYPE = 'plan-state'

/**
 * 生命周期状态读取（D2 读方①②共用映射，原扩展 state.ts / runtime extractor 内联拷贝的
 * 单源归并）：
 * ① 新字段直读（值域守卫：PLAN_LIFECYCLE_STATES 之外的垃圾值按缺失处理，落映射——
 *    不信任外部写入）；
 * ② 旧 entry 无 state（或垃圾 state）时映射 reviewState（awaiting→reviewing /
 *    revising→revising / 其余值→planning|idle 按 isActive）。
 */
export function readLifecycleState(
  data: { state?: unknown; reviewState?: unknown },
  isActive: boolean,
): PlanLifecycleState {
  const raw = data.state
  if (typeof raw === 'string' && (PLAN_LIFECYCLE_STATES as readonly string[]).includes(raw)) {
    return raw as PlanLifecycleState
  }
  if (data.reviewState === 'awaiting') return 'reviewing'
  if (data.reviewState === 'revising') return 'revising'
  return isActive ? 'planning' : 'idle'
}

/**
 * resumeHint 读取（D2 读方①②共用映射）：新字段直读（只认 'resubmit' 一字面量）+
 * 旧 reviewStateSource 同义映射（'explain' 等存量值归无值——explain 交互已删）；
 * resumeHint 存在但非法（垃圾值）时不挡 reviewStateSource 映射（与原两份拷贝逐字同构）。
 */
export function readResumeHint(
  data: { resumeHint?: unknown; reviewStateSource?: unknown },
): 'resubmit' | undefined {
  if (data.resumeHint === 'resubmit') return 'resubmit'
  return data.reviewStateSource === 'resubmit' ? 'resubmit' : undefined
}
