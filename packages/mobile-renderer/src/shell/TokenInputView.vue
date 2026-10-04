<script setup lang="ts">
// TokenInputView —— 移动壳 token 输入视图（remote-use D4 皆无分支 / D8 验身失败的恢复入口）。
//
// 哑组件：App.vue 多视图挂载消费，提交经 submit 事件上抛；重试编排（adoptManualToken →
// 抑制位 reset → 重走连接编排）在 bootstrap 的 submitRemoteToken，组件零 core import。
//
// 文案走 vue-i18n（mobile.tokenInput 命名空间，双侧 locales 对齐由 mobile-locale.test 守卫）；
// 视觉：太极纯灰 token，无 emoji；表单原语经 @taiji/ui Input/Button（原生元素由 ui 单点承载）。
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button, Input } from '@taiji/ui'

const { t } = useI18n()

const emit = defineEmits<{ (e: 'submit', token: string): void }>()

const token = ref('')

function onSubmit(): void {
  const value = token.value.trim()
  if (value === '') return
  emit('submit', value)
}
</script>

<template>
  <div
    class="flex h-screen flex-col items-center justify-center gap-4 bg-bg p-6"
    data-testid="token-input-view"
  >
    <p class="text-sm text-neutral-fg" data-testid="token-input-title">{{ t('mobile.tokenInput.title') }}</p>
    <p class="text-xs text-neutral-mid">{{ t('mobile.tokenInput.hint') }}</p>
    <div class="flex w-full max-w-sm flex-col gap-3">
      <Input
        v-model="token"
        type="password"
        :placeholder="t('mobile.tokenInput.placeholder')"
        data-testid="token-input"
        @keyup.enter="onSubmit"
      />
      <Button data-testid="token-submit" :disabled="token.trim() === ''" @click="onSubmit">
        {{ t('mobile.tokenInput.submit') }}
      </Button>
    </div>
  </div>
</template>
