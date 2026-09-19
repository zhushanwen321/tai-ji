/**
 * usePiPresets —— pi 启动预设域编排 composable（features 层）。
 *
 * 设计文档：docs/architecture/pi-launch-presets.md
 *
 * 职责（编排，与 useSettings 同构——features 层是跨 api + stores 的唯一合法层）：
 * - loadPresets：并行拉 preset.list + preset.getDefault RPC，写 store（presets + defaultPresetId）。
 * - setDefault：乐观更新 store.defaultPresetId + 调 preset.setDefault RPC。
 * - create / update：乐观 upsert + 用 RPC reply 回写 store（runtime 可能补全 id/order 等字段），失败回滚。
 *
 * 不职责：
 * - 不持状态本身（状态在 preset store，本 composable 只做「RPC 拉取 → store 写入」的接线）。
 * - 不挂常驻订阅（preset 域无 server-push 广播，preset.* 不在 ServerMessageType）。
 * - 唯一例外 = installPresetAutoLoad 的「首次 connected 必拉一次」单例 watch（u5
 *   mode-declaration-row · 设计 §6.5 P0-12 / §7.5 E7）——preset 域无广播，但**冷启动直接进入
 *   上次的非默认模式会话**（不经 landing）时 store 为空，声明行会误报「模式已删除」。
 *   App bootstrap 只提交连接编排、**不等 connected**（冷启时 preset.list/getDefault 两条 WS RPC
 *   必 rejected），故加载点挂在连接态（`watch(getState())`）而非 bootstrap：首次 connected 拉一次，
 *   成功即置位、重连不重复；加载失败不置位 → 下一次 connected 自动补拉（E7 ③ 恢复通道）。
 *
 * 依赖方向：
 * - 读 @/api（preset 域 RPC：list / getDefault / setDefault）。
 * - 读 @taiji/core/transport/ws-client（连接态；与 useBackgroundTasks 同源依赖）。
 * - 写 preset store（presets / defaultPresetId）。
 */
import { effectScope, watch } from 'vue'
import type { EffectScope } from 'vue'
import { getState } from '@taiji/core/transport/ws-client'
import { preset as presetApi } from '@/api'
import { usePresetStore } from '@/stores/preset'
import type { PiLaunchPreset } from '@taiji/shared'

// ── 首次 connected 自动拉取单例（u5 · 设计 §6.5 P0-12 / §7.5 E7）─────────────
/** 单例安装标志（幂等：HMR / 多次调用只挂一个 watcher）。 */
let presetAutoLoadInstalled = false
/** 已成功加载标志（置位后重连不重复拉；加载失败不置位 → 下一次 connected 补拉）。 */
let presetLoadedOnce = false
/** detached effect scope 持有单例 watch（不随调用方组件卸载停止）。 */
let presetAutoLoadScope: EffectScope | null = null

/**
 * 安装 preset「首次 connected 必拉一次」单例（幂等）。
 *
 * 何时调用：会话面板常驻挂载点（MessageStream setup）。安装后：
 * - immediate：若安装时已 connected（AppShell 仅在 connected 后渲染 → 稳态路径）立即拉一次；
 * - 边沿：之后每次进入 connected 仅在尚未成功加载时拉（重连不重复）；
 * - 失败补拉：任一 RPC rejected → store.loadError 非空 → 不置位 → 下一次 connected 重试。
 * 实现细节：watch 放在 detached effectScope 内（app 生命周期单例，不随组件卸载停止）。
 */
export function installPresetAutoLoad(): void {
  if (presetAutoLoadInstalled) return
  presetAutoLoadInstalled = true
  presetAutoLoadScope = effectScope(true)
  presetAutoLoadScope.run(() => {
    const { loadPresets } = usePiPresets()
    watch(
      getState(),
      (s) => {
        if (s !== 'connected' || presetLoadedOnce) return
        void loadPresets().then(() => {
          // 加载失败（loadError 非空）保持未置位，等下一次 connected 补拉（E7 ③ 恢复通道）
          if (usePresetStore().loadError === null) presetLoadedOnce = true
        })
      },
      { immediate: true },
    )
  })
}

/** 测试专用：停止单例 watch 并复位标志（生产不调用）。 */
export function __resetPresetAutoLoadForTest(): void {
  presetAutoLoadScope?.stop()
  presetAutoLoadScope = null
  presetAutoLoadInstalled = false
  presetLoadedOnce = false
}

/**
 * preset 域编排 composable。
 *
 * 返回 loadPresets（拉数据写 store）+ setDefault（乐观更新 + RPC）。
 * 状态读取直接用 usePresetStore()（各消费方按需 storeToRefs / 直读）。
 *
 * 无 init/dispose（无订阅），与 useSettings 的常驻订阅模式不同——preset 数据变更频率低
 * （设置默认预设是低频操作），按需 load + 乐观更新足够，无需常驻订阅。
 */
export function usePiPresets() {
  const store = usePresetStore()

  /**
   * 拉取预设列表 + 全局默认预设 id，写入 store。
   *
   * list 与 getDefault 是两个独立 RPC（无数据依赖），用 Promise.allSettled 并行：
   * - 任一失败不阻断另一个（getDefault 失败 → defaultPresetId 保持 '' 由 chip 兜底；
   *   list 失败 → presets 保持 [] 由 chip 兜底空态）。
   * - allSettled 而非 all：独立数据源用 allSettled 不用 all（前端规范）。
   *
   * 错误态（S-RN-2）：rejected 分支不再静默——console.warn 留排查线索 + 写 store.loadError
   * （首个 rejected 的 Error.message），让 PresetSelectChip 区分「未加载」与「加载失败」，
   * 不再因 RPC 永久 reject 卡「加载中…」。任一成功即清 loadError（部分成功也视为已加载）。
   */
  async function loadPresets(): Promise<void> {
    const results = await Promise.allSettled([
      presetApi.list(),
      presetApi.getDefault(),
    ])
    // 任一 rejected → 记首个错误；全部 fulfilled → 清错误态
    const firstReject = results.find(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    )
    if (firstReject) {
      const reason = firstReject.reason
      const msg = reason instanceof Error ? reason.message : String(reason)
      console.warn('[usePiPresets] loadPresets partial/total failure:', reason)
      store.setLoadError(msg)
    } else {
      store.setLoadError(null)
    }
    if (results[0].status === 'fulfilled') {
      store.setPresets(results[0].value)
    }
    if (results[1].status === 'fulfilled') {
      store.setDefaultPresetId(results[1].value)
    }
  }

  /**
   * 设置全局默认预设。
   *
   * 乐观更新：立即写 store.defaultPresetId（UI 即时响应），随后发 RPC 持久化。
   * RPC 失败时由调用方（chip）决定是否 toast 提示——本编排层不 toast（保持与
   * store.setSkillDirs 同模式：只发请求 + 让广播/乐观更新覆盖）。
   * preset 域无广播，故 RPC 失败时本地 state 与后端可能短暂不一致——preset 设置是
   * 低频操作且单点写入（仅 setDefault 一个入口），不一致风险可接受；如需严格一致，
   * 调用方可在 RPC 失败时重调 loadPresets 刷新。
   */
  async function setDefault(presetId: string): Promise<void> {
    store.setDefaultPresetId(presetId)
    await presetApi.setDefault(presetId)
  }

  /**
   * 创建自定义预设。
   *
   * 乐观更新：立即 upsert 到 store（UI 即时显示），随后发 RPC 持久化。
   * RPC 成功后用 reply 回写 store（W-RN-3：runtime 可能补全 order/id 等字段，本地
   * optimistic 镜像与持久态对齐，避免 order 错乱）。
   * RPC 失败时回滚（removePreset），调用方 catch 后 toast。
   */
  async function create(preset: PiLaunchPreset): Promise<PiLaunchPreset> {
    store.upsertPreset(preset)
    try {
      const saved = await presetApi.create(preset)
      // 用 RPC reply 回写（runtime 可能补全 order/id 等字段）
      store.upsertPreset(saved)
      return saved
    } catch (e) {
      store.removePreset(preset.id)
      throw e
    }
  }

  /**
   * 更新预设（含内置预设的可编辑字段）。
   *
   * 乐观更新：立即 upsert 到 store，随后发 RPC 持久化。
   * RPC 成功后用 reply 回写 store（W-RN-3：runtime 对内置预设有 PresetGuard 规范化，
   * reply 是权威态，覆盖本地乐观镜像）。
   * RPC 失败时全量刷新回滚（内置预设保护等复杂场景，loadPresets 更可靠）。
   */
  async function update(preset: PiLaunchPreset): Promise<PiLaunchPreset> {
    store.upsertPreset(preset)
    try {
      const saved = await presetApi.update(preset)
      // 用 RPC reply 回写（runtime 规范化后的权威态）
      store.upsertPreset(saved)
      return saved
    } catch (e) {
      await loadPresets()
      throw e
    }
  }

  /**
   * 删除自定义预设（内置不可删）。
   *
   * 乐观更新：备份 → 立即 removePreset，随后发 RPC 持久化。
   * RPC 失败时回滚（upsertPreset 备份），调用方 catch 后 toast。
   */
  async function remove(presetId: string): Promise<void> {
    const backup = store.presets.find((p) => p.id === presetId)
    store.removePreset(presetId)
    try {
      await presetApi.remove(presetId)
    } catch (e) {
      if (backup) store.upsertPreset(backup)
      throw e
    }
  }

  return {
    loadPresets,
    setDefault,
    create,
    update,
    remove,
  }
}
