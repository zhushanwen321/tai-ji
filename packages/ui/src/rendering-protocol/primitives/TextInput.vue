<script setup lang="ts">
/**
 * 文本输入（provider-plugin-access D8）——GuiComponent 协议输入原语。
 *
 * 交互契约（设计 D8）：值变更即经 UI_EVENT_SENDER_KEY 注入的宿主出口走 plugin.uiEvent
 * 回传（fire-and-forget，插件侧始终持有最新值）；确认动作复用 action-bar 按钮点击，
 * 本组件不承载提交语义。事件名固定 'change'（值变更的唯一事件形态；更多事件形态有
 * 真实消费方时再加）。
 *
 * 值状态：宿主本地镜像（初始 = props.value，输入即时反映不打字丢字）+ props.value
 * 变化跟随（插件回推新树即更新——「插件推新树；输入状态保持」S7 语义）。本地镜像
 * 与 tab-bar「宿主本地持有 active」同范式：单值权威在插件（重推覆盖），两次回推
 * 之间用户输入不被清掉。
 *
 * multiline 切换 @taiji/ui Textarea / Input（no-native-html-elements 规则——裸
 * input/textarea 禁用）。出口缺位（standalone 挂载 / 壳层未 provide）：输入框禁用
 * + warn 一次（对齐 Actionbar 降级出声范式——降级 ≠ 吞错）。
 */
import { computed, inject, ref, watch } from 'vue'
import type { GuiComponentProps } from '@zhushanwen/extension-protocol'
import Input from '../../primitives/input/Input.vue'
import Textarea from '../../primitives/textarea/Textarea.vue'
import { UI_EVENT_SENDER_KEY } from './ui-event-sender-key'

const props = defineProps<GuiComponentProps['text-input']>()

/** 宿主 uiEvent 出口（壳层 provide）；显式 undefined 默认值 = 抑制「injection not found」
 *  dev 警告（纯展示场景零噪音），缺位退化由下方 warn 承担（Actionbar 同款范式）。 */
const sender = inject(UI_EVENT_SENDER_KEY, undefined)

/** 宿主本地镜像：初始取树携带值；插件回推新树（props.value 变化）时跟随。 */
const local = ref(String(props.value ?? ''))
watch(() => props.value, (v) => {
  local.value = String(v ?? '')
})

/** 值变更：本地镜像即时更新（不丢字）+ 回传插件（event 固定 'change'）。 */
const onInput = (v: string | number): void => {
  local.value = String(v)
  sender?.send(props.id, 'change', String(v))
}

const hasSender = computed(() => sender !== undefined)

/** 降级出声：出口缺位 → warn 一次（防每次推送刷屏） */
let warnedNoSender = false
watch(hasSender, (has) => {
  if (has) {
    warnedNoSender = false
    return
  }
  if (warnedNoSender) return
  warnedNoSender = true
  console.warn(
    '[gui-text-input] UI_EVENT_SENDER_KEY 未注入，输入框已禁用。修复：宿主壳层 provide UI_EVENT_SENDER_KEY' +
      '（@taiji/ui/rendering-protocol/primitives/ui-event-sender-key）',
  )
}, { immediate: true })
</script>

<template>
  <div class="text-input flex flex-col gap-1" data-testid="gui-text-input">
    <label
      v-if="typeof label === 'string' && label !== ''"
      :for="`gui-text-input-${id}`"
      class="text-sm text-neutral-dim"
    >
      {{ label }}
    </label>
    <Textarea
      v-if="multiline === true"
      v-model="local"
      :id="`gui-text-input-${id}`"
      :placeholder="placeholder"
      :disabled="!hasSender"
      :data-testid="`gui-text-input-field-${id}`"
      @update:model-value="onInput"
    />
    <Input
      v-else
      v-model="local"
      :id="`gui-text-input-${id}`"
      :placeholder="placeholder"
      :disabled="!hasSender"
      :data-testid="`gui-text-input-field-${id}`"
      @update:model-value="onInput"
    />
  </div>
</template>
