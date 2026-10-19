<template>
  <!--
    ReadFileCode —— read 工具展开细节的文件代码块（tool-detail-rich γ 形态）。

    形态：border-strong 细框（md 代码块是 hairline）+ 行号 gutter + 截断脚注行，无 header
    （路径元信息已在 trace 行 header 的 `read · path`，块内零 chrome 套娃）。行号 = 「文件」
    语义的最强区分信号（对话流 md 代码块无行号）。内部高亮与 md 完全同一 shiki 通道
    （highlightCode 单例，min-dark/min-light 双主题 token）。

    行号实现 = CSS counters（shiki 每行产出 <span class="line">，::before 挂 counter）——
    整块一次 highlightCode（千行单次调用，非 DiffView 的逐行模式），行号与代码行天然同
    行盒对齐。起始行号 = read input.offset（分段读续读时行号连续）。

    水平滚动自管理（overflow-x-auto，宿主 BlockScrollBox 只管 overflow-y 限高）。
  -->
  <div class="read-code overflow-hidden rounded-sm border border-border-strong bg-bg-input">
    <div class="overflow-x-auto">
      <!-- v-html 受控点：shiki codeToHtml 转义所有非 token 文本（只发 scoped span），与
           CodeBlock/DiffView/MarkdownRenderer 同一 XSS 论证。 -->
      <!-- eslint-disable vue/no-v-html -->
      <div
        v-if="html"
        class="read-code-body py-2 font-mono text-[length:var(--text-xs)] leading-[1.55]"
        :style="counterStyle"
        v-html="html"
      />
      <!-- eslint-enable vue/no-v-html -->
      <!-- shiki 未就绪/高亮失败降级：纯文本插值（XSS 安全），无行号 -->
      <pre
        v-else
        class="m-0 whitespace-pre-wrap break-all p-2 font-mono text-[length:var(--text-xs)] leading-[1.55] text-neutral-fg/90"
      >{{ content }}</pre>
    </div>
    <!-- 截断/续读提示（pi read 输出尾部自带的 [Showing lines ...] 等脚注，上移为块内收尾行） -->
    <div
      v-if="footer"
      class="border-t border-hairline px-3 py-1 font-mono text-[length:var(--text-2xs)] text-neutral-dim"
      data-testid="read-code-footer"
    >{{ footer }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { highlightCode } from '@taiji/ui/features/chat/markdown'
import { extToLang } from '@/composables/logic/file-type'

const props = defineProps<{
  /** 文件内容（pi read output，已由上游剥掉截断脚注） */
  content: string
  /** 文件路径（推断 shiki 语言） */
  path: string
  /** 起始行号（read input.offset，分段读续读时行号连续；缺省 1） */
  startLine?: number
  /** 截断脚注（pi read 输出尾部提示原文，块内底部收尾行展示） */
  footer?: string
}>()

const html = ref('')
let renderSeq = 0

/** CSS counter 起始值（base reset 与 offset 合一）：首个 ::before 自增后即 startLine（缺省 1） */
const counterStyle = ref<Record<string, string>>({ counterReset: 'rbi-line 0' })

watch(
  () => [props.content, props.path, props.startLine] as const,
  async ([content, path, startLine]) => {
    if (!content) {
      html.value = ''
      return
    }
    const seq = ++renderSeq
    counterStyle.value = { counterReset: `rbi-line ${(startLine ?? 1) - 1}` }
    try {
      const rendered = await highlightCode(content, extToLang(path))
      if (seq === renderSeq) html.value = rendered
    } catch {
      // 高亮失败降级纯文本（html 置空走 pre 分支，无行号但有内容）
      if (seq === renderSeq) html.value = ''
    }
  },
  { immediate: true },
)
</script>

<style scoped>
/* 行号 gutter 与 shiki 双主题（:deep()/伪元素选择器是 Tailwind 表达不了的 escape hatch）。
   字体/字号/行高/内边距走模板 utilities；counter-reset 基值走 inline style（offset 可变）。
   shiki 双主题切换（CodeBlock/DiffView 同机制）：暗为默认，亮主题经 :global 覆盖。 */
.read-code-body :deep(span) {
  color: var(--shiki-dark);
}
:global([data-theme="light"] .read-code-body span) {
  color: var(--shiki-light);
}
/* 行号 gutter：shiki 每行 <span class="line"> 挂 CSS counter（同行盒内 ::before，天然对齐） */
.read-code-body :deep(span.line) {
  counter-increment: rbi-line;
}
.read-code-body :deep(span.line)::before {
  content: counter(rbi-line);
  display: inline-block;
  width: 2.4em;
  margin-right: 1.2em;
  padding-right: 0.6em;
  text-align: right;
  color: var(--neutral-faint);
  opacity: 0.7;
  user-select: none;
}
</style>
