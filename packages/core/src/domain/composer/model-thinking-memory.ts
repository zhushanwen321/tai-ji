/**
 * 模型档位记忆存储 —— 「provider/modelId → 最后使用的 UI 档位」偏好表
 * （设计文档 docs/design/model-thinking-level-memory.md §3.4）。
 *
 * 本模块只提供存储原语：模块级 reactive Map 内存表 + 惰性异步预载 + KV 写穿；
 * 「仅已建态记录」等写入门禁是下游（model-thinking 记录点 onThinkingSelect）的职责。
 * 表值是 UI key（ThinkingLevel 枚举，D1——跨模型恢复的语义是档位名而非实现值）；
 * 表键是 provider/modelId 复合串、全局一份（D6，多 composer 实例共享）。
 *
 * 持久化生命周期（三态预载 / 加载完成回调 / 加载窗口守卫 / deferred 补写 / 写穿串行链）
 * 由 foundation createKVSlot 收编（state-truth-sync §3.3 D9 KV 单键族）；本模块保留：
 * - 内存容器（reactive Map，reactive 使下游 watch 记忆变化成为可能）
 * - 值域差异钩子：record 侧 E6 枚举校验（validate）/ 加载侧 isPlainObject 形状门
 *   （parseSnapshot）+ 逐条 E6 过滤与「内存已有值优先」窗口守卫（mergeSnapshot）
 *
 * 错误规格（设计 §3.4 错误规格表）：
 * - E1  KV 读失败 / JSON 损坏 → 空表启动（factory catch 回退，不抛不吞，对齐 system-storage ES2 范式）
 * - E2  KV 写失败 → console.warn，内存表不回滚（本次运行内记忆仍生效，重启后丢）
 * - E6  非法档位值（非 ThinkingLevel 枚举）→ 丢弃该条（record 拦截 + 加载时过滤）
 * - E7② onLoaded：加载完成回调（完成后注册立即同步触发），供下游在加载完成时补一次重设
 *
 * KV 经 getPlatform().storage（KVStorage 接口，platform/port），core 零 localStorage 直连
 * （W3 迁移约束，同 system-storage）。
 */
import { reactive } from 'vue'
import { createKVSlot } from '../../foundation/create-kv-slot'
import { isThinkingLevel, type ThinkingLevel } from './thinking-levels'

/** localStorage key（对齐 `taiji:system-settings` 命名，设计 §3.4）。 */
export const MODEL_THINKING_MEMORY_KEY = 'taiji:model-thinking-memory'

/**
 * 内存表：模块级单例（多 composer 实例 / split panel 共享，D6）。
 * reactive 使下游 watch 记忆变化成为可能；本模块自身不建立 watch。
 */
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，已登记 data-source-registry #28（原 #22，2026-09-07 重号修复改号）非草稿）：模型档位记忆表单例（UI 偏好内存镜像，权威源 = KVStorage 持久化整表，12 类未覆盖）
const memory = reactive(new Map<string, ThinkingLevel>())

/**
 * KV 单键槽位：持久化生命周期收编于 createKVSlot（D9）。本键的 KV 值形态 =
 * 整表 JSON（Record<复合串, ThinkingLevel>）——「单键」指 localStorage 单键存整个表。
 */
const slot = createKVSlot<Record<string, unknown>>(MODEL_THINKING_MEMORY_KEY, {
  tag: 'model-thinking-memory',
  // E6 加载侧第一道：整值必须是 plain object（数组/字符串/null 与损坏 JSON 同等对待）
  parseSnapshot: (parsed) => (isPlainObject(parsed) ? parsed : undefined),
  mergeSnapshot: (table) => {
    for (const [modelId, level] of Object.entries(table)) {
      // E6：非法档位条目丢弃；内存已有值优先（加载窗口内的 record 比在途 KV 快照新，不被覆写）
      if (typeof level === 'string' && isThinkingLevel(level) && !memory.has(modelId)) {
        memory.set(modelId, level)
      }
    }
  },
  serialize: () => {
    const table: Record<string, string> = {}
    for (const [modelId, level] of memory.entries()) table[modelId] = level
    return JSON.stringify(table)
  },
  // E6 record 侧：存储层最后一道值域防线（非法档位内存与 KV 均不写）
  validate: (level) => typeof level === 'string' && isThinkingLevel(level),
})

/**
 * 触发惰性预载（fire-and-forget，幂等：重复调用不重复读 KV）。
 * 由首个消费方组装时调用（model-thinking 组装点，域内收编见 impl-plan 偏差 #10）；加载完成前 lookup 返回
 * undefined（E7①「无记忆」，下游自然回落现有对齐规则）。
 */
export function loadOnce(): void {
  slot.loadOnce()
}

/**
 * 同步查记忆：读内存 Map，未加载或无记录返回 undefined。
 * 返回的是 UI key（ThinkingLevel），可用性校验由下游按新模型 supportedLevels 做（D5）。
 */
export function lookup(modelId: string): ThinkingLevel | undefined {
  return memory.get(modelId)
}

/**
 * 写一条记忆：同步写内存 + 异步写穿 KV（整表序列化）。
 * level 非法（非 ThinkingLevel 枚举）直接丢弃（E6）——存储层是最后一道值域防线。
 * KV 写失败仅 console.warn，内存不回滚（E2）。
 */
export function record(modelId: string, level: string): void {
  slot.record(level, () => {
    // E6 拒绝路径已由 slot 配置的 validate 前置（拒绝则本 write 不被调用）；
    // 此处 isThinkingLevel 仅做 string → ThinkingLevel 的类型收窄（运行时恒真）
    if (isThinkingLevel(level)) memory.set(modelId, level)
  })
}

/**
 * 注册加载完成回调（E7②）：供下游在 KV 预载完成时补一次重设
 * （landing memory-aware 跟随窗口兜底）。加载已完成则立即同步触发。
 */
export function onLoaded(cb: () => void): void {
  slot.onLoaded(cb)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 仅测试用：重置模块级状态（内存表 / 加载状态 / 回调 / 挂起写 / 写链），跨用例隔离。 */
export function __resetModelThinkingMemoryForTesting(): void {
  memory.clear()
  slot.__resetForTesting()
}
