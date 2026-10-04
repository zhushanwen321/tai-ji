<script setup lang="ts">
// NewTaskSheet —— 移动壳新建任务表单（core createSessionFlow 接线，D7 新建任务行）。
//
// 两字段：项目路径（手输——移动唯一形态，无原生目录选择器；桌面 pickDirectory 手输
// popover 兜底是同款先例 A11）+ 首条消息。底部 sheet 形态（太极纯灰：bg-bg-input 一体
// 容器 + 顶部圆角），创建成功自动激活新 session 并上抛 created（App 切到聊天视图）。
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { randomUuid } from '@taiji/core'
import { Button, Input, Textarea } from '@taiji/ui'
import type { SessionSummary } from '@taiji/shared'
import { createMobileTask } from '../shell/app-runtime'

const props = defineProps<{ open: boolean }>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'created', session: SessionSummary): void
}>()

const { t } = useI18n()

const cwd = ref('')
const firstMessage = ref('')
const submitting = ref(false)
const errorText = ref('')

// [remote-use A17/U18] 创建流幂等键（per-open 黏滞槽）：uuid 按「意图」稳定——打开时生成
// 一次存 ref，提交失败的原样重试复用同键（runtime 按 clientUuid 幂等返回已建 session，
// 弱网超时重试不双建，对齐 core 黏滞槽语义 new-task-search/flow.ts takeClientUuidFor）；
// 提交成功或关闭才重置（意图落定/放弃即换槽）。重置 = 换入新 uuid（非清空）：槽内恒为
// 合法键，成功后未关窗口内的再次提交（新意图）自带新键；禁 per-call 生成——onSubmit 只
// 读槽不生成，重试路径（失败）永不重置。
const clientUuid = ref('')

// 打开时重置表单 + 生成新意图键（关闭态保留 DOM 但字段清空，下次进入是干净表单）；
// immediate 覆盖「挂载即开」的边角（open 初始 true 时 watcher 不触发的窗口）
watch(
  () => props.open,
  (open) => {
    clientUuid.value = randomUuid()
    if (open) {
      cwd.value = ''
      firstMessage.value = ''
      errorText.value = ''
    }
  },
  { immediate: true },
)

async function onSubmit(): Promise<void> {
  if (submitting.value) return
  if (cwd.value.trim() === '' || firstMessage.value.trim() === '') {
    errorText.value = t('mobile.newTask.required')
    return
  }
  submitting.value = true
  errorText.value = ''
  try {
    const session = await createMobileTask({
      cwd: cwd.value,
      firstMessage: firstMessage.value,
      clientUuid: clientUuid.value,
    })
    if (session) {
      // 提交成功 = 意图落定，槽重置（换入新键，见上方 clientUuid 注释）
      clientUuid.value = randomUuid()
      emit('created', session)
      emit('close')
    } else {
      errorText.value = t('mobile.newTask.required')
    }
  } catch (e) {
    console.error('[new-task] create failed:', e)
    errorText.value = e instanceof Error ? e.message : String(e)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div v-if="open" class="fixed inset-0 z-50 flex flex-col justify-end" data-testid="new-task-sheet">
    <!-- 遮罩（点击关闭） -->
    <div class="absolute inset-0 bg-bg/60" data-testid="new-task-backdrop" @click="emit('close')" />
    <!-- sheet 本体 -->
    <div
      class="relative flex flex-col gap-3 rounded-t-lg border-t border-[var(--border)] bg-bg-input p-4"
      data-testid="new-task-form"
    >
      <span class="text-sm font-medium text-neutral-fg">{{ t('mobile.newTask.title') }}</span>
      <label class="flex flex-col gap-1">
        <span class="text-xs text-neutral-mid">{{ t('mobile.newTask.cwdLabel') }}</span>
        <Input
          v-model="cwd"
          :placeholder="t('mobile.newTask.cwdPlaceholder')"
          data-testid="new-task-cwd"
          autofocus
        />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-xs text-neutral-mid">{{ t('mobile.newTask.messageLabel') }}</span>
        <Textarea
          v-model="firstMessage"
          :placeholder="t('mobile.newTask.messagePlaceholder')"
          rows="3"
          data-testid="new-task-message"
        />
      </label>
      <p v-if="errorText" class="text-xs text-danger" data-testid="new-task-error" role="alert">
        {{ errorText }}
      </p>
      <div class="flex justify-end gap-2 pt-1">
        <Button variant="ghost" data-testid="new-task-cancel" @click="emit('close')">
          {{ t('mobile.newTask.cancel') }}
        </Button>
        <Button
          variant="default"
          data-testid="new-task-submit"
          :disabled="submitting || cwd.trim() === '' || firstMessage.trim() === ''"
          @click="onSubmit"
        >
          {{ t('mobile.newTask.submit') }}
        </Button>
      </div>
    </div>
  </div>
</template>
