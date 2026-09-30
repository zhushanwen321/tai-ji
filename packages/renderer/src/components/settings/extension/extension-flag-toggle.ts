import { ref } from 'vue'
import { runOptimisticUpdate } from '@taiji/core/foundation/optimistic-update'

/** 单次开关切换的操作面：enabled / autoUpgrade 两个调用方各自注入（语义不同，共用编排）。 */
export interface ExtensionFlagToggleOps<T> { // oe-exempt:20260930:framework:两组件（ExtensionActions/ExtensionDetail）注入的 ops 参数契约
  /** store 侧协议原语 setter（写入并返回旧值——apply 内顺带捕获回滚快照） */
  setFlag: (value: boolean) => boolean
  /** 持久化 RPC（commit；resolve 值透传给 onSuccess） */
  persist: () => Promise<T>
  /** commit 成功后回调（如用 reply 的权威扫描结果刷新列表），在 try 内同步执行 */
  onSuccess?: (reply: T) => void
  /** rethrow 的失败错误 → 就近错误文案 */
  formatError: (e: unknown) => string
}

/**
 * extension 布尔开关的乐观切换编排（ExtensionActions「启用」/ ExtensionDetail「自动升级」共用）。
 *
 * 编排走乐观更新协议（runOptimisticUpdate：apply 乐观写 store → commit 持久化 → 失败
 * rollback 后 rethrow）；本地只把 rethrow 的错误映射到既有错误面（error ref），不手写
 * try/catch 回滚。toggling 集合防双击（API 期间 disable Switch）。广播回来时权威值
 * 覆盖 store（幂等：若值一致无副作用）。
 */
export function useOptimisticExtensionFlagToggle() {
  /** 开关切换中（防双击：API 期间 disable Switch） */
  const toggling = ref<Set<string>>(new Set())
  /** 操作失败信息（就近显示在开关/操作区下方） */
  const error = ref('')

  async function toggleFlag<T>(
    name: string,
    value: boolean,
    ops: ExtensionFlagToggleOps<T>,
  ): Promise<void> {
    if (toggling.value.has(name)) return
    error.value = ''
    // 防双击
    const next = new Set(toggling.value)
    next.add(name)
    toggling.value = next
    try {
      let old = false
      const reply = await runOptimisticUpdate({
        apply: () => {
          old = ops.setFlag(value)
        },
        rollback: () => {
          ops.setFlag(old)
        },
        commit: () => ops.persist(),
      })
      ops.onSuccess?.(reply)
    } catch (e) {
      error.value = ops.formatError(e)
    } finally {
      const after = new Set(toggling.value)
      after.delete(name)
      toggling.value = after
    }
  }

  return { toggling, error, toggleFlag }
}
