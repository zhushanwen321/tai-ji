<!--
  HtmlPreviewInline —— html-preview fence 的内联预览容器（chat-html-support §6.3 D3，v16 形态变更）。

  形态：fence info 首词为 `html-preview`、内容为被预览 HTML 文件路径（绝对路径直用——
  含 `~` 家目录形态；相对路径按 resourceBaseDir ?? sessionCwdOf(sessionId) 矩阵解析，与
  MarkdownRenderer ④路同一传值矩阵）。消息流内原位渲染：头部条（文件名 + 大小 +
  「源码 | 预览」切换默认预览 + 刷新 + 收起/展开）+ sandbox iframe 本体；预检不过时容器
  退化为降级占位（原卡片降级形态延续）。

  高度策略（实施降级，设计 §6.3 高度自适应条款「协作脚本不可假设」）：iframe 高度固定
  480px（超限 iframe 内部滚动），「展开」切 720px——不做内容高度自适应。原设计的
  postMessage 上报要求产物文档内有协作脚本，而产物 HTML 是 agent 写的、不可假设协作；
  sandbox allow-scripts（无 allow-same-origin）为 opaque origin，load 后父页面读
  contentDocument 恒为 null，无量高通道（平台语义，非实现缺口）。

  安全不变量：容器 DOM 由本 Vue 模板产出，样式走 Tailwind 工具类与既有设计 token，
  **不经过** v-html / DOMPurify / 信任槽——用户 HTML 的白名单契约（class/style/data-*
  构造性全剥）不受影响；段载荷本身只是路径字符串。iframe sandbox 权限面 = `allow-scripts`
  单权限（opaque origin，不给 allow-same-origin / allow-top-navigation / allow-popups /
  allow-forms，平移自原抽屉渲染态 §6.4）。

  预检：挂载前经 deps.probeArtifact（可选，跨层注入口）调主进程 localFile:servable 通道 →
  { servable, reason, size }。三原因（not_found / is_dir / out_of_whitelist）→ 降级占位；
  servable → 头部显文件名与大小、iframe 挂载。probeArtifact 未 provide（测试 mock 壳）或
  预检通道不可用 → 跳过预检、不显示大小、iframe 直接挂载。预检 pending 期间显中性加载态，
  无墙钟超时（设计 D3：不设超时，mock 环境的 ws 桩只应答 ping 也不会挂死本容器语义）。
-->
<template>
  <div
    ref="rootRef"
    class="md-html-preview overflow-hidden rounded-card border border-border bg-surface"
    data-testid="html-preview-inline"
  >
    <!-- 降级占位（原卡片降级形态延续）：路径非法 / 无法解析 / 预检三原因——文件名 + 原因灰显，无 iframe 无操作 -->
    <div
      v-if="degradeReason"
      class="flex items-start gap-2.5 px-3 py-2.5"
      data-testid="html-preview-degraded"
    >
      <FileCode2 class="mt-0.5 size-4 shrink-0 text-info" />
      <div class="min-w-0 flex-1">
        <div
          class="truncate font-mono text-[length:var(--text-sm)] text-neutral-fg"
          data-testid="html-preview-name"
        >
          {{ displayName }}
        </div>
        <div
          class="mt-0.5 text-[length:var(--text-2xs)] text-danger"
          data-testid="html-preview-meta"
        >
          {{ degradeText }}
        </div>
      </div>
    </div>

    <!-- 正常态：头部条 + 内容区 -->
    <template v-else>
      <!-- 头部条：文件名 + 大小（预检 size）+「源码 | 预览」切换（默认预览）+ 刷新 + 收起/展开 -->
      <div class="flex items-center gap-2 border-b border-border bg-surface-2 px-3 py-1.5">
        <FileCode2 class="size-3.5 shrink-0 text-info" />
        <span
          class="min-w-0 flex-1 truncate font-mono text-[length:var(--text-xs)] text-neutral-fg"
          data-testid="html-preview-name"
        >{{ displayName }}</span>
        <span
          class="shrink-0 text-[length:var(--text-2xs)] text-neutral-dim"
          data-testid="html-preview-size"
        >{{ sizeText }}</span>
        <div class="flex shrink-0 items-center gap-0.5">
          <!-- 源码 | 预览切换：readArtifact 未 provide → 整组隐藏（容器只有预览态，mock 壳不碎） -->
          <div
            v-if="sourceAvailable"
            class="flex gap-0.5 rounded-sm bg-bg-input p-0.5"
            data-testid="html-preview-view-toggle"
          >
            <Button
              variant="ghost"
              size="sm"
              class="h-5 rounded-sm px-1.5 text-[length:var(--text-2xs)]"
              :class="viewMode === 'preview' ? 'bg-bg-elevated text-neutral-fg' : 'text-neutral-mid'"
              data-testid="html-preview-tab-preview"
              @click="showPreview"
            >{{ t('panel.htmlPreview.tabPreview') }}</Button>
            <Button
              variant="ghost"
              size="sm"
              class="h-5 rounded-sm px-1.5 text-[length:var(--text-2xs)]"
              :class="viewMode === 'source' ? 'bg-bg-elevated text-neutral-fg' : 'text-neutral-mid'"
              data-testid="html-preview-tab-source"
              @click="showSource"
            >{{ t('panel.htmlPreview.tabSource') }}</Button>
          </div>
          <!-- 刷新：仅 iframe 已挂载态（重走预检 + ?r=n 递增重导航，删除文件后刷新落降级占位） -->
          <Button
            v-if="iframeMounted"
            variant="ghost"
            size="sm"
            class="h-5 w-5 rounded-sm p-0"
            :title="t('panel.htmlPreview.refresh')"
            data-testid="html-preview-refresh"
            @click="refresh"
          >
            <RefreshCw class="size-3 text-neutral-dim" />
          </Button>
          <!-- 收起/展开：高度上限切换（480 ⇄ 720，超限 iframe 内部滚动） -->
          <Button
            v-if="iframeMounted"
            variant="ghost"
            size="sm"
            class="h-5 w-5 rounded-sm p-0"
            :title="expanded ? t('panel.htmlPreview.collapse') : t('panel.htmlPreview.expand')"
            data-testid="html-preview-expand"
            @click="expanded = !expanded"
          >
            <ChevronUp v-if="expanded" class="size-3 text-neutral-dim" />
            <ChevronDown v-else class="size-3 text-neutral-dim" />
          </Button>
        </div>
      </div>

      <!-- 预览态：预检 pending 中性加载 / sandbox iframe（懒挂载：进视口才设 src） -->
      <div v-if="viewMode === 'preview'">
        <div
          v-if="!iframeMounted"
          class="flex items-center justify-center gap-2 px-3 py-6"
          data-testid="html-preview-loading"
        >
          <Loader2 class="size-3.5 animate-spin text-neutral-dim opacity-60" />
          <span class="text-[length:var(--text-2xs)] text-neutral-dim opacity-60">{{ t('panel.htmlPreview.checking') }}</span>
        </div>
        <iframe
          v-else
          data-testid="html-preview-frame"
          class="block w-full border-0 bg-white"
          :class="expanded ? 'h-[720px]' : 'h-[480px]'"
          sandbox="allow-scripts"
          :src="iframeSrc"
          title="html-preview"
        />
      </div>

      <!-- 源码态：iframe 卸载，内容经 deps.readArtifact 读取后走 MarkdownRenderer 的
           shiki fence 高亮通道（嵌套 MarkdownRenderer——同一 ui 包组件，scoped 的
           .md-codeblock 样式由该实例自带；fence 包裹后源码不再是 markdown 语法区，
           构造性排除「源码内 html-preview fence → 嵌套容器」递归） -->
      <div v-else>
        <div
          v-if="sourceState.kind === 'loading'"
          class="flex items-center justify-center gap-2 px-3 py-6"
          data-testid="html-preview-source-loading"
        >
          <Loader2 class="size-3.5 animate-spin text-neutral-dim opacity-60" />
        </div>
        <div
          v-else-if="sourceState.kind === 'error'"
          class="flex flex-col items-center gap-1.5 px-3 py-6 text-center"
          data-testid="html-preview-source-error"
        >
          <span class="text-[length:var(--text-2xs)] text-danger">{{ t('panel.htmlPreview.sourceLoadFailed') }}</span>
          <Button
            variant="ghost"
            size="sm"
            class="h-6 rounded-sm px-2 text-[length:var(--text-2xs)]"
            data-testid="html-preview-source-retry"
            @click="loadSource"
          >{{ t('common.retry') }}</Button>
        </div>
        <MarkdownRenderer
          v-else
          :content="sourceMarkdown"
          :session-id="sessionId ?? undefined"
          class="p-1.5"
          data-testid="html-preview-source"
        />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * HtmlPreviewInline（chat-html-support §6.3 D3，v16 内联容器）。
 * - 路径解析矩阵：绝对路径直用（含 `~` 家目录形态）；相对路径按 resourceBaseDir ??
 *   sessionCwdOf(sessionId) 解析（与 MarkdownRenderer ④路同标准的纯函数镜像，
 *   ui→renderer 依赖禁令不可直接 import）；两者皆缺 → 降级态「无法解析路径」。
 * - 非法判定：fence 内容 trim 后为空或含换行 → 降级态「路径非法」。
 * - 预检经 deps.probeArtifact（可选）：未 provide / 通道失败 → 跳过预检（不显示大小）。
 * - 懒挂载：IntersectionObserver（threshold 0.1）进视口才设 src；已挂载不卸载（离视口
 *   保留，避免来回滚动反复重执行脚本）；卸载时断开 observer。
 * - 源码态经 deps.readArtifact（可选）：未 provide →「源码」按钮隐藏；读取失败 → 错误
 *   占位 + 重试。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronUp, FileCode2, Loader2, RefreshCw } from '@lucide/vue'
import { Button } from '../../primitives/button'
import { useChatViewDeps } from './chat-view-deps'
import { basenameOf, buildLocalFileUrl, formatSize, isAbsolutePath, resolvePosixPath } from './html-preview-path'
import MarkdownRenderer from './MarkdownRenderer.vue'

const { t } = useI18n()
const deps = useChatViewDeps()

const props = defineProps<{
  /** fence 内容（路径字符串，切片层原样承载——trim/合法性判定在本组件） */
  path: string
  /** 所属 session（相对路径解析兜底基准） */
  sessionId?: string | null
  /** 相对资源解析基准目录（绝对路径；props 覆盖优先，缺省走 deps.sessionCwdOf） */
  resourceBaseDir?: string
}>()

/** 预检三原因的降级原因码（servable=false 时由 deps.probeArtifact 给） */
type ProbeDegradeReason = 'not_found' | 'is_dir' | 'out_of_whitelist'

/**
 * 预检态：
 * - pending：请求在途（中性加载态，无墙钟超时）
 * - skipped：未 provide 预检能力 / 通道不可用 → 跳过预检、不显示大小、iframe 直接挂载
 * - servable：可服务（size 有则显示）
 * - degrade：三原因之一（降级占位）
 */
type ProbeState =
  | { kind: 'pending' }
  | { kind: 'skipped' }
  | { kind: 'servable'; size?: number }
  | { kind: 'degrade'; reason: ProbeDegradeReason }

/** 视图模式：preview=iframe 渲染（默认）/ source=shiki 源码高亮（需 deps.readArtifact） */
type InlineViewMode = 'preview' | 'source'

const probeState = ref<ProbeState>({ kind: 'pending' })
const viewMode = ref<InlineViewMode>('preview')
/** 收起/展开高度切换（480 ⇄ 720，模板 Tailwind 类 h-[480px] / h-[720px]；超限由 iframe 内部滚动承载） */
const expanded = ref(false)
/** 懒挂载：进视口后恒 true（已挂载不卸载） */
const inView = ref(false)
/** 刷新在途：重检期间保持 iframe 挂载（避免闪空），servable 后 ?r=n 递增重导航 */
const refreshing = ref(false)
/** iframe 重导航计数（?r=<n>，仅触发重导航；缓存新鲜性由 no-store 构造保证） */
const revision = ref(1)

// ── 路径解析（与卡片时代同矩阵延续，纯函数镜像见 html-preview-path.ts）──

const trimmedPath = computed(() => props.path.trim())
/** 非法判定：trim 后为空或含换行 → 「路径非法」（跨行内容不可能是单条路径） */
const pathIsInvalid = computed(() => trimmedPath.value === '' || trimmedPath.value.includes('\n'))
/** 解析后绝对路径；null = 无法解析（非法 / 基准与 session 语境皆缺） */
const resolvedPath = computed<string | null>(() => {
  const p = trimmedPath.value
  if (pathIsInvalid.value) return null
  if (isAbsolutePath(p)) return p
  const base = props.resourceBaseDir ?? deps.sessionCwdOf?.(props.sessionId ?? '')
  if (!base) return null
  return resolvePosixPath(base, p)
})
/** 非非法、但相对路径无任何基准可依 → 「无法解析路径」（不静默猜基准） */
const pathUnresolved = computed(() => !pathIsInvalid.value && resolvedPath.value === null)

/** 降级原因（非法 / 无法解析 / 预检三原因）；null = 非降级态 */
const degradeReason = computed<string | null>(() => {
  if (pathIsInvalid.value) return 'invalid_path'
  if (pathUnresolved.value) return 'unresolved_path'
  if (probeState.value.kind === 'degrade') return probeState.value.reason
  return null
})

/** 降级原因 → i18n key（字面全路径：locale 反向守卫要求每个叶子 key 在源码里有字面引用，
 *  动态拼接 `panel.htmlPreview.degrade.${reason}` 会被判为死键） */
const DEGRADE_LABEL_KEYS: Readonly<Record<string, string>> = {
  invalid_path: 'panel.htmlPreview.invalidPath',
  unresolved_path: 'panel.htmlPreview.unresolvedPath',
  not_found: 'panel.htmlPreview.notFound',
  is_dir: 'panel.htmlPreview.isDir',
  out_of_whitelist: 'panel.htmlPreview.outOfWhitelist',
}

const displayName = computed(() => basenameOf(trimmedPath.value) || trimmedPath.value || '—')
const degradeText = computed(() => {
  const reason = degradeReason.value
  if (!reason) return ''
  return t(DEGRADE_LABEL_KEYS[reason] ?? 'panel.htmlPreview.unresolvedPath')
})

const sizeText = computed(() => {
  if (probeState.value.kind === 'pending') return t('panel.htmlPreview.checking')
  if (probeState.value.kind !== 'servable' || probeState.value.size === undefined) return ''
  return formatSize(probeState.value.size)
})

// ── iframe src（local-file 编码 + ?r=n 重导航；与原抽屉渲染态同规格，镜像实现）──

/** 源码态可用性：deps.readArtifact 已 provide 且路径可解析（缺一 →「源码」按钮整组隐藏） */
const sourceAvailable = computed(() => typeof deps.readArtifact === 'function' && resolvedPath.value !== null)

/**
 * iframe 挂载条件：路径可解析、非降级、已进视口、预览态、预检通过（servable/skipped）。
 * 刷新在途（refreshing）保持已挂载 iframe 不卸载——重检完成按结果切换。
 */
const iframeMounted = computed(() => {
  if (resolvedPath.value === null || degradeReason.value !== null) return false
  if (!inView.value || viewMode.value !== 'preview') return false
  if (refreshing.value) return true
  return probeState.value.kind === 'servable' || probeState.value.kind === 'skipped'
})

const iframeSrc = computed<string | undefined>(() => {
  const path = resolvedPath.value
  if (path === null || !iframeMounted.value) return undefined
  return buildLocalFileUrl(path, revision.value)
})

// ── 预检（probe）──

let probeSeq = 0

/**
 * 预检：路径解析结果变化时重跑。序号守卫防旧请求覆盖（路径改写/组件复用场景）。
 * 未 provide / 通道异常 → skipped（跳过预检，不显示大小）——设计 D3「未 provide 跳过预检」，
 * 通道异常同款处置：不把预览钉死在降级（预检只是挂载前准入提示，真实服务判定在协议 handler）。
 */
async function runProbe(path: string | null): Promise<void> {
  const seq = ++probeSeq
  if (path === null) {
    probeState.value = { kind: 'skipped' }
    return
  }
  const probe = deps.probeArtifact
  if (!probe) {
    probeState.value = { kind: 'skipped' }
    return
  }
  probeState.value = { kind: 'pending' }
  try {
    const r = await probe(path)
    if (seq !== probeSeq) return
    probeState.value = r.servable
      ? { kind: 'servable', size: r.size }
      : { kind: 'degrade', reason: r.reason ?? 'not_found' }
  } catch (e) {
    if (seq !== probeSeq) return
    // 出声不静默（渲染失败可诊断），失败不阻塞：退回中性态直接挂载
    console.warn('[HtmlPreviewInline] probeArtifact failed, skipping precheck:', e)
    probeState.value = { kind: 'skipped' }
  }
}

watch(resolvedPath, (p) => { void runProbe(p) }, { immediate: true })

/**
 * 刷新（设计 §6.3 / S8⑤）：重走预检 + servable 后 ?r=n 递增重导航（no-store 构造保证
 * 新鲜性）。重检 not_found → 降级占位（「刷新见新版」与「文件已删」同一入口收敛）。
 */
async function refresh(): Promise<void> {
  const path = resolvedPath.value
  if (path === null || refreshing.value) return
  refreshing.value = true
  try {
    await runProbe(path)
  } finally {
    refreshing.value = false
  }
  if (probeState.value.kind === 'servable' || probeState.value.kind === 'skipped') {
    revision.value += 1
  }
}

// ── 源码态（deps.readArtifact → MarkdownRenderer fence 高亮通道）──

type SourceState = { kind: 'idle' | 'loading' | 'content' | 'error'; content: string }
const sourceState = ref<SourceState>({ kind: 'idle', content: '' })

/** 源码态内容加载；失败显错误占位 + 重试（出声不静默） */
async function loadSource(): Promise<void> {
  const path = resolvedPath.value
  const read = deps.readArtifact
  if (path === null || !read) return
  sourceState.value = { kind: 'loading', content: '' }
  try {
    const r = await read(path)
    sourceState.value = { kind: 'content', content: r.content }
  } catch (e) {
    console.warn('[HtmlPreviewInline] readArtifact failed:', e)
    sourceState.value = { kind: 'error', content: '' }
  }
}

function showSource(): void {
  if (viewMode.value === 'source') return
  viewMode.value = 'source'
  void loadSource()
}

function showPreview(): void {
  viewMode.value = 'preview'
}

/**
 * 源码态渲染输入：源码包进 fence 走 shiki 高亮（MarkdownRenderer 的 fence 通道，
 * deps.renderMarkdownIncremental 注入形态原样复用）。开栅长度 = 源码内行首最长反引号
 * 连跑数 +1（markdown-it 闭合栅栏须 ≥ 开栅长度）——源码含 ``` 代码块示例时不会提前闭合，
 * 构造性排除源码内容被当 markdown 解析（含 html-preview fence → 嵌套容器递归）。
 */
/** markdown-it 栅栏最小开栅长度（小于 3 不构成 fence） */
const MIN_FENCE_MARKER_RUN = 3

const sourceMarkdown = computed(() => {
  if (sourceState.value.kind !== 'content') return ''
  const source = sourceState.value.content
  let maxRun = 0
  for (const line of source.split('\n')) {
    const m = /^(`+)/.exec(line)
    if (m && m[1].length > maxRun) maxRun = m[1].length
  }
  const marker = '`'.repeat(Math.max(MIN_FENCE_MARKER_RUN, maxRun + 1))
  return `${marker}html\n${source}\n${marker}`
})

// ── 懒挂载（IntersectionObserver threshold 0.1）──

const rootRef = ref<HTMLElement | null>(null)
let observer: IntersectionObserver | null = null

onMounted(() => {
  const el = rootRef.value
  // 无 IntersectionObserver 的环境（部分测试/宿主）→ 立即挂载（懒挂载是性能优化非正确性依赖）
  if (!el || typeof IntersectionObserver === 'undefined') {
    inView.value = true
    return
  }
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        inView.value = true
        observer?.disconnect()
        observer = null
      }
    },
    { threshold: 0.1 },
  )
  observer.observe(el)
})

onUnmounted(() => {
  observer?.disconnect()
  observer = null
})
</script>
