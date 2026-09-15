<template>
  <!--
    展示组件 · bash 执行结果（composer-bash-execute W3）。
    渲染 role:'system' + bashExecution 的消息：composer 直接执行的 bash 命令结果气泡。

    生命周期：
    - bashStart 创建 streaming 态 system 消息（loading，显示 spinner + 取消按钮）
    - bashResult 锢定该消息更新为 complete 态（显示 output + exitCode 标签）

    视觉定位：极简风（无边框/无浅底，对齐 trace block 的 trace-blk py-2 样式），
    与普通 system 提示行（SystemNotice）区分靠 header 的 command + exit 标签等语义标识，
    不再靠卡片背景。与 toolCall 互斥（bash 不走工具链，不挂 assistant turn）。

    [cw wave w3] virtua ListItem 内部 RO 观测根元素高度，应用层无需自行上报——
    BashOutputBlock 作为 Virtualizer 子项挂载后由 virtua 统一接管测高，无需注册 useResizeReport。

    灰阶化（main-fusion W4 / §13.2-D）：terminal 图标改 neutral-ico，streaming 态改用本分支
    双环 loader-spin（复用 Block.vue 的 RUNNING_LOADER_SVG + animate-loader-spin），timeout/
    cancelled 改 neutral-dim，exit 0 保留 success（唯一彩色例外，成功确认语义），exit N 改 warn
    （哑光金，bash exit N 是用户命令失败非致命，不该用 danger 红告警权重）。取消按钮/输出文本/
    截断标记/空输出占位全切到 neutral-* 谱系。结构层零改动（bashExecution 消费 /
    exitCode/timeout/cancelled/truncated 语义全保留）。
  -->
  <div
    class="bash-output-block content-col flex flex-col gap-1.5 py-2"
    data-testid="bash-output-block"
  >
    <!-- 头部行：command 文本 + 状态标签（+ no context 标记 + 取消按钮） -->
    <div class="flex items-start justify-between gap-2">
      <div class="flex min-w-0 flex-1 items-center gap-1.5">
        <!-- S9：SquareTerminal 图标前缀增强 shell prompt 语义（灰阶 neutral-ico，§13.2-D，对齐 demo BashBlock 14px） -->
        <SquareTerminal class="size-3.5 shrink-0 text-neutral-ico" />
        <span class="min-w-0 flex-1 truncate font-mono text-[length:var(--text-xs)] leading-snug text-neutral-fg">{{ bash?.command || t('panel.message.bashUnknownCommand') }}</span>
        <span
          v-if="bash?.excludeFromContext"
          class="shrink-0 rounded-sm border border-border px-1 py-0.5 text-[length:var(--text-2xs)] leading-none text-neutral-dim"
          data-testid="bash-no-context-tag"
        >{{ t('panel.message.bashNoContext') }}</span>
      </div>
      <div class="flex shrink-0 items-center gap-1.5">
        <!-- 灰阶化（§13.2-D）：streaming 态改用本分支双环 loader-spin（复用 Block.vue RUNNING_LOADER_SVG +
             animate-loader-spin，accent 蓝），替代 main 的 Loader2 animate-spin -->
        <span
          v-if="isStreaming"
          class="flex items-center gap-1 text-[length:var(--text-xs)] leading-none text-accent"
          data-testid="bash-streaming-spinner"
        >
          <!-- eslint-disable-next-line vue/no-v-html -- hardcoded constant from block-icon.ts -->
          <span class="inline-flex size-3 items-center justify-center animate-loader-spin" v-html="RUNNING_LOADER_SVG" />
        </span>
        <!-- W5：error==='timeout'（超时收口形态）优先于 cancelled，显示「超时」与「已取消」区分。
             灰阶化：timeout/cancelled 改 neutral-dim（§13.2-D，非终端语义色） -->
        <span
          v-else-if="isTimeout"
          class="font-mono text-[length:var(--text-xs)] leading-none text-neutral-dim"
          data-testid="bash-status-tag"
        >{{ t('panel.message.bashTimeout') }}</span>
        <span
          v-else-if="isCancelled"
          class="font-mono text-[length:var(--text-xs)] leading-none text-neutral-dim"
          data-testid="bash-status-tag"
        >{{ t('panel.message.bashCancelled') }}</span>
        <span
          v-else
          class="font-mono text-[length:var(--text-xs)] leading-none"
          :class="exitCodeClass"
          data-testid="bash-status-tag"
        >exit {{ bash?.exitCode }}</span>
        <Button
          v-if="isStreaming"
          variant="ghost"
          size="sm"
          class="h-auto p-0 text-[length:var(--text-xs)] text-neutral-dim hover:text-neutral-fg"
          data-testid="bash-cancel-btn"
          @click="onCancel"
        >{{ t('panel.message.bashCancel') }}</Button>
      </div>
    </div>

    <!--
      输出区：complete 态才显示。极简风（去 rounded-sm/bg-surface-2/50），保留 max-h + overflow-auto
      （长输出双向滚动）。S8：pre 用 whitespace-pre（非 break-all）保留宽表格/ASCII art 对齐，
      超宽内容（如 base64）走横向滚动条——bash 输出更常见的是表格/对齐文本，保留对齐更重要。
    -->
    <div
      v-if="!isStreaming && hasOutput"
      class="max-h-[var(--bash-output-max-height)] overflow-auto px-2 py-1 font-mono text-[length:var(--text-xs)] leading-relaxed text-neutral-mid"
      data-testid="bash-output"
    >
      <pre class="whitespace-pre font-mono">{{ bash?.output }}</pre>
      <!-- W4：消费 truncated 字段——pi 对超长输出截断时返回 truncated:true，显示截断标记（前端只显示，不自行截断）。
           灰阶化（§13.2-D）：截断标记改 neutral-dim italic -->
      <div
        v-if="bash?.truncated"
        class="mt-1 text-[length:var(--text-2xs)] italic leading-none text-neutral-dim"
        data-testid="bash-output-truncated"
      >{{ t('panel.message.bashOutputTruncated') }}</div>
    </div>
    <p
      v-else-if="!isStreaming && !hasOutput"
      class="text-[length:var(--text-xs)] leading-snug text-neutral-dim"
      data-testid="bash-output-empty"
    >{{ t('panel.message.bashNoOutput') }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { SquareTerminal } from '@lucide/vue'
// 经 primitives 子模块直接导入而非 @taiji/ui 顶层 barrel：本组件被 Turn.vue 直接
// 引用且经 features/chat barrel 再导出，顶层 barrel 自引用会闭合
// BashOutputBlock → index → features/chat → Turn → BashOutputBlock 循环依赖环
// （Turn.vue W4·D4 turn 内 notice 编排引入，运行时解析结果与 barrel re-export 一致）
import { Button } from '../../primitives/button'
import { RUNNING_LOADER_SVG } from './block-icon'
import { useChatViewDeps } from './chat-view-deps'
import type { Message } from '@taiji/shared'

const props = defineProps<{
  message: Message
  /** 当前 session id（取消按钮调 abortBash 用） */
  sessionId: string
}>()

const { t } = useI18n()
const { abortBash } = useChatViewDeps()

// [cw wave w3] virtua ListItem 内部 RO 观测根元素，应用层无需自行上报高度。

const bash = computed(() => props.message.bashExecution)
const isStreaming = computed(() => props.message.status === 'streaming')
// W5：error==='timeout'（超时收口形态值）优先于 cancelled——超时与主动取消视觉需区分。
// 模板优先级：isTimeout > isCancelled > 正常 exit 标签。
const isTimeout = computed(() => props.message.error === 'timeout')
const isCancelled = computed(() => bash.value?.cancelled === true)
const hasOutput = computed(() => !!bash.value?.output)

/**
 * exitCode 标签颜色（灰阶化 §13.2-D）：
 * - timeout/cancelled → neutral-dim（非终端语义色，中性弱化）
 * - exit 0 → success（绿，唯一彩色例外——成功确认语义，与 §6 failed 用 warn 对称）
 * - exit N(>0) → warn（哑光金，CL6 决策：bash exit N 是用户命令失败非致命，不该用 danger 红告警权重）
 */
const exitCodeClass = computed(() => {
  if (isTimeout.value || isCancelled.value) return 'text-neutral-dim'
  const code = bash.value?.exitCode
  if (code === 0) return 'text-success'
  return 'text-warn'
})

function onCancel(): void {
  abortBash(props.sessionId)
}
</script>
