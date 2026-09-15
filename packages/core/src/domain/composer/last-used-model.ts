/**
 * lastUsedModel KV 单键存储 —— 用户最后显式选择的模型（landing 新任务默认模型）。
 *
 * 设计 state-truth-sync-architecture.md §3.3 D2/D4：landing 新任务默认模型链的
 * lastUsedModel 档（D2 model 链第三档，消费前经 D4 有效性校验；显式记录，跨重启成立）。
 * 写点 = onModelSelect 非 staging 分支（用户显式选模型时写入）；staging 试选不写。
 *
 * 持久化生命周期（三态预载 / 加载完成回调 / 加载窗口守卫 / deferred 补写 / 写穿串行链）
 * 由 foundation createKVSlot 收编（state-truth-sync §3.3 D9 KV 单键族）；本模块保留：
 * - 内存容器（ref 单值——响应式使下游 computed（model-thinking regularModelId 经 lookup）
 *   对 KV 预载完成建立依赖，冷启动 KV 值到达时 chip 自动脱离 defaultModel）
 * - 值域差异钩子：无 validate（任意字符串模型 id 皆可记）；parseSnapshot 只认字符串形状
 *
 * KV 经 getPlatform().storage（KVStorage 接口，platform/port），core 零 localStorage 直连
 * （W3 迁移约束，同 model-thinking-memory / system-storage）。
 *
 * 错误规格（对齐 state-truth-sync-architecture.md 的 D10-E1——KV 读失败/损坏回落下一
 * 优先级；注意其 E4 是另一条「默认预设指向已删 id 兜底 builtin:full」，不适用本键）：
 * - KV 读失败 / JSON 损坏 / 非字符串 → undefined（factory catch 回退 + parseSnapshot 形状门，
 *   不抛不吞；下游 resolve 回落下一优先级档）
 * - KV 写失败 → console.warn，内存值不回滚（本次运行内仍生效，重启后丢）
 */
import { ref } from 'vue'
import { createKVSlot } from '../../foundation/create-kv-slot'

/** localStorage key（对齐 model-thinking-memory 命名空间）。 */
export const LAST_USED_MODEL_KEY = 'taiji:last-used-model'

/**
 * 内存缓存：模块级单例 ref（同 model-thinking-memory 的 reactive 先例）。
 * 响应式使下游 computed（model-thinking regularModelId 经 lookup）对 KV 预载
 * 完成建立依赖——冷启动 KV 值到达时 chip 自动脱离 defaultModel。
 */
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态）：lastUsedModel 内存镜像单例
const cachedValue = ref<string | undefined>(undefined)

/** KV 单键槽位：持久化生命周期收编于 createKVSlot（D9）。本键的 KV 值形态 = 单值 JSON 字符串。 */
const slot = createKVSlot<string>(LAST_USED_MODEL_KEY, {
  tag: 'last-used-model',
  // 形状门：合法 JSON 但非字符串（数组/对象/null）→ 按空启动（undefined）
  parseSnapshot: (parsed) => (typeof parsed === 'string' ? parsed : undefined),
  mergeSnapshot: (value) => {
    // 加载窗口守卫：内存已有值时在途 KV 快照不得覆写——加载窗口内的 record 比快照新，
    // 覆写后 deferred 补写会把 KV 旧值落盘（双丢）
    if (cachedValue.value === undefined) {
      cachedValue.value = value
    }
  },
  serialize: () => JSON.stringify(cachedValue.value),
})

/**
 * 触发惰性预载（fire-and-forget，幂等）。
 * 由 model-thinking 组装时调用。加载完成前 lookup 返回 undefined。
 */
export function loadOnce(): void {
  slot.loadOnce()
}

/**
 * 同步查记忆：返回最后显式选择的模型 id，未加载或无记录返回 undefined。
 */
export function lookup(): string | undefined {
  return cachedValue.value
}

/**
 * 写记忆：同步写内存 + 异步写穿 KV。
 * KV 写失败仅 console.warn，内存不回滚（best-effort 写穿，见文件头错误规格）。
 */
export function record(modelId: string): void {
  slot.record(modelId, () => {
    cachedValue.value = modelId
  })
}

/**
 * 注册加载完成回调：供 downstream 在 KV 预载完成时补一次读取。
 * 加载已完成则立即同步触发。
 */
export function onLoaded(cb: () => void): void {
  slot.onLoaded(cb)
}

/** 仅测试用：重置模块级状态。 */
export function __resetLastUsedModelForTesting(): void {
  cachedValue.value = undefined
  slot.__resetForTesting()
}
