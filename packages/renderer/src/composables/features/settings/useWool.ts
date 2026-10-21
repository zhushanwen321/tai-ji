/**
 * useWool —— 羊毛 provider 域状态源（wool-provider 设计 D6 ①③，renderer 侧）。
 *
 * 状态形态判定（ADR-0049 例外清单形态）：羊毛接入态是**设置域全局状态**（无 sessionId
 * 归属——family 安装/账号/目录缓存与任何会话无关），非 per-session 状态，Map 分区范式
 * 不适用。采用模块级单例 + refCount 物理订阅（useRollingRestartStatus 同款范式）：
 * 多实例共享单条 wool.state 订阅与同一快照 ref。
 *
 * 数据流（拉为主、推补充，ADR-0097）：wool.getState 拉全量快照（首消费 + 重连后）；
 * wool.state 广播作失效提示（runtime 每次动作后推新快照）。快照小（三家族 × 十余字段），
 * 全量替换无 diff 负担。
 *
 * [C3] transport 只经 SettingsTransport seam（getWoolState/runWoolAction/onWoolState），
 * 禁直连 @/api 门面 / 深 import transport 域。
 */
import { computed, effectScope, onScopeDispose, ref, shallowRef, watch, type EffectScope, type Ref } from 'vue'
import { getState } from '@taiji/core/transport/ws-client'
import { getSettingsTransport } from '@taiji/core'
import type { WoolActionReply, WoolActionRequest, WoolFamilyId, WoolFamilyState, WoolRuntimeSnapshot } from '@taiji/shared'

// taste:allow-no-data-owner W24-EX-B（模块级单例，设置域全局态非 per-session——ADR-0049
// 例外清单形态，判定见文件头）：羊毛域运行态快照（窗口级共享）
const snapshot = shallowRef<WoolRuntimeSnapshot | null>(null)
// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构）：首次拉取完成标记（null = 未拉取）
const loadedOnce = ref(false)

/** 订阅引用计数（多消费者共享单条物理订阅）。 */
let refCount = 0
let unsubscribe: (() => void) | null = null
/** 订阅容器 detached scope（重连 watch 生命周期归 refCount 手动管理，不随首个组件卸载——useRollingRestartStatus 同款）。 */
let subScope: EffectScope | null = null
/** 拉取并发护栏（初始拉取与广播竞态时后到者丢弃，不覆盖更新数据）。 */
let pullInFlight = false

/** 拉全量快照（best-effort：失败保持现状——断连/超时归 transport 层，重连后再拉）。 */
async function pull(): Promise<void> {
  if (pullInFlight) return
  pullInFlight = true
  try {
    snapshot.value = await getSettingsTransport().getWoolState()
    loadedOnce.value = true
  } catch (e) {
    // 辅助域降级：拉取失败保持现状（快照可空——渲染层按 null 显示未拉取态），
    // 不向上抛（设置页其余功能不受影响）；恢复路径 = 重连 watch / 下一动作广播。
    console.debug('[useWool] state pull failed (kept current snapshot):', e)
  } finally {
    pullInFlight = false
  }
}

function ensureSubscribed(): void {
  if (unsubscribe !== null) return
  const transport = getSettingsTransport()
  subScope = effectScope(true) // detached：订阅生命周期归 refCount 手动管理
  unsubscribe = subScope.run(() => {
    const unsubs = [
      transport.onWoolState((next) => {
        snapshot.value = next
        loadedOnce.value = true
      }),
      // WS 断连重连后拉取恢复（拉为主：广播只覆盖运行期变化，重连后窗口态需拉回）。
      watch(() => getState().value, (s, old) => {
        if (s === 'connected' && old !== 'connected') void pull()
      }),
    ]
    return () => { for (const u of unsubs) u() }
  }) ?? null
  void pull()
}

function releaseSubscription(): void {
  unsubscribe?.()
  unsubscribe = null
  subScope?.stop()
  subScope = null
}

/** useWool 返回形态（类型别名：多行字面量签名触发 indent lint，单行签名引用本类型）。 */
export type UseWoolReturn = {
  snapshot: Ref<WoolRuntimeSnapshot | null>
  loadedOnce: Ref<boolean>
  families: Ref<WoolFamilyState[]>
  familyOf: (family: WoolFamilyId) => WoolFamilyState | undefined
  runAction: (req: WoolActionRequest) => Promise<WoolActionReply>
}

/**
 * 消费羊毛域状态（设置页全局态单例 + refCount 订阅）。
 * snapshot = null 表示尚未拉取成功（渲染层显示加载/未拉取态）。
 */
export function useWool(): UseWoolReturn {
  refCount++
  ensureSubscribed()
  onScopeDispose(() => {
    refCount--
    if (refCount <= 0) {
      refCount = 0
      releaseSubscription()
    }
  })
  return {
    snapshot,
    loadedOnce,
    families: computed(() => snapshot.value?.families ?? []),
    familyOf: (family) => snapshot.value?.families.find((f) => f.family === family),
    // 动作直通（两态信封原样返回；ok=false 是领域回执，调用方按 error.code 分流）。
    runAction: (req) => getSettingsTransport().runWoolAction(req),
  }
}

/** 测试钩子：复位模块级状态 + 强制退订（对齐 _resetXxxForTest 模式）。 */
export function _resetWoolForTest(): void {
  refCount = 0
  releaseSubscription()
  snapshot.value = null
  loadedOnce.value = false
  pullInFlight = false
}
