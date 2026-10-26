<script setup lang="ts">
// PermissionSheet —— 权限审批 Sheet（remote-use-mobile-v2 §6.5/§6.18 消费半）。
//
// 编排状态机复用 @taiji/ui createPermissionRequestController（companion-bridge 模块级
// 单例，本组件纯呈现）；呈现语义（spec F8 / 设计 §5.1 样例 5）：
// - 权限作用域逐条列出（permissions 每项一行）；
// - **拒绝在左**（安全侧在左，spec §5.1「拒绝（安全侧在左）」；destructive 中权重档，
//   spec §6.1 危险动作纪律）+ 允许在右；
// - **无归属一等分支（§6.18 降级分支）**：V-6 两问不成立（u-runtime-adapt 结论：组装点
//   触发链不携带会话上下文）→ protocol `sessionId` 恒 undefined → 权限请求恒为进程级
//   全局请求——本组件恒全局呈现，不渲染任何会话归属锚点（无会话名/会话行），归属信息
//   呈现位在 V-6 重审（插件激活链重构）通过、组装点填值后由消费方扩展；
// - 过期自动关 + 原因（§6.4/§7.1）：plugin:permissionRequestExpired 的收层由 App
//   pending watch 权威处理（A7 收层与提示解耦）、companion-bridge 仅错误条提示；
//   RPC 失败假成功红线（BM3）由 controller 承接
//   （pending 保持 + error 显形），本组件 error prop 直出错误行。
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button, Sheet } from '@taiji/ui'

const props = defineProps<{
  /** 槽位开合（sheet-manager activeSheet === 'permission'） */
  open: boolean
  /** 申请权限的插件 id（controller state 直透） */
  pluginId: string
  /** 插件申请的权限列表（逐条呈现） */
  permissions: string[]
  /** 请求是否挂起（controller pending；false = 已收尾/已过期，Sheet 内容门关闭） */
  pending: boolean
  /** 上次提交是否失败（controller error；BM3 假成功红线显形错误行） */
  error?: boolean
}>()

const emit = defineEmits<{
  approve: [payload: { pluginId: string; permissions: string[] }]
  deny: [payload: { pluginId: string }]
  /** 关闭视图（拖拽/遮罩；不作答——请求保留待授权条可再开） */
  close: []
}>()

const { t } = useI18n()

// 动作提交中本地门控：RPC 回执在途时 controller pending 恒为 true（仅失败置 error），
// pending 门控挡不住慢网连点——第二次点击会覆盖 App 动作标记（§6.20 通知归因单槽），
// 发出与实际生效动作相反的成功通知。提交置位禁用两按钮消除连点变体；复位时机 =
// 收尾（成功/过期/他端撤回 → pending 翻 false）或失败显错（error 翻 true，BM3 重试可用）。
const submitting = ref(false)

function onApprove(): void {
  if (!props.pending || submitting.value) return
  submitting.value = true
  emit('approve', { pluginId: props.pluginId, permissions: props.permissions })
}

function onDeny(): void {
  if (!props.pending || submitting.value) return
  submitting.value = true
  emit('deny', { pluginId: props.pluginId })
}

watch(() => props.pending, (pending) => {
  if (!pending) submitting.value = false
})

watch(() => props.error, (e) => {
  if (e) submitting.value = false
})
</script>

<template>
  <Sheet
    :open="open && pending && pluginId !== ''"
    :title="t('mobile.sheet.permissionTitle')"
    :description="pluginId"
    @update:open="!$event && emit('close')"
  >
    <!-- 无归属一等分支（§6.18 降级）：恒全局呈现——此处不渲染会话归属锚点（无归属分支
         的呈现面即「无归属标注」；协议 sessionId? 恒 undefined，类型安全缺省不显示） -->
    <p class="text-[length:var(--m-text-sub)] text-neutral-mid" data-testid="permission-sheet-scope-hint">
      {{ t('mobile.sheet.permissionScopeHint', { count: permissions.length }) }}
    </p>

    <!-- 权限作用域逐条列出 -->
    <ul class="flex flex-col gap-1" data-testid="permission-sheet-permissions">
      <li
        v-for="perm in permissions"
        :key="perm"
        :data-testid="`permission-sheet-perm-${perm}`"
        class="break-all rounded bg-surface-2 px-2.5 py-1.5 font-mono text-[length:var(--m-text-sub)] text-neutral-fg"
      >
        {{ perm }}
      </li>
    </ul>

    <!-- BM3 提交失败错误行（假成功红线：失败不关窗供重试） -->
    <p
      v-if="error"
      class="text-[length:var(--m-text-sub)] text-neutral-fg"
      role="alert"
      data-testid="permission-sheet-error"
    >
      {{ t('mobile.sheet.permissionSubmitFailed') }}
    </p>

    <!-- 拒绝在左（安全侧，destructive 档）+ 允许在右；提交在途两按钮禁用（连点防护） -->
    <template #footer>
      <Button
        variant="destructive"
        data-testid="permission-sheet-deny"
        :disabled="submitting"
        @click="onDeny"
      >{{ t('mobile.sheet.permissionDeny') }}</Button>
      <Button
        variant="default"
        data-testid="permission-sheet-approve"
        :disabled="submitting"
        @click="onApprove"
      >{{ t('mobile.sheet.permissionApprove') }}</Button>
    </template>
  </Sheet>
</template>
