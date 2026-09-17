/**
 * useProjectSkills / useGlobalSkills —— skill 命令源 composable（W4，cw-2026-07-21-fix-ask-user-ime）。
 *
 * W4 改动：
 * - useProjectSkills 改调 configApi.getProjectSkills(cwd)（走 skillRegistry projectCache，带 watcher），
 *   替代原 configApi.scanSessionSkills(cwd)（无缓存直调 configService.loadSkills）。
 * - 新增 useGlobalSkills()：模块级 singleton 缓存，启动拉一次全局 skill（skillRegistry globalCache），
 *   供 landing slash 命令源（FR-5：不再走 settingsStore.skills 配置态扫描）。
 *
 * Wave3 改动（订阅 skill 缓存失效信号）：
 * - useGlobalSkills 订阅 config.skillCacheInvalidated scope='global' → loadGlobal(true) force 重拉。
 *   修复原永久失败 bug：catch 分支不再置 globalLoaded=true，保留旧缓存值，允许下次失效信号触发重试。
 * - useProjectSkills 用模块级失效信号机制：scope='project' 信号 → 携带 cwd 的 signal → 各实例 watch
 *   清自己的 skillsByCwd（有 cwd 只清该分区，无 cwd 保守清所有）+ 重拉当前 cwd。signal 是模块级 ref，
 *   所有实例共享一份订阅（避免每个 Composer 实例重复挂订阅）。
 *
 * PR #123 review fix（B1/W4/W3/W2/S1/S3）：
 * - B1：globalSkills ref 提升为模块级单例，所有 useGlobalSkills() 调用共享同一份。修复 Composer 重挂后
 *   新实例拿到新 ref、失效信号仍写首个实例旧 ref 导致活跃 Composer 不刷新的 bug。
 * - W4：loadFor catch 不写空数组到 cache，失败后 cache miss 仍在，watch/失效信号可重试（修复 project 侧永久失败）。
 * - W3：project 失效信号尊重 payload.cwd，有 cwd 只清该分区，无 cwd（setSkillDirs 全局配置变更）才保守清所有。
 * - W2：loadGlobal force 重拉用 pendingForceReload 合并并发 force，避免快速触发 N 次失效信号串联 N 次 RPC。
 * - S1：projectInvalidateSubscribed 守卫移除（模块顶层只执行一次，守卫冗余）。
 * - S3：useGlobalSkills() 首次拉取用 if (!globalLoaded) 守卫，意图明确。
 *
 * 设计取舍：
 * - useGlobalSkills 用模块级 singleton（cache + loaded flag + 模块级 globalSkills ref）：全局 skill 是
 *   AppShell 级数据，所有 landing CommandPopover 共享一份。首次调用触发 RPC，后续命中缓存。runtime 侧
 *   SkillRegistry 有 chokidar watcher 自动刷新 globalCache，wave3 起前端订阅 config.skillCacheInvalidated
 *   信号实时重拉。globalSkills 为模块级 ref 保证 Composer 重挂后失效信号仍刷新活跃实例。
 * - useProjectSkills 保持实例级 Map<cwd, SkillInfo[]>（按 cwd key 隔离，切 cwd 切分区）。
 *   当前唯一消费者是 landing Composer（单例活跃），per-instance 缓存足够。
 * - 失效信号订阅在模块顶层挂载（只执行一次），project 侧用模块级 signal watch 让订阅与实例数解耦。
 */
import { computed, ref, watch, type Ref } from 'vue'
import { createInflightDedup } from '@taiji/core/foundation/create-inflight-dedup'
import { config as configApi } from '@/api'
import type { SkillCacheInvalidatedPayload, SkillInfo } from '@taiji/shared'

// ── useProjectSkills 失效信号（模块级，所有实例共享）─────────────
// 收到 scope='project' 失效信号时推进 version 并携带 cwd：
// - 有 cwd（磁盘 watcher 触发的具体项目目录变更）：只清该 cwd 分区。
// - 无 cwd（setSkillDirs 改全局配置，所有 cwd 都可能受影响）：保守清所有。
// S1：模块顶层只执行一次，无需 projectInvalidateSubscribed 守卫。
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，12 类未覆盖存量，登记草稿）：skills 失效信号版本号（watch 驱动重拉，12 类未覆盖）
const projectInvalidateSignal = ref<{ version: number; cwd?: string }>({ version: 0 })
configApi.onSkillCacheInvalidated((payload: SkillCacheInvalidatedPayload) => {
  if (payload.scope === 'project') {
    projectInvalidateSignal.value = {
      version: projectInvalidateSignal.value.version + 1,
      cwd: payload.cwd,
    }
  }
})

/**
 * @param currentCwd 当前 session/landing 的 cwd ref（null = 未选目录，projectSkills 为空）
 * @returns projectSkills：当前 cwd 对应的项目 skill（computed，切 cwd 自动切换分区）
 */
export function useProjectSkills(currentCwd: Ref<string | null>) {
  // 按 cwd 缓存的项目 skill 表（cwd → SkillInfo[]）。实例级 state（每次 useProjectSkills 调用新建），
  // 命中缓存不重复 RPC，避免闪烁 + 省 RPC。消费者是各 Composer 实例（landing 单例 + panel
  // per-session——split mode 多 panel 多实例，同 cwd 各自缓存各拉一次，失效信号逐实例刷新）；
  // 未来需要跨实例共享再提升到模块级或 store。
  const skillsByCwd = ref<Map<string, SkillInfo[]>>(new Map())
  // R3（review fix）：in-flight 去重。cwd 快速切 A→B→A 时，若 A 的 RPC 仍 pending，
  // 没有 in-flight 标记会重复触发 loadFor(A)。Set 记录 pending cwd，RPC 完成后删除。
  const inFlight = new Set<string>()

  const projectSkills = computed<SkillInfo[]>(() => {
    const cwd = currentCwd.value
    if (!cwd) return []
    return skillsByCwd.value.get(cwd) ?? []
  })

  /**
   * 拉取某 cwd 的 project skill 并写缓存（best-effort：RPC 失败不崩）。
   * W4：catch 不写空数组到 cache，失败后 cache miss 仍在，下次 watch/失效信号触发会重试
   * （修复原永久失败 bug：原 catch 写空数组导致 has(cwd) 命中、watch 守卫永不重试）。
   */
  async function loadFor(cwd: string): Promise<void> {
    inFlight.add(cwd)
    try {
      const skills = await configApi.getProjectSkills(cwd)
      const next = new Map(skillsByCwd.value)
      next.set(cwd, skills)
      skillsByCwd.value = next
    } catch (e) {
      // 不写 cache：失败后 cache miss 仍在，下次 watch/失效信号触发会重试
      console.warn(`[useProjectSkills] getProjectSkills failed for cwd=${cwd}, will retry on next trigger:`, e)
    } finally {
      inFlight.delete(cwd)
    }
  }

  // watch currentCwd：变化时按需拉取（缓存命中跳过）。immediate 触发初始 cwd 的拉取。
  // R3：in-flight cwd 也跳过（RPC pending 中不重复触发）。
  watch(
    currentCwd,
    (cwd) => {
      if (!cwd) return // null cwd 不 RPC
      if (skillsByCwd.value.has(cwd)) return // 缓存命中，不重复 RPC
      if (inFlight.has(cwd)) return // RPC pending 中，不重复触发
      void loadFor(cwd)
    },
    { immediate: true },
  )

  // 监听模块级失效信号：signal 变 → 按是否带 cwd 选择性清缓存 → 重拉当前 cwd
  watch(projectInvalidateSignal, (signal) => {
    if (signal.cwd) {
      // 有具体 cwd（磁盘 watcher 触发的项目目录变更）：只清该分区
      if (skillsByCwd.value.has(signal.cwd)) {
        const next = new Map(skillsByCwd.value)
        next.delete(signal.cwd)
        skillsByCwd.value = next
      }
      // 只在当前 cwd 正是受影响 cwd 时重拉
      const currentC = currentCwd.value
      if (currentC === signal.cwd && !inFlight.has(currentC)) {
        void loadFor(currentC)
      }
    } else {
      // 无 cwd（setSkillDirs 全局配置变更）：保守清所有分区
      skillsByCwd.value = new Map()
      const currentC = currentCwd.value
      if (currentC && !inFlight.has(currentC)) {
        void loadFor(currentC)
      }
    }
  })

  return { projectSkills }
}

// ── useGlobalSkills：模块级 singleton 缓存 ──────────────────────────
// 全局 skill 是 AppShell 级数据，所有 landing CommandPopover 共享一份。模块级 singleton 保证
// 首次调用触发一次 RPC，后续命中缓存。Wave3 改造：订阅 config.skillCacheInvalidated 失效信号，
// 收到 scope='global' 时 force 重拉（runtime 侧 SkillRegistry 已重扫 globalCache）。
// B1：globalSkills 提升为模块级 ref，所有 useGlobalSkills() 调用共享同一份，修复 Composer 重挂后
// 失效信号仍写旧实例 ref 导致活跃 Composer 不刷新的 bug。
let globalSkillsCache: SkillInfo[] | null = null
let globalLoaded = false
// W2 收编：原单 Promise 变量 globalInFlight 改为 createInflightDedup 固定 key 退化形态
// （state-truth-sync §3.3 D9）——同 key 复用 / settle 即清（等价原 finally 置 null，且
// settle 清理先于调用方 await 恢复，force fall-through 重拉必发起新 RPC）/ 引用比对防
// 误删由 factory 内建。
const GLOBAL_SKILLS_FETCH_KEY = 'global'
const globalSkillsFetchDedup = createInflightDedup<SkillInfo[]>()
// 模块级单例 ref，所有 useGlobalSkills() 调用共享
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，12 类未覆盖存量，登记草稿）：全局 skills 列表单例 ref（多 Composer 共享，12 类未覆盖）
const globalSkills = ref<SkillInfo[]>([])
// W2：force 重拉合并标志。多个 force 调用并发等待同一个 in-flight 时，只有第一个执行新 RPC。
let pendingForceReload = false
/** 模块级订阅守卫：保证 onSkillCacheInvalidated(global) 只挂一次（AppShell 级常驻订阅）。 */
let globalInvalidateSubscribed = false

/**
 * 拉取全局 skill（skillRegistry globalCache）。模块级 singleton：
 * - 首次调用触发 configApi.getGlobalSkills() RPC，结果缓存到 globalSkillsCache + 写入模块级 globalSkills ref。
 * - 后续调用命中缓存，返回同一份模块级 ref（响应式，所有实例共享）。
 * - in-flight 去重：并发调用共享同一个 Promise，避免重复 RPC。
 * - force=true 跳过 globalLoaded 守卫强制重拉（失效信号触发）。W2：并发 force 用 pendingForceReload
 *   合并，N 次快速失效信号只触发一次新 RPC（首个 force 执行，后续 force 看到标志已清则直接 return）。
 * - 失败时不置 globalLoaded=true（修复原永久失败 bug），保留旧缓存值允许下次失效信号触发重试。
 *
 * 供 landing slash 命令源（FR-5：不走 settingsStore.skills）。
 */
export function useGlobalSkills() {
  // B1：模块级 ref 与 cache 同步（首次调用或 cache 已被其他实例填充时）。
  // loadGlobal 内部已会写 globalSkills.value，此块兜底 cache 在本次调用之前已被填充的边缘情况。
  if (globalSkills.value.length === 0 && globalSkillsCache && globalSkillsCache.length > 0) {
    globalSkills.value = globalSkillsCache
  }

  /**
   * 发起或复用全局 skill 拉取（固定 key 单键退化形态）。失败时不置 globalLoaded=true
   * （修复原永久失败 bug），保留旧缓存值允许下次重试；promise 永不 reject（吞错返回
   * 旧缓存），并发复用者共享同一次 RPC。
   */
  function runGlobalSkillsFetch(): Promise<SkillInfo[]> {
    return globalSkillsFetchDedup.run(GLOBAL_SKILLS_FETCH_KEY, async () => {
      try {
        const skills = await configApi.getGlobalSkills()
        globalSkillsCache = skills
        globalLoaded = true
        globalSkills.value = skills
        return skills
      } catch (e) {
        // 失败时不置 globalLoaded=true（允许下次失效信号触发重试），保留旧缓存值
        console.warn('[useGlobalSkills] getGlobalSkills failed, will retry on next trigger:', e)
        globalSkills.value = globalSkillsCache ?? []
        return globalSkillsCache ?? []
      }
    }).promise
  }

  /**
   * 拉取全局 skill。force=true 跳过 globalLoaded 守卫强制重拉（失效信号触发）。
   * W2：force 并发合并语义（pendingForceReload 标志）留调用方——多个 force 调用等待
   * 同一 in-flight 时，只有第一个执行新 RPC。
   */
  async function loadGlobal(force = false): Promise<void> {
    if (globalLoaded && !force) {
      // globalSkills 已是模块级，无需重新赋值
      return
    }
    if (globalSkillsFetchDedup.has(GLOBAL_SKILLS_FETCH_KEY)) {
      if (!force) {
        await runGlobalSkillsFetch()
        // globalSkills 已是模块级，in-flight 完成后已更新
        return
      }
      // force=true：标记待重拉，等待当前 in-flight 完成后只重拉一次（合并多次并发 force）
      pendingForceReload = true
      await runGlobalSkillsFetch()
      // await 后重新检查：多个 force 可能都在等同一个 in-flight，已被另一个 force 接管则直接 return
      if (!pendingForceReload) return
      pendingForceReload = false
      // 继续往下执行新 RPC（factory settle 即清先于本 await 恢复，此刻表已空）
    }
    await runGlobalSkillsFetch()
  }

  // S3：仅在未加载时触发首次拉取（意图明确，重挂时不发起多余异步调用）
  if (!globalLoaded) {
    void loadGlobal()
  }

  // 订阅失效信号（模块级，只挂一次）。收到 scope='global' 时强制重拉。
  if (!globalInvalidateSubscribed) {
    globalInvalidateSubscribed = true
    configApi.onSkillCacheInvalidated((payload: SkillCacheInvalidatedPayload) => {
      if (payload.scope === 'global') {
        void loadGlobal(true)
      }
    })
  }

  return { globalSkills }
}
