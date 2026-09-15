/**
 * 手风琴就地编辑的展开切换 + dirty 守卫（R4）。
 *
 * 从 ProviderPage 提取（wave4：script setup 行数压力）。职责：
 * - 单展开状态（expandedId：null=无 / NEW_ID=新建态 / 其它=编辑该 provider）
 * - dirty 守卫（切换/收起/新建前若有未保存改动 → ConfirmDialog 二次确认 → 丢弃后执行）
 * - ProviderEditBody 的 dirty/saved/cancel 事件接入（联动 currentBodyDirty + expandedId）
 *
 * composable 返回的 refs/functions 在 ProviderPage template 直接解构使用，引用不变。
 */
import { ref, computed } from 'vue'
import type { Ref } from 'vue'

export function useAccordionGuard(newId: string) {
  /** 当前展开的 provider id（null=无，newId=新建态，其它=编辑该 provider） */
  const expandedId: Ref<string | null> = ref(null)
  /** 当前展开 body 的 dirty 态（经 @dirty-change 上抛，用于切换守卫） */
  const currentBodyDirty = ref(false)
  /**
   * dirty 守卫的待执行目标（confirmDiscard 后直接赋给 expandedId）：undefined=无守卫在途，
   * null=确认后收起，string=确认后切到该 provider。存在性（!== undefined）驱动守卫弹窗开合。
   */
  const pendingTarget = ref<string | null | undefined>(undefined)
  /** dirty 守卫确认弹窗 open 态（v-model:open 双向绑定） */
  const guardDialogOpen = computed({
    get: () => pendingTarget.value !== undefined,
    set: (open: boolean) => {
      if (!open) pendingTarget.value = undefined
    },
  })

  /**
   * 展开切换入口（行头名称点击）：dirty 时拦截 → 确认后丢弃改动并执行目标动作。
   * - 点已展开行 → 收起（dirty 时先确认）
   * - 点未展开行 → 切换到该行（当前展开行 dirty 时先确认）
   */
  function toggleExpand(id: string): void {
    if (expandedId.value === id) {
      if (currentBodyDirty.value) {
        pendingTarget.value = null
        return
      }
      expandedId.value = null
      currentBodyDirty.value = false
      return
    }
    if (currentBodyDirty.value) {
      pendingTarget.value = id
      return
    }
    expandedId.value = id
    currentBodyDirty.value = false
  }

  /**
   * 新建并展开（spec §9 旅程 A1）：已有未保存改动时先走守卫。
   * 列表底部追加合成行（id=newId），ProviderEditBody 收到 null provider → 新增态空表单。
   */
  function createAndExpand(): void {
    if (expandedId.value !== null && currentBodyDirty.value) {
      pendingTarget.value = newId
      return
    }
    expandedId.value = newId
    currentBodyDirty.value = false
  }

  /** dirty 守卫确认 → 执行待定动作（展开体卸载即丢弃表单态，无需显式 reset） */
  function confirmDiscard(): void {
    const target = pendingTarget.value
    pendingTarget.value = undefined
    if (target === undefined) return
    currentBodyDirty.value = false
    expandedId.value = target
  }

  // ── ProviderEditBody 事件处理 ──

  function onBodyDirtyChange(v: boolean): void {
    currentBodyDirty.value = v
  }

  /** 保存成功 → 收起展开行（store 广播 onProviders 推回最新 provider 列表） */
  function onBodySaved(): void {
    expandedId.value = null
    currentBodyDirty.value = false
  }

  /** 取消 → 收起（展开体卸载，表单态自然丢弃） */
  function onBodyCancel(): void {
    expandedId.value = null
    currentBodyDirty.value = false
  }

  return {
    expandedId,
    currentBodyDirty,
    guardDialogOpen,
    toggleExpand,
    createAndExpand,
    confirmDiscard,
    onBodyDirtyChange,
    onBodySaved,
    onBodyCancel,
  }
}
