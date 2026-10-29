<script setup lang="ts">
// FormSheet —— 「待回答」Sheet（remote-use-mobile-v2 §6.5 三通道 Sheet 化的统一作答面）。
//
// 三源三节并列呈现（C4 门保证同一请求只进一个通道，不同请求可并发同屏）：
// - form 类请求 → FormRequestSection 节（choice/text/schedule 题型，自包含子组件）；
// - planReview 审批帧 → 自审结论 + 批准/搁置双键（payload 与桌面 PlanReviewBar 同契约；
//   revise 键不呈现——修订须携带评论草稿，移动壳无该机制，v1 同边界登记）；
// - 简单 dialog（四型 = ExtensionInteractMethod 全集，词表见 ./dialog-methods）→
//   confirm=二选一 / select=单选 / input=单行文本 / editor=多行文本 + prefill 预填 +
//   等宽字体（对齐 v1 CompanionBand editor 实装形态），未知 method 只读降级（ERR3：
//   不白屏不崩溃不误提交，console.warn 留痕）。
//
// 回传语义：submit/cancel 按 requestId 由壳层编排路由（form/planReview 走 form 通道
// respond、dialog 走 dialog queue respond——两通道回传 RPC 面不同，FormSheet 只上抛）；
// **取消回传 result:null**（cancel 事件 → App 转 respond(requestId, null)）。Sheet 拖拽/
// 遮罩关闭 ≠ 取消（请求保留，底部条可再开）——close 事件仅关视图。
// 提交禁用的第二输入 = submitSuspended（§6.23 restart 重连对账完成前禁答，companion-bridge
// useFormSubmitSuspended 驱动）；作用域限 form/planReview 两节（form 通道恢复事件驱动的
// 禁答面）。dialog 节与其解耦不受禁（§6.23 恢复链去合取化：dialog 作答走 queue 回传面，
// 送达判定自带——WS 非 OPEN 返 false 保留重试，无 form 通道对账依赖，不被其恢复事件
// 连带锁死）。
//
// 失效信号消费（§6.4/§7.1）：extension:requestsInvalidated / plugin:uiRequestExpired 命中
// 呈现中请求时由 companion-bridge 联动 closeSheet + 原因提示（数据源摘除 → 本组件三 prop
// 变 undefined → 节消失），Sheet 内不残留僵尸请求。plugin:permissionRequestExpired 例外：
// 收层由 App pending watch 权威处理、companion-bridge 仅错误条提示（A7 收层与提示解耦）。
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button, Input, Sheet, Textarea } from '@taiji/ui'
import type { DialogRequest } from '@taiji/ui/extension-host'
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'
import type { PlanReviewFrameForView } from '../shell/companion-bridge'
import { isDialogMethod } from './dialog-methods'
import FormRequestSection from './FormRequestSection.vue'

const props = defineProps<{
  /** 槽位开合（sheet-manager activeSheet === 'form'） */
  open: boolean
  /** form 类请求（undefined = 该节不渲染） */
  request?: ExtensionUIRequest
  /** planReview 审批请求（undefined = 该节不渲染） */
  planReview?: PlanReviewFrameForView
  /** dialog 四型请求（undefined = 该节不渲染） */
  dialog?: DialogRequest
  /** 作答回传未送达的 requestId（App 编排持有；匹配当前展示请求时渲染内联错误行） */
  submitFailedId?: string | null
  /** §6.23 提交挂起（restart 重连对账完成前禁答；仅作用于 form/planReview 节，dialog 节解耦） */
  submitSuspended?: boolean
}>()

const emit = defineEmits<{
  /** 作答回传（form/planReview result=string；dialog confirm=boolean、余四型 string） */
  submit: [payload: { requestId: string; result: string | boolean }]
  /** 取消（App 侧转对应通道 respond(requestId, null)） */
  cancel: [payload: { requestId: string; source: 'form' | 'dialog' }]
  /** 关闭视图（拖拽/遮罩/关闭钮；不取消请求——请求保留待回答条可再开） */
  close: []
}>()

const { t } = useI18n()

/** 三节任一在场（Sheet open 的内容门——空槽不渲染浮层壳） */
const hasContent = computed(() =>
  props.request !== undefined || props.planReview !== undefined || props.dialog !== undefined,
)

/** 挂起提示可见门：仅 form/planReview 节在场时呈现（被禁答面存在才有「对账中」提示；
 * dialog-only 呈现不受挂起禁答，不显示——§6.23 dialog 节解耦） */
const suspendHintVisible = computed(() =>
  props.submitSuspended === true && (props.request !== undefined || props.planReview !== undefined),
)

// 回传未送达错误行（role=alert）：submitFailedId 匹配当前展示请求才渲染——请求被摘除
// （作答收尾）或新请求到达时旧错误不残留
const showRespondError = computed(() => {
  const failedId = props.submitFailedId
  if (failedId === null || failedId === undefined) return false
  return props.request?.requestId === failedId || props.planReview?.requestId === failedId || props.dialog?.requestId === failedId
})

// ── dialog 四型交互状态（对齐 CompanionBand：新请求到达重置输入）──────────────

const dialogInputValue = ref('')
const dialogSelectValue = ref('')

const knownDialogMethod = computed(() => {
  const m = props.dialog?.method
  return m !== undefined && isDialogMethod(m)
})

watch(() => props.dialog, (r) => {
  if (!r) return
  dialogInputValue.value = r.default ?? r.prefill ?? ''
  dialogSelectValue.value = r.default ?? ''
}, { immediate: true })

/** 未知 method 留痕（ERR3：模板不做副作用调用；分发面由 isDialogMethod 收窄） */
watch(() => props.dialog?.method, (m) => {
  if (m !== undefined && !isDialogMethod(m)) {
    console.warn('[FormSheet] unknown dialog method:', m)
  }
})

/** dialog 确认：input/editor 回传字符串、select 回传选中值、confirm 回传 true（CompanionBand 同语义）。
 * 不受 submitSuspended 禁（§6.23 恢复链去合取化：dialog 回传面独立，送达判定自带） */
function onDialogConfirm(): void {
  const r = props.dialog
  if (!r || !knownDialogMethod.value) return
  if (r.method === 'input' || r.method === 'editor') {
    emit('submit', { requestId: r.requestId, result: dialogInputValue.value })
  } else if (r.method === 'select') {
    emit('submit', { requestId: r.requestId, result: dialogSelectValue.value })
  } else if (r.method === 'confirm') {
    emit('submit', { requestId: r.requestId, result: true })
  }
}

/** dialog 取消（回传 null；allowCancel false 的请求不显取消钮，此处兜一道。不受挂起禁，同上） */
function onDialogCancel(): void {
  const r = props.dialog
  if (!r) return
  emit('cancel', { requestId: r.requestId, source: 'dialog' })
}

const dialogAllowCancel = computed(() => props.dialog?.allowCancel !== false)

/** select 确认门（未选禁用，CompanionBand 同语义） */
const dialogSelectReady = computed(() => dialogSelectValue.value !== '')

function onFormSubmit(payload: { requestId: string; result: string }): void {
  emit('submit', { requestId: payload.requestId, result: payload.result })
}

function onFormCancel(payload: { requestId: string }): void {
  emit('cancel', { requestId: payload.requestId, source: 'form' })
}

function onDismiss(): void {
  emit('close')
}
</script>

<template>
  <Sheet
    :open="open && hasContent"
    :title="t('mobile.sheet.formTitle')"
    :description="suspendHintVisible ? t('mobile.sheet.submitSuspended') : undefined"
    @update:open="!$event && onDismiss()"
  >
    <!-- form 类请求节（choice/text/schedule 题型自包含子组件；根节 testid 由
         FormRequestSection 根 div 自带——此处 attrs 会覆盖根元素同名属性，不另传） -->
    <FormRequestSection
      :request="request"
      :suspended="submitSuspended"
      @submit="onFormSubmit"
      @cancel="onFormCancel"
    />

    <!-- 回传未送达内联错误行（三源共用单行；App 编排置 submitFailedId） -->
    <p
      v-if="showRespondError"
      class="text-[length:var(--m-text-sub)] text-neutral-fg"
      role="alert"
      data-testid="form-sheet-respond-error"
    >
      {{ t('mobile.formCard.respondFailed') }}
    </p>

    <!-- planReview 审批节（自审结论 + 批准/搁置；revise 不呈现，见文件头登记） -->
    <div
      v-if="planReview"
      class="flex flex-col gap-2"
      data-testid="form-sheet-plan-review"
    >
      <div class="flex items-center gap-2">
        <span class="size-1.5 shrink-0 animate-pulse rounded-full bg-accent motion-reduce:animate-none" />
        <span class="min-w-0 flex-1 text-[length:var(--m-text-sub)] font-medium text-neutral-fg" data-testid="form-sheet-plan-review-title">
          {{ t('mobile.formCard.planReviewTitle') }}
        </span>
      </div>
      <p
        v-if="planReview.selfReview"
        class="whitespace-pre-wrap break-words rounded bg-surface-hover px-2.5 py-1.5 text-[length:var(--m-text-sub)] leading-1.5 text-neutral-mid"
        data-testid="form-sheet-plan-review-self-review"
      >
        {{ planReview.selfReview }}
      </p>
      <div class="flex items-center justify-end gap-2 pt-1">
        <Button
          variant="ghost"
          data-testid="form-sheet-plan-review-dismiss"
          :disabled="submitSuspended"
          @click="emit('submit', { requestId: planReview.requestId, result: JSON.stringify({ decision: 'dismiss' }) })"
        >
          {{ t('mobile.formCard.dismiss') }}
        </Button>
        <Button
          variant="default"
          data-testid="form-sheet-plan-review-approve"
          :disabled="submitSuspended"
          @click="emit('submit', { requestId: planReview.requestId, result: JSON.stringify({ decision: 'approve' }) })"
        >
          {{ t('mobile.formCard.approve') }}
        </Button>
      </div>
    </div>

    <!-- dialog 四型节（confirm/select/input/editor；词表单一来源 ./dialog-methods） -->
    <div
      v-if="dialog"
      class="flex flex-col gap-2"
      data-testid="form-sheet-dialog"
    >
      <p
        v-if="dialog.message"
        class="text-[length:var(--m-text-sub)] leading-1.5 text-neutral-mid"
        data-testid="form-sheet-dialog-message"
      >
        {{ dialog.message }}
      </p>

      <!-- confirm：确认/取消（拒绝侧=取消在左；不受挂起禁答——dialog 节解耦，见文件头） -->
      <div v-if="dialog.method === 'confirm'" class="flex justify-end gap-2 pt-1">
        <Button
          v-if="dialogAllowCancel"
          variant="ghost"
          data-testid="form-sheet-dialog-cancel"
          @click="onDialogCancel"
        >{{ t('common.cancel') }}</Button>
        <Button
          variant="default"
          data-testid="form-sheet-dialog-ok"
          @click="onDialogConfirm"
        >{{ t('common.confirm') }}</Button>
      </div>

      <!-- select：单选列表 + 确认（未选禁用）/取消 -->
      <template v-else-if="dialog.method === 'select'">
        <div class="flex flex-col gap-1">
          <div
            v-for="opt in dialog.options ?? []"
            :key="opt.value"
            :data-testid="`form-sheet-dialog-option-${opt.value}`"
            role="radio"
            :tabindex="0"
            :aria-checked="dialogSelectValue === opt.value"
            :class="[
              'flex min-h-[var(--m-tap)] cursor-pointer items-start gap-2 rounded px-2.5 py-1.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent',
              dialogSelectValue === opt.value ? 'bg-accent-soft' : 'bg-surface-2',
            ]"
            @click="dialogSelectValue = opt.value"
            @keydown.enter="dialogSelectValue = opt.value"
            @keydown.space.prevent="dialogSelectValue = opt.value"
          >
            <div
              :class="[
                'mt-0.5 size-4 shrink-0 rounded-full border-2 transition-colors',
                dialogSelectValue === opt.value ? 'border-accent bg-accent' : 'border-border-strong',
              ]"
            />
            <div class="flex min-w-0 flex-1 flex-col">
              <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span data-testid="form-sheet-dialog-option-label" class="text-[length:var(--m-text-sub)] leading-1.5 text-neutral-fg">{{ opt.label }}</span>
                <span v-if="opt.description" class="text-[length:var(--m-text-sub)] leading-1.5 text-neutral-mid">{{ opt.description }}</span>
              </div>
            </div>
          </div>
        </div>
        <div class="flex justify-end gap-2 pt-1">
          <Button
            v-if="dialogAllowCancel"
            variant="ghost"
            data-testid="form-sheet-dialog-cancel"
            @click="onDialogCancel"
          >{{ t('common.cancel') }}</Button>
          <Button
            variant="default"
            data-testid="form-sheet-dialog-ok"
            :disabled="!dialogSelectReady"
            @click="onDialogConfirm"
          >{{ t('common.confirm') }}</Button>
        </div>
      </template>

      <!-- input（单行）/ editor（多行 + prefill 预填 + 等宽，§6.5 四型映射） -->
      <template v-else-if="dialog.method === 'input' || dialog.method === 'editor'">
        <Textarea
          v-if="dialog.method === 'editor'"
          v-model="dialogInputValue"
          rows="6"
          data-testid="form-sheet-dialog-editor"
          class="font-mono text-[length:var(--m-text-sub)]"
        />
        <Input
          v-else
          v-model="dialogInputValue"
          data-testid="form-sheet-dialog-input"
        />
        <div class="flex justify-end gap-2 pt-1">
          <Button
            v-if="dialogAllowCancel"
            variant="ghost"
            data-testid="form-sheet-dialog-cancel"
            @click="onDialogCancel"
          >{{ t('common.cancel') }}</Button>
          <Button
            variant="default"
            data-testid="form-sheet-dialog-ok"
            @click="onDialogConfirm"
          >{{ t('common.confirm') }}</Button>
        </div>
      </template>

      <!-- 未知 method（ERR3）：只读降级展示（title/message 已渲染，无交互按钮） -->
      <p
        v-else
        data-testid="form-sheet-dialog-unknown"
        class="text-[length:var(--m-text-sub)] text-neutral-mid"
      >
        {{ dialog.method }}
      </p>
    </div>
  </Sheet>
</template>
