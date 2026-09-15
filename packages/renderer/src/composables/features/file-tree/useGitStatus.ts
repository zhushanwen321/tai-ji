/**
 * useGitStatus —— cwd 的 git 状态数据层（panel/spec.md git 进抽屉后唯一数据源）。
 *
 * 架构定位：原 GitZone.vue（底部 zone ⑤）内联的数据逻辑下沉为此 composable。
 * git 全量状态 UI 现位于 SideDrawer git tab（GitPanel.vue），PanelHeader 右侧
 * git 图标按钮承载入口 + 脏状态点。两处需共享同一份数据（抽屉内 stage 后 header
 * 点须同步更新），故由 Panel.vue 持有唯一实例，经 provide/inject（GIT_STATUS_KEY）
 * 共享给 GitPanel——避免双实例的 stale 隐患（stage/unstage 仅刷新自己实例）。
 *
 * 数据源：api git.status（real 走 transport，mock 走 fixture）。刷新时机（G-R2-04）：
 * 进入 session + agent_end 后 + stage/unstage/commit 操作后手动刷（非轮询）。
 * 非 git 仓库（isRepo=false）→ result.isRepo=false，调用方据此自隐藏。
 *
 * 四态派生（优先级 conflict > dirty > staged > clean）与原 GitZone 一致。
 *
 * 订阅收口（R2）：message.complete 订阅经 useSessionEvents（与 SideDrawer/CommandPopover/
 * ContextCapacityPopover 同收口），不再直接 import @/api/events。依赖方向：shared 类型 + api(git)
 * + useSessionEvents。与 useChat/useSidebar 同属 features 层，但比它们轻——不触碰 stores，纯 per-session 数据 ref。
 *
 * per-session 状态隔离（ADR-0049）：result/commitMsg/error 三个 per-session 状态
 * 收进 useSessionScopedState 分区。切 session 时分区天然隔离（新 sid 读到 init 默认值），
 * 不再依赖 watch 手动清空（watch 清理派反模式）。pending 是 transient UI guard（阻塞
 * 重复点击），不按 session 分区。
 */
import { ref, computed, watch, inject, provide, reactive, type InjectionKey, type Ref, type ComputedRef } from 'vue'
import { git as gitApi } from '@/api'
import { useSessionEvents } from '@/composables/features/chat/useSessionEvents'
import { useSessionScopedState } from '@/composables/useSessionScopedState'
import type { GitStatusResult } from '@taiji/shared'

/** git 四态（优先级 conflict > dirty > staged > clean） */
export type GitState = 'conflict' | 'dirty' | 'staged' | 'clean'

/** header 脏状态点所需的精简指示（hasRepo=false 时整块不渲染） */
export interface GitIndicator {
  hasRepo: boolean
  hasChanges: boolean
  dirty: boolean
  conflict: boolean
}

/** useGitStatus 返回形状 —— 供 InjectionKey 类型锁定 */
export interface UseGitStatusReturn {
  result: Ref<GitStatusResult | null>
  state: ComputedRef<GitState>
  indicator: ComputedRef<GitIndicator>
  pending: Ref<boolean>
  error: Ref<string>
  commitMsg: Ref<string>
  canCommit: ComputedRef<boolean>
  refresh: () => Promise<void>
  stageAll: () => Promise<void>
  unstageAll: () => Promise<void>
  commit: () => Promise<void>
}

/** provide/inject key：PanelContainer 持有唯一实例（跟随 active panel 的 session）→ GitPanel 注入 */
export const GIT_STATUS_KEY: InjectionKey<UseGitStatusReturn> = Symbol('git-status')

/** per-session 分区容器（reactive 容器契约，ADR-0049 响应式要求） */
interface GitStatusPartition {
  result: GitStatusResult | null
  commitMsg: string
  error: string
}

/**
 * @param sessionIdRef session 标识（ref 或 getter），变化时重置并重订阅 message.complete
 */
export function useGitStatus(sessionIdRef: Ref<string | null> | (() => string | null)): UseGitStatusReturn {
  const getSessionId = typeof sessionIdRef === 'function' ? sessionIdRef : () => sessionIdRef.value

  // sid ref：复用文件内既有 sessionIdRefForEvents（声明上移到工厂调用之前）。
  // useSessionScopedState 要求 Ref<string|null>；getter 模式经 computed 归一。
  const sidRef = computed(() => getSessionId())

  // per-session 分区（ADR-0049：Map 分区范式，替代 watch 清理派）。
  // init 惰性初始化：每个新 sid 首次访问时创建 reactive 容器。
  const scoped = useSessionScopedState<GitStatusPartition>(sidRef, () =>
    reactive<GitStatusPartition>({ result: null, commitMsg: '', error: '' }),
  )

  // pending 是 transient UI guard（阻塞重复点击），不按 session 分区——
  // 它随组件实例生命周期，非 per-session 业务状态。
  const pending = ref(false)

  /** 四态派生（优先级 conflict > dirty > staged > clean） */
  const state = computed<GitState>(() => {
    if (!scoped.current.value.result) return 'clean'
    if (scoped.current.value.result.hasConflict) return 'conflict'
    if (scoped.current.value.result.unstagedCount > 0) return 'dirty'
    if (scoped.current.value.result.stagedCount > 0) return 'staged'
    return 'clean'
  })

  /** header 脏状态点指示（hasRepo=false → 整块不渲染；clean → 无点） */
  const indicator = computed<GitIndicator>(() => {
    const r = scoped.current.value.result
    if (!r || !r.isRepo) return { hasRepo: false, hasChanges: false, dirty: false, conflict: false }
    return {
      hasRepo: true,
      hasChanges: r.stagedCount > 0 || r.unstagedCount > 0,
      dirty: r.unstagedCount > 0,
      conflict: r.hasConflict,
    }
  })

  /** 可提交：非冲突 + 非空 message + 非 pending（runtime 要求非空 message） */
  const canCommit = computed(
    () => !pending.value && !scoped.current.value.result?.hasConflict && scoped.current.value.commitMsg.trim().length > 0,
  )

  // 对外暴露的 Ref 契约：从 current 分区派生 computed ref（读写经 update 桥接）
  const result = computed({
    get: () => scoped.current.value.result,
    set: (v: GitStatusResult | null) => {
      scoped.update((p) => { p.result = v })
    },
  }) as unknown as Ref<GitStatusResult | null>

  const commitMsg = computed({
    get: () => scoped.current.value.commitMsg,
    set: (v: string) => {
      scoped.update((p) => { p.commitMsg = v })
    },
  }) as unknown as Ref<string>

  const error = computed({
    get: () => scoped.current.value.error,
    set: (v: string) => {
      scoped.update((p) => { p.error = v })
    },
  }) as unknown as Ref<string>

  async function refresh(): Promise<void> {
    const sid = getSessionId()
    if (!sid || pending.value) return
    pending.value = true
    // ADR-0049 checklist #3：写入捕获 sid 分区（与 runOp 同范式）——await 期间用户可能切
    // session，读实时 sid 会把 A 的 git 状态写进 B 分区且被 pending 守卫挡住新拉取
    scoped.updateFor(sid, (p) => { p.error = '' })
    try {
      const r = await gitApi.status(sid)
      scoped.updateFor(sid, (p) => { p.result = r })
    } catch (e) {
      scoped.updateFor(sid, (p) => { p.error = e instanceof Error ? e.message : String(e) })
    } finally {
      pending.value = false
    }
  }

  /**
   * 统一操作包装：pending guard + 错误回显 + 成功后刷新 status。
   * 操作期间 sid 快照捕获——异步完成前用户可能切 session，结果写入操作发起时的分区。
   */
  async function runOp(fn: (sid: string) => Promise<void>): Promise<void> {
    const sid = getSessionId()
    if (!sid || pending.value) return
    pending.value = true
    scoped.updateFor(sid, (p) => { p.error = '' })
    try {
      await fn(sid)
      const r = await gitApi.status(sid)
      scoped.updateFor(sid, (p) => { p.result = r })
    } catch (e) {
      scoped.updateFor(sid, (p) => { p.error = e instanceof Error ? e.message : String(e) })
    } finally {
      pending.value = false
    }
  }

  async function stageAll(): Promise<void> {
    await runOp((sid) => gitApi.stage(sid))
  }

  async function unstageAll(): Promise<void> {
    await runOp((sid) => gitApi.unstage(sid))
  }

  async function commit(): Promise<void> {
    if (!canCommit.value) return
    const sid = getSessionId()
    if (!sid) return
    const msg = scoped.current.value.commitMsg.trim()
    await runOp(async (sid) => {
      await gitApi.commit(sid, msg)
      scoped.updateFor(sid, (p) => { p.commitMsg = '' })
    })
  }

  // 切换 session 时刷新——分区天然隔离（新 sid 读到 init 默认值：result=null/commitMsg=''/
  // error=''），不需要手动清空。watch immediate 保持首挂载时拉取。
  watch(
    sidRef,
    () => {
      refresh()
    },
    { immediate: true },
  )

  // agent_end 后刷新（G-R2-04/C14）：agent 改动文件后 git 状态变 stale，回合结束时重拉。
  // 订阅会话级 message.complete（agent 回合结束）经 useSessionEvents 收口——随 sessionId 变化自动
  // 重订（先退订旧 sid 再订新 sid），避免轮询/filesystem watch。getter 模式（PanelContainer 传
  // () => activePanelSessionId.value）用本地 computed 归一为 useSessionEvents 所需的 Ref。
  const onMessage = useSessionEvents(sidRef)
  onMessage('message.complete', () => void refresh())

  return {
    result,
    state,
    indicator,
    pending,
    error,
    commitMsg,
    canCommit,
    refresh,
    stageAll,
    unstageAll,
    commit,
  }
}

/** 便捷封装：在 PanelContainer 提供 git 状态实例（唯一数据源，跟随 active panel 的 session） */
export function provideGitStatus(sessionIdRef: Ref<string | null> | (() => string | null)): UseGitStatusReturn {
  const git = useGitStatus(sessionIdRef)
  provide(GIT_STATUS_KEY, git)
  return git
}

/** GitPanel 注入 git 状态（必填，缺失即调用方装配错误） */
export function useGitStatusOrFail(): UseGitStatusReturn {
  const git = inject(GIT_STATUS_KEY, null)
  if (!git) {
    throw new Error('useGitStatusOrFail: GIT_STATUS_KEY 未注入——GitPanel 必须挂在 PanelContainer 之下')
  }
  return git
}
