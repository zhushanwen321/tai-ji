<template>
  <!--
    DetailPane —— 文件预览面板（#6，UC-6，对齐 draft-detail-pane.html）。
    文件内容 / diff 预览，挂在 SideDrawer detail tab。

    [NFR-AC-S4] 禁 v-html：内容用 <pre> + {{ }} 文本插值渲染，XSS 安全（T6.10）。
    data-testid 标注供 E2E 选择器。

    数据来源：useDetailPane（watch selectedPath → openPreview → git.getDiff / file.read）。
  -->
  <div class="flex h-full flex-col" data-testid="detail-pane">
    <!-- header：文件名（hover 显绝对路径 + 复制文件名）+ 复制绝对路径按钮 + view toggle -->
    <div class="flex items-center gap-2 border-b border-hairline px-2 py-1.5">
      <FileText class="size-3.5 shrink-0 text-neutral-dim" />
      <HoverCard :open-delay="0">
        <HoverCardTrigger as-child>
          <span
            data-testid="detail-filename"
            class="flex-1 cursor-default truncate font-mono text-[length:var(--text-2xs)] text-neutral-fg"
          >{{ fileName }}</span>
        </HoverCardTrigger>
        <HoverCardContent class="w-auto max-w-md p-2" side="bottom">
          <div data-testid="detail-path-tooltip" class="flex flex-col gap-1.5">
            <div class="flex items-center gap-2">
              <span class="font-mono text-[length:var(--text-2xs)] text-neutral-fg">{{ fileName }}</span>
              <Button
                variant="ghost"
                data-testid="detail-copy-filename"
                class="h-5 w-5 rounded-sm p-0"
                :title="t('panel.detail.copyFileName')"
                :disabled="!fileName || fileName === t('panel.sideDrawer.noFileSelected')"
                @click="copy(fileName, 'filename')"
              >
                <Check v-if="copied === 'filename'" class="size-3 text-accent" />
                <Copy v-else class="size-3 text-neutral-dim" />
              </Button>
            </div>
            <div class="flex items-center gap-2">
              <span class="break-all font-mono text-[length:var(--text-3xs)] text-neutral-mid">{{ absolutePath }}</span>
              <Button
                variant="ghost"
                data-testid="detail-copy-path"
                class="h-5 w-5 rounded-sm p-0"
                :title="t('panel.detail.copyFilePath')"
                :disabled="!absolutePath"
                @click="copy(absolutePath, 'path')"
              >
                <Check v-if="copied === 'path'" class="size-3 text-accent" />
                <Copy v-else class="size-3 text-neutral-dim" />
              </Button>
            </div>
          </div>
        </HoverCardContent>
      </HoverCard>
      <Button
        variant="ghost"
        data-testid="detail-copy-path"
        class="h-6 w-6 rounded-sm p-0"
        :title="t('panel.detail.copyFilePath')"
        :disabled="!absolutePath"
        @click="copy(absolutePath, 'path')"
      >
        <Check v-if="copied === 'path'" class="size-3.5 text-accent" />
        <Copy v-else class="size-3.5 text-neutral-dim" />
      </Button>
      <!-- FR-3: 加入文件引用到 composer（无行范围，target=current） -->
      <Button
        variant="ghost"
        data-testid="detail-inject-file"
        class="h-6 w-6 rounded-sm p-0"
        :title="t('panel.detail.injectFileRef')"
        :disabled="!state.path"
        @click="injectFileRef()"
      >
        <Quote class="size-3.5 text-neutral-dim" />
      </Button>
      <!-- view toggle：有 git 改动时可切换 diff/preview -->
      <div v-if="state.hasGitChange" class="flex gap-0.5 rounded-md bg-bg-input p-0.5" data-testid="detail-view-toggle">
        <Button
          variant="ghost"
          class="h-6 rounded-sm px-1.5 text-[length:var(--text-3xs)]"
          :class="state.viewMode === 'diff' ? 'bg-bg-elevated text-neutral-fg' : 'text-neutral-mid'"
          :title="t('panel.detail.showDiff')"
          @click="onToggleView('diff')"
        >{{ t('panel.detail.tabDiff') }}</Button>
        <Button
          variant="ghost"
          class="h-6 rounded-sm px-1.5 text-[length:var(--text-3xs)]"
          :class="state.viewMode === 'preview' ? 'bg-bg-elevated text-neutral-fg' : 'text-neutral-mid'"
          :title="t('panel.detail.showPreview')"
          @click="onToggleView('preview')"
        >{{ t('panel.detail.preview') }}</Button>
      </div>
    </div>

    <!-- 加载态（骨架，AC-6.6/T6.7：异步返回前非空白） -->
    <div
      v-if="state.status === 'loading'"
      class="flex flex-1 flex-col items-center justify-center gap-2 p-4"
      data-testid="detail-loading"
    >
      <Loader2 class="size-4 animate-spin text-neutral-dim opacity-60" />
      <p class="text-[length:var(--text-2xs)] text-neutral-dim opacity-60">{{ t('panel.detail.loading') }}</p>
    </div>

    <!-- 错误态（AC-6.4/T6.4：权限/不存在 → 错误态） -->
    <div
      v-else-if="state.status === 'error'"
      class="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center"
      data-testid="detail-error"
    >
      <AlertCircle class="size-5 text-danger opacity-60" />
      <p class="text-[length:var(--text-2xs)] text-neutral-mid">{{ t('panel.detail.cannotPreview') }}</p>
      <p class="font-mono text-[length:var(--text-3xs)] text-neutral-dim opacity-70">{{ state.error }}</p>
    </div>

    <!-- 空态（无选中文件） -->
    <div
      v-else-if="state.status === 'idle' || !state.path"
      class="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center"
      data-testid="detail-empty"
    >
      <FileText class="size-6 text-neutral-dim opacity-40" />
      <p class="text-[length:var(--text-2xs)] text-neutral-dim opacity-55">{{ t('panel.detail.clickFilePreview') }}</p>
    </div>

    <!-- 二进制文件占位（AC-6.5/T6.6：binary=true） -->
    <div
      v-else-if="state.binary"
      class="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center"
      data-testid="detail-binary"
    >
      <ImageIcon class="size-6 text-neutral-dim opacity-50" />
      <p class="text-[length:var(--text-2xs)] text-neutral-mid">{{ t('panel.detail.binaryFile') }}</p>
      <p class="font-mono text-[length:var(--text-3xs)] text-neutral-dim opacity-60">{{ t('panel.detail.cannotShowDiff') }}</p>
    </div>

    <!-- 内容区：按 viewMode + kind 分发渲染（禁 v-html，<pre> + 文本插值，XSS 安全；
         markdown/code/diff 经各自渲染器的受控 v-html 点处理，论证 XSS 安全）。
         @mouseup 检测选区（FR-4）：选中文本后弹引用 bubble。
         @scroll 清 selectionRange：滚动后选区定位偏移、bubble 不再贴合原文，
         残留 bubble 会误导用户注入错误行范围，故滚动即清。 -->
    <div
      v-else
      ref="contentRef"
      class="relative min-h-0 flex-1 overflow-auto"
      data-testid="detail-content"
      @mouseup="onContentMouseup"
      @scroll="onContentScroll"
    >
      <!-- 截断提示（>1MB，AC-6.5/T6.5） -->
      <div
        v-if="state.truncated"
        class="border-b border-warn/30 bg-warn-soft px-2 py-1 text-[length:var(--text-3xs)] text-warn"
        data-testid="detail-truncated"
      >
        {{ t('panel.detail.truncated') }}
      </div>

      <!-- FR-4: 选区引用 bubble。选中文本后 mouseup 触发，提供引用到当前/新对话。
           absolute 定位在内容区右上（首版不跟随 range，简化定位）。 -->
      <div
        v-if="selectionRange"
        class="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-sm border border-border bg-surface p-1 shadow-md"
        data-testid="detail-selection-bubble"
      >
        <Button
          variant="ghost"
          size="sm"
          data-testid="bubble-inject-current"
          class="h-6 rounded-sm px-2 text-[length:var(--text-2xs)]"
          @mousedown.prevent
          @click="injectSelectionToCurrent"
        >{{ t('panel.detail.injectFileRef') }}</Button>
        <Button
          variant="ghost"
          size="sm"
          data-testid="bubble-inject-new"
          class="h-6 rounded-sm px-2 text-[length:var(--text-2xs)]"
          @mousedown.prevent
          @click="injectSelectionToNew"
        >{{ t('panel.detail.injectToNew') }}</Button>
      </div>

      <!-- ── diff 模式：所有文件类型统一走 DiffView（parseDiff 着色）── -->
      <DiffView
        v-if="state.viewMode === 'diff'"
        :patch="state.content"
        :path="state.path ?? undefined"
        data-testid="detail-diff"
        @line-inject="injectFileRef($event.lineNo, $event.lineNo)"
      />

      <!-- ── preview 模式：按 kind 分发 ── -->
      <template v-else>
        <!-- markdown：复用 MarkdownRenderer（shiki + markdown-it）。
             text-[length:var(--text-sm)] 约束基础字号——MarkdownRenderer 的 .md-render 无基础 font-size，
             在对话流里靠气泡 text-[length:var(--text-base)] 拉低；此处不约束会继承浏览器默认 16px 整体偏大。
             统一到 --text-sm（12px）与 DetailPane 其他渲染路径（code/text/diff）一致。 -->
        <MarkdownRenderer
          v-if="state.kind === 'markdown'"
          :content="state.content"
          :session-id="sessionId ?? undefined"
          :resource-base-dir="resourceBaseDir"
          class="detail-md p-2 text-[length:var(--text-sm)] leading-[1.5]"
          data-testid="detail-markdown"
        />
        <!-- image：local-file:// 协议直载（main.ts:142 注册，绕过 file.read 的 utf8 损坏） -->
        <div
          v-else-if="state.kind === 'image'"
          class="flex items-center justify-center p-2"
          data-testid="detail-image"
        >
          <img
            v-if="imageUrl"
            :src="imageUrl"
            :alt="fileName"
            class="max-h-full max-w-full object-contain"
            @error="onImageError"
          />
          <!-- 图片加载失败（403 白名单/文件损坏）降级占位 -->
          <div v-else class="flex flex-col items-center gap-1 text-center">
            <ImageIcon class="size-6 text-neutral-dim opacity-50" />
            <p class="text-[length:var(--text-2xs)] text-neutral-mid">{{ t('panel.detail.loadFailed') }}</p>
            <p class="font-mono text-[length:var(--text-3xs)] text-neutral-dim opacity-60">{{ state.path }}</p>
          </div>
        </div>
        <!-- code：CodeBlock shiki 高亮 -->
        <div
          v-else-if="state.kind === 'code'"
          class="p-2"
          data-testid="detail-code"
        >
          <CodeBlock :code="state.content" :lang="lang" />
        </div>
        <!-- text（兜底）：纯文本插值 -->
        <pre
          v-else
          class="whitespace-pre-wrap break-all p-2 font-mono text-[length:var(--text-xs)] leading-[1.5] text-neutral-fg/90"
          data-testid="detail-text"
        >{{ state.content }}</pre>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, provide, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { FileText, Loader2, AlertCircle, Image as ImageIcon, Copy, Check, Quote } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { useDetailPane, type DetailViewMode } from '@/composables/features/file-tree/useDetailPane'
import { useCopy } from '@/composables/panel/useCopy'
import { composerInjectionStore } from '@/composables/panel/composer-injection-store'
import { extToLang } from '@/composables/logic/file-type'
import { resolvePreviewPath } from '@/lib/path-utils'
import { MarkdownRenderer, ChatViewDepsKey } from '@taiji/ui'
import CodeBlock from '@/components/panel/detail-renderers/CodeBlock.vue'
import DiffView from '@/components/panel/detail-renderers/DiffView.vue'
import { useChatViewDeps } from '@/composables/panel/useChatViewDeps'

const { t } = useI18n()

const { copied, copy } = useCopy()
const composerInjection = composerInjectionStore

/** 内容区 ref（FR-4 选区检测用） */
const contentRef = ref<HTMLElement | null>(null)
/** 当前选区的行范围（FR-4 bubble 显隐驱动）。null=无选区/bubble 隐藏 */
const selectionRange = ref<{ lineStart: number; lineEnd: number } | null>(null)

const props = defineProps<{
  /** widget 订阅的 session 标识（与 SideDrawer sessionId 一致，useDetailPane watch 用） */
  sessionId: string | null
}>()

const { state, toggleView, sessionCwd } = useDetailPane(
  computed(() => props.sessionId),
)

// [w6 T6] ui MarkdownRenderer 经 ChatViewDeps inject 消费壳层依赖。DetailPane 不在 MessageStream
// provide 作用域内，需自行 provide（sessionId 可为 null，coalesce '' 后 renderMarkdown 无路径链接降级）。
// provide 语句在下方 resourceBaseDir computed 声明之后（override 对象字面量即时求值，前置会 TDZ）。

/** 文件名（basename，从 state.path 取） */
const fileName = computed(() => {
  if (!state.value.path) return t('panel.sideDrawer.noFileSelected')
  const parts = state.value.path.split('/')
  return parts[parts.length - 1] ?? state.value.path
})

/** 绝对路径：session cwd + 相对路径；若 path 已是绝对路径则直接使用。 */
const absolutePath = computed(() => {
  const cwd = sessionCwd(props.sessionId)
  if (!cwd || !state.value.path) return ''
  return resolvePreviewPath(cwd, state.value.path).absolute
})

/**
 * 相对资源解析基准目录（MarkdownRenderer resourceBaseDir，设计 markdown-html-sanitize-render
 * D4）：打开文件所在目录（absolutePath 取 dirname）。无 cwd / 无 path → undefined（该文档
 * 不做相对资源解析）。drawer 预览的相对 img src / 相对链接都按文件自身目录解析。
 */
const resourceBaseDir = computed<string | undefined>(() => {
  const abs = absolutePath.value
  if (!abs) return undefined
  const slash = abs.lastIndexOf('/')
  if (slash <= 0) return undefined
  return abs.slice(0, slash)
})

// [w6 T6] provide（须在上方 resourceBaseDir 声明之后，见前注）。工厂 override 参数（设计 D4
// 矩阵 drawer 行「两通道同值」）：env 通道（sanitize hook img 相对 src 重写）不再用 session
// cwd，与本组件传给 MarkdownRenderer 的 props 通道（④路点击）同用文件所在目录——修正
// R-B 审查发现的「env=session cwd vs props=文件目录」双基准分裂（子目录文档相对 img 曾按
// session cwd 错位解析）。
provide(
  ChatViewDepsKey,
  useChatViewDeps(computed(() => props.sessionId ?? ''), { resourceBaseDir }),
)

/** shiki 语言名（code 类文件高亮用） */
const lang = computed(() => extToLang(state.value.path ?? ''))

/**
 * 图片加载失败标志（local-file:// 403 白名单/文件损坏时 onerror 置 true，降级占位）。
 * 切文件时重置。
 */
const imageLoadFailed = ref(false)

/**
 * 图片 URL：按路径类型解析为绝对路径后拼成 local-file:// 协议 URL。
 * - main.ts:142 的 protocol.handle('local-file') 拦截，白名单含 homedir()（cwd 通常在其下）
 * - encodeURIComponent 处理中文/空格路径（main.ts:143 decodeURIComponent 还原）
 * - 无 cwd 或加载失败 → null（模板走占位分支）
 */
const imageUrl = computed(() => {
  if (imageLoadFailed.value) return null
  const cwd = sessionCwd(props.sessionId)
  if (!cwd || !state.value.path) return null
  const absPath = resolvePreviewPath(cwd, state.value.path).absolute
  return `local-file:///${encodeURIComponent(absPath)}`
})

/** img onerror：白名单 403 / 文件损坏 → 标记失败降级占位 */
function onImageError(): void {
  imageLoadFailed.value = true
}

// 切文件时重置图片失败标志（新文件应重新尝试加载）
watch(
  () => state.value.path,
  () => {
    imageLoadFailed.value = false
  },
)

function onToggleView(mode: DetailViewMode): void {
  void toggleView(mode)
}

/**
 * 注入当前预览文件的 file chip 到 composer（FR-3 header 按钮）。
 * 无行范围，target=current（当前 session 的 composer）。
 * DiffView 行级点击（FR-5）也经此函数，带 lineStart/lineEnd。
 */
function injectFileRef(lineStart?: number, lineEnd?: number): void {
  if (!state.value.path) return
  composerInjection.requestInjection({
    target: 'current',
    path: state.value.path,
    lineStart,
    lineEnd,
    sessionId: props.sessionId,
  })
}

/**
 * 注入选区到新对话（FR-4 bubble "新对话" 按钮）。
 * target=new：触发 useNewTaskFlow 进 landing 后注入。
 */
function injectSelectionToNew(): void {
  if (!state.value.path || !selectionRange.value) return
  composerInjection.requestInjection({
    target: 'new',
    path: state.value.path,
    lineStart: selectionRange.value.lineStart,
    lineEnd: selectionRange.value.lineEnd,
    sessionId: props.sessionId,
  })
  selectionRange.value = null
}

/**
 * 内容区滚动：清 selectionRange（W11，规则 15——模板内联副作用抽方法）。
 * 滚动后选区定位偏移、bubble 不再贴合原文，残留会误导用户注入错误行范围，故滚动即清。
 */
function onContentScroll(): void {
  selectionRange.value = null
}

/**
 * 内容区 mouseup：检测选区，非空且在内容区内时计算行范围显 bubble（FR-4）。
 * 行范围反推分模式：
 * - diff 模式：从选区起止行元素读 data-line（newNo）精确反推（DiffView 行 div 标了 data-line）
 * - preview/code 模式：优先从 DOM 行节点（shiki `.line` / `<pre>` 文本）精确反推行号
 *   （W14：原 findIndex 反推命中重复行首项致 selectionRange 指向错误行）；DOM 取不到时
 *   退化为「带上下文的文本匹配」（首尾行同时比对缩小歧义），仍无果则不显 bubble。
 */
function onContentMouseup(): void {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    selectionRange.value = null
    return
  }
  // 选区必须在内容区内
  const range = sel.getRangeAt(0)
  if (!contentRef.value || !contentRef.value.contains(range.commonAncestorContainer)) {
    selectionRange.value = null
    return
  }
  const selectedText = sel.toString()
  if (!selectedText.trim()) {
    selectionRange.value = null
    return
  }
  // diff 模式：从选区起止行元素读 data-line（newNo）精确反推行号。
  // state.content 是 patch 文本，文本匹配失效；DiffView 行 div 标了 data-line=newNo。
  if (state.value.viewMode === 'diff') {
    const rangeFromLine = findDataLineFromNode(range.startContainer)
    const rangeToLine = findDataLineFromNode(range.endContainer)
    if (rangeFromLine === null || rangeToLine === null) {
      // 选区起止不在有效行（如选中纯删除行无 newNo）→ 无法定位，不显 bubble
      selectionRange.value = null
      return
    }
    selectionRange.value = {
      lineStart: Math.min(rangeFromLine, rangeToLine),
      lineEnd: Math.max(rangeFromLine, rangeToLine),
    }
    return
  }
  // preview/code 模式：优先从 DOM 行节点精确反推（W14）。
  // CodeBlock 用 shiki 渲染，每行一个 `<span class="line">`；找到选区起止所在行节点，
  // 按其在容器内的行序算 1-based 行号。纯文本 mode（pre 文本插值）无 .line，落到下方文本回退。
  const fromLine = findCodeLineIndex(range.startContainer)
  const toLine = findCodeLineIndex(range.endContainer)
  if (fromLine !== null && toLine !== null) {
    selectionRange.value = {
      lineStart: Math.min(fromLine, toLine),
      lineEnd: Math.max(fromLine, toLine),
    }
    return
  }
  // 文本回退（纯文本 mode / shiki 未就绪降级 pre）：首尾行同时比对缩小重复行歧义。
  // 仍用文本匹配因 pre 无行节点；相比原 findIndex 增加首尾双锚，命中重复行更稳。
  const lines = state.value.content.split('\n')
  const selLines = selectedText.split('\n')
  const firstLine = selLines[0] ?? ''
  const lastLine = selLines[selLines.length - 1] ?? ''
  const lineCount = selLines.length
  const idx = findUniqueLineIndex(lines, firstLine, lastLine, lineCount)
  if (idx < 0) {
    selectionRange.value = null
    return
  }
  selectionRange.value = { lineStart: idx + 1, lineEnd: idx + lineCount }
}

/**
 * 从 DOM 节点向上找最近的 [data-line] 行元素，返回其行号（newNo）。
 * diff 模式选区反推用：选区起止节点向上追溯到 DiffView 行 div，读 data-line。
 * 无 data-line（纯删除行无 newNo）返回 null——这些行不可定位行号。
 */
function findDataLineFromNode(node: Node): number | null {
  let el: Element | null = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  while (el && contentRef.value?.contains(el)) {
    const dl = el.getAttribute('data-line')
    if (dl !== null && dl !== '') {
      const n = Number(dl)
      if (!Number.isNaN(n)) return n
    }
    el = el.parentElement
  }
  return null
}

/**
 * 从选区节点反推所在代码行的 1-based 行号（W14，preview/code 模式）。
 * CodeBlock 经 shiki 渲染产出 `<span class="line">` 行节点；从 node 向上找到最近的 `.line`，
 * 再统计它在 CodeBlock 容器内之前的 `.line` 兄弟数 +1 即行号（精确，重复行不受影响）。
 * 节点不在任何 `.line` 内（如纯文本 mode 的 pre 文本、shiki 未就绪降级）返回 null，由调用方文本回退。
 */
function findCodeLineIndex(node: Node): number | null {
  if (!contentRef.value) return null
  let el: Element | null = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  while (el && contentRef.value.contains(el)) {
    if (el.classList?.contains('line')) {
      // 行号 = 该行之前的 .line 兄弟数 + 1（1-based，与 state.content 行号对齐）
      let lineNo = 1
      let prev: Element | null = el.previousElementSibling
      while (prev) {
        if (prev.classList?.contains('line')) lineNo++
        prev = prev.previousElementSibling
      }
      return lineNo
    }
    el = el.parentElement
  }
  return null
}

/**
 * 在 lines 里定位首行唯一位置（W14 文本回退）：原 findIndex 只比首行 trim()，
 * 重复行命中最早一次。改为「首行 + 尾行 + 行数」三锚点匹配——候选首行位置后
 * lines[idx..idx+lineCount-1] 首尾需同时匹配才采纳，缩小重复行歧义。
 * 仍可能近似（极端重复内容），但比单行匹配显著更稳。
 */
function findUniqueLineIndex(
  lines: string[],
  firstLine: string,
  lastLine: string,
  lineCount: number,
): number {
  const firstTrim = firstLine.trim()
  const lastTrim = lastLine.trim()
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== firstTrim) continue
    // 单行选区：首尾同匹配即可
    if (lineCount <= 1) return i
    const tailIdx = i + lineCount - 1
    if (tailIdx < lines.length && lines[tailIdx].trim() === lastTrim) return i
  }
  return -1
}

/** bubble 引用到当前对话（FR-4）：用 selectionRange 行范围注入 */
function injectSelectionToCurrent(): void {
  if (!selectionRange.value) return
  injectFileRef(selectionRange.value.lineStart, selectionRange.value.lineEnd)
  selectionRange.value = null
}
</script>
