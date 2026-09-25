/**
 * 乐观更新协议 —— 「乐观写本地 → await 持久化 → 失败回滚」的唯一实现（C5 归一）。
 *
 * 回滚语义唯一：失败时先还原本地状态，再 **rethrow**——协议自身不做吞错、不做返回值编码、
 * 不置错误标志。调用方把错误映射到既有错误面（toast / actionError / saveError 标志驱动的
 * 镜像回弹），用户可见行为保持逐点不变。
 *
 * 两种形态：
 * - {@link runOptimisticUpdate}（通用）：快照捕获 / 乐观写 / 失败还原由 ops 显式声明
 *   （快照还原、逆操作、异步强拉权威值皆可；快照须在 apply 内或调用前捕获）。
 * - {@link optimisticUpdate}（值单元）：快照 / 还原由协议持有（{@link refCell} 包装响应式值），
 *   调用方只声明「下一个值 + 持久化」。
 *
 * 典型调用面（收编前各处手写「快照→改→await→catch 回滚」）：settings-store.setSystem、
 * useScopedModels add/remove/move、useApiKeyAutoEnable.onToggleEnabled、usePiPresets
 * setDefault/create/update、RPC 设置项字段 module（setting-field）与各 System Section、
 * extension toggle 双组件（ExtensionActions 启用开关 / ExtensionDetail autoUpgrade）、
 * useQuotaConfigure.setEnabled（envelope ok:false 转 throw 走同一回滚语义）。
 */
import type { Ref } from 'vue'

/** 通用乐观更新操作面（apply/rollback/commit 三步编排归本协议）。 */
export interface OptimisticUpdateOps<R> {
  /** 乐观写本地状态（协议在 commit 前调用；可同时捕获回滚快照）。 */
  apply(): void
  /** 失败还原：快照还原 / 逆操作 / 强拉权威值（异步还原会被 await 后再 rethrow）。 */
  rollback(): void | Promise<void>
  /** 持久化 RPC；resolve 值原样透传（权威回填由调用方写回）。 */
  commit(): Promise<R>
}

/**
 * 执行乐观更新：apply → commit；失败 rollback 后 rethrow（失败传播唯一语义）。
 */
export async function runOptimisticUpdate<R>(ops: OptimisticUpdateOps<R>): Promise<R> {
  ops.apply()
  try {
    return await ops.commit()
  } catch (e) {
    await ops.rollback()
    throw e
  }
}

/** 可快照/可还原的本地值单元（值单元形态的回滚锚点）。 */
export interface OptimisticCell<T> {
  read(): T
  write(next: T): void
}

/** 把响应式值（vue Ref 形状）包装为值单元。 */
export function refCell<T>(source: Ref<T>): OptimisticCell<T> {
  return {
    read: () => source.value,
    write: (next) => {
      source.value = next
    },
  }
}

/**
 * 值单元形态：协议持有快照（写前 read）→ 乐观写 next → commit；失败还原快照后 rethrow。
 * commit 的 resolve 值原样返回，权威回填由调用方写回。
 */
export async function optimisticUpdate<T, R>(
  cell: OptimisticCell<T>,
  next: T,
  commit: (applied: T) => Promise<R>,
): Promise<R> {
  const previous = cell.read()
  return runOptimisticUpdate({
    apply: () => {
      cell.write(next)
    },
    rollback: () => {
      cell.write(previous)
    },
    commit: () => commit(next),
  })
}
