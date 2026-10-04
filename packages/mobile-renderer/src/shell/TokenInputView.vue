<script setup lang="ts">
// TokenInputView —— 移动壳 token 输入视图（remote-use D4 皆无分支 / D8 验身失败的恢复入口）。
//
// U1.3 独立交付组件：不接 App.vue（多视图接线归 U1.4c）。组件保持哑组件——提交经 submit
// 事件上抛，重试编排（adoptManualToken → 抑制位 reset → 重走连接编排）在 bootstrap 的
// submitRemoteToken，组件零 core import。
//
// 视觉：太极纯灰 token，无 emoji；表单原语经 @taiji/ui Input/Button（原生元素由 ui 单点承载）。
import { ref } from 'vue'
import { Button, Input } from '@taiji/ui'

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
    <p class="text-sm text-neutral-fg" data-testid="token-input-title">需要访问凭据</p>
    <p class="text-xs text-neutral-mid">回主机「设置 → 远程访问」重新扫码，或在下方粘贴 token</p>
    <div class="flex w-full max-w-sm flex-col gap-3">
      <Input
        v-model="token"
        type="password"
        placeholder="粘贴访问 token"
        data-testid="token-input"
        @keyup.enter="onSubmit"
      />
      <Button data-testid="token-submit" :disabled="token.trim() === ''" @click="onSubmit">
        连接
      </Button>
    </div>
  </div>
</template>
