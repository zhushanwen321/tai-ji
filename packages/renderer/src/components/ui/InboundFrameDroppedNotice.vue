<template>
  <!--
    [crash-forensics-and-watchdog §3.3 D8 / u10a] 入站超界帧终止阀的会话级静态错误提示。
    复用 C-proc-12 熔断静态页「响亮降级 + 恢复指引」形态（不新建第三套死态），会话级
    作用域：仅终止阀生效中的 session 渲染，其余 session 流不受连坐。恢复触发器 = 用户
    切走再切回本 session（useInboundFrameGuard 的 watch 自动重试一次订阅），提示条内
    文案明示该动作；不放重试按钮——「对端自行恢复」无观测信号，恢复动作统一收敛到
    用户切换行为（设计 D8 恢复触发器裁决）。
    状态源：useInboundFrameGuardState 的 trippedSessionIds（core ws-client 终止阀投影）。
    挂载点：会话视图内（props.sessionId 由宿主传入）；App 装配层 installInboundFrameGuard()
    已启动状态投影。
  -->
  <div
    v-if="tripped"
    data-testid="inbound-frame-dropped-notice"
    class="flex items-start gap-2 rounded-[var(--radius)] border border-border bg-surface px-3 py-2.5"
    role="alert"
  >
    <TriangleAlert class="mt-0.5 size-3.5 shrink-0 text-warn" aria-hidden="true" />
    <div class="min-w-0">
      <p data-testid="inbound-frame-dropped-title" class="text-[12.5px] font-medium leading-snug text-neutral-fg">
        {{ title }}
      </p>
      <p data-testid="inbound-frame-dropped-hint" class="mt-1 select-text text-[12px] leading-snug text-neutral-fg opacity-70">
        {{ hint }}
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { TriangleAlert } from '@lucide/vue'
import { useInboundFrameGuardState } from '@/composables/useInboundFrameGuard'

const props = defineProps<{
  /** 本提示条所属 session（终止阀按 session 隔离判定） */
  sessionId: string
}>()

const { trippedSessionIds } = useInboundFrameGuardState()
const { locale } = useI18n()

const tripped = computed(() => trippedSessionIds.value.has(props.sessionId))

// 文案内建双语字面量（按 i18n locale 判定），未进 i18n 注册表——聚合行文件
// （locales/zh-CN.ts / en-US.ts）是并行单元热点（u3b/u7d 批次共改），本单元领地不含
// i18n 文件。i18n 注册迁移随批次收口（阶段 6 文档同步义务）统一补齐。
const TEXT = {
  zh: {
    title: '本会话数据流已暂停',
    hint: '连续收到超大数据帧，已自动停止重试以保护页面。切换到其他会话再切回本会话即可重试连接。',
  },
  en: {
    title: 'Session stream paused',
    hint: 'Oversized data frames were received repeatedly and retrying has been stopped to protect the page. Switch to another session and back to retry.',
  },
} as const

const title = computed(() => (locale.value.startsWith('zh') ? TEXT.zh.title : TEXT.en.title))
const hint = computed(() => (locale.value.startsWith('zh') ? TEXT.zh.hint : TEXT.en.hint))
</script>
