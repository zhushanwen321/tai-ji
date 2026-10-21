<template>
  <!--
    ProviderTestDiscoverSection —— 「模型发现」按钮行 + 结果反馈（纯展示 + 事件上抛，零内部状态）。
    RPC 编排与结果状态（discovering/discoverResult）由父组件的 useProviderEdit 持有（discover
    module），本组件经 @discover 通知父组件发起。

    2026-10-21（用户拍板）：「测试连接」按钮与本组件原按协议分组结果区退役——测试入口下沉到
    每个模型行（ModelTestButton，per-model 独立测试），provider 级一键全测不再暴露。本组件
    只承载「模型发现」（GET /v1/models）——只对 custom provider 渲染：catalog 的模型清单是
    pi 编译期权威（pi 无 fetchModels），发现无语义且现状必失败。
  -->
  <div>
    <div class="flex flex-wrap gap-2">
      <!-- catalog provider 不渲染「模型发现」（pi 无 fetchModels，清单编译期权威） -->
      <Button
        v-if="canDiscover"
        variant="secondary"
        class="gap-1.5 px-2.5 py-1.5 text-[length:var(--text-xs)] text-neutral-mid [&_svg]:size-3.5"
        :disabled="discovering"
        @click="emit('discover')"
      >
        <Loader2 v-if="discovering" class="animate-spin" />
        <RefreshCw v-else />
        {{ discovering ? t('settings.providerEdit.discovering') : t('settings.providerEdit.autoDiscover') }}
      </Button>
    </div>

    <div v-if="discoverResult" class="mt-1 text-[length:var(--text-xs)] text-neutral-mid">{{ discoverResult }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Button } from '@taiji/ui'
import { useI18n } from 'vue-i18n'
import { Loader2, RefreshCw } from '@lucide/vue'

const props = withDefaults(
  defineProps<{
    /** 模型发现进行中（spinner + 按钮互斥 disabled） */
    discovering: boolean
    /** 模型发现结果文案（空 = 未发现） */
    discoverResult: string
    /**
     * provider 体系：catalog 不渲染「模型发现」——pi 无 fetchModels，模型清单是
     * 编译期权威，发现对本体系无语义。缺省 custom 保持既有渲染（向后兼容）。
     */
    providerKind?: 'catalog' | 'custom'
  }>(),
  {
    providerKind: 'custom',
  },
)

const emit = defineEmits<{
  /** 发起模型发现（RPC 编排在父组件 useProviderEdit.autoDiscover） */
  discover: []
}>()

const { t } = useI18n()

/** catalog 无「模型发现」语义（M3b） */
const canDiscover = computed(() => props.providerKind !== 'catalog')
</script>
