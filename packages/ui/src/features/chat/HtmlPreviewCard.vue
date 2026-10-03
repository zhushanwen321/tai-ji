<!--
  HtmlPreviewCard —— html-preview fence 的卡片（chat-html-support §6.3 D3 / §7「卡片组件」行）。

  形态：fence info 首词为 `html-preview`、内容为被预览 HTML 文件路径（绝对路径直用；相对路径
  按 resourceBaseDir ?? sessionCwdOf(sessionId) 矩阵解析，与 MarkdownRenderer ④路同一传值矩阵）。
  单动作形态：唯一按钮「打开预览」→ deps.openDrawer('detail', { filePath: 绝对路径 })——不设
  「显示源码」第二按钮（抽屉「预览 | 源码」切换已覆盖，设计 §6.3 已否决）。

  安全不变量：卡片 DOM 由本 Vue 模板产出，样式走 Tailwind 工具类与既有设计 token，**不经过**
  v-html / DOMPurify / 信任槽——用户 HTML 的白名单契约（class/style/data-* 构造性全剥）不受影响；
  段载荷本身只是路径字符串（renderer 侧 base64 进占位属性，切片层解码）。

  预检：挂载时经 deps.probeArtifact（可选，跨层注入口）调主进程 localFile:servable 通道 →
  { servable, reason, size }。三原因（not_found / is_dir / out_of_whitelist）→ 降级态（带原因、
  按钮禁用）；servable → 显示文件名与大小。probeArtifact 未 provide（测试 mock 壳）或预检通道
  不可用 → 跳过预检、不显示大小（中性态、按钮可点，失败兜底归抽屉自身的预检 + 重试）。
  预检 pending 期间显中性加载态，无墙钟超时（设计 D3：不设超时，mock 环境的 ws 桩只应答 ping
  也不会挂死本卡片语义）。
-->
<template>
  <div
    class="md-html-preview flex items-start gap-2.5 rounded-card bg-surface px-3 py-2.5"
    data-testid="html-preview-card"
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
        class="mt-0.5 text-[length:var(--text-2xs)]"
        :class="degradeReason ? 'text-danger' : 'text-neutral-dim'"
        data-testid="html-preview-meta"
      >
        {{ metaText }}
      </div>
    </div>
    <Button
      size="sm"
      :disabled="!canOpen"
      data-testid="html-preview-open"
      @click="onOpen"
    >
      {{ t('panel.htmlPreview.open') }}
    </Button>
  </div>
</template>

<script setup lang="ts">
/**
 * HtmlPreviewCard（chat-html-support §6.3 D3）。
 * - 路径解析矩阵：绝对路径直用；相对路径按 resourceBaseDir ?? sessionCwdOf(sessionId) 解析
 *   （与 MarkdownRenderer ④路同标准的纯函数镜像，ui→renderer 依赖禁令不可直接 import）；
 *   两者皆缺 → 降级态「无法解析路径」（不静默猜基准）。
 * - 非法判定：fence 内容 trim 后为空或含换行 → 降级态「路径非法」。
 * - 预检经 deps.probeArtifact（可选）：未 provide / 通道失败 → 跳过预检（不显示大小）。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { FileCode2 } from '@lucide/vue'
import { Button } from '../../primitives/button'
import { useChatViewDeps } from './chat-view-deps'

const { t } = useI18n()
const deps = useChatViewDeps()

const props = defineProps<{
  /** fence 内容（路径字符串，切片层原样承载——trim/合法性判定在本组件） */
  path: string
  /** 所属 session（相对路径解析兜底基准 + 打开抽屉的语境） */
  sessionId?: string | null
  /** 相对资源解析基准目录（绝对路径；props 覆盖优先，缺省走 deps.sessionCwdOf） */
  resourceBaseDir?: string
}>()

/** 预检三原因的降级原因码（servable=false 时由 deps.probeArtifact 给） */
type ProbeDegradeReason = 'not_found' | 'is_dir' | 'out_of_whitelist'

/**
 * 预检态：
 * - pending：请求在途（中性加载态，无墙钟超时）
 * - skipped：未 provide 预检能力 / 通道不可用 → 跳过预检、不显示大小
 * - servable：可服务（size 有则显示）
 * - degrade：三原因之一（按钮禁用）
 */
type ProbeState =
  | { kind: 'pending' }
  | { kind: 'skipped' }
  | { kind: 'servable'; size?: number }
  | { kind: 'degrade'; reason: ProbeDegradeReason }

const probeState = ref<ProbeState>({ kind: 'pending' })

/** 绝对路径判定（POSIX 根 / Windows 盘符；产物目录形态恒为 POSIX 绝对路径） */
function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p)
}

/**
 * POSIX resolve（与 MarkdownRenderer ④路 resolveHrefPath 同标准镜像：base + rel 后逐段
 * 折叠 `.` / `..`；两侧改动需同批同步，镜像纪律见 markdown-types.ts 协议镜像注释）。
 */
function resolvePath(base: string, rel: string): string {
  const joined = rel.startsWith('/') ? rel : `${base}/${rel}`
  const parts: string[] = []
  for (const seg of joined.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      parts.pop()
      continue
    }
    parts.push(seg)
  }
  return `/${parts.join('/')}`
}

/** 取路径末段作显示文件名（解析前按原文取，降级态也能显示「哪个文件」） */
function basenameOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i === -1 ? p : p.slice(i + 1)
}

const BYTES_PER_KB = 1024
const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB

/** 字节数人类可读（B / KB / MB，一位小数）；非法值返回空串（不显示大小） */
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < BYTES_PER_KB) return `${bytes} B`
  if (bytes < BYTES_PER_MB) return `${(bytes / BYTES_PER_KB).toFixed(1)} KB`
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`
}

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
  return resolvePath(base, p)
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

const metaText = computed(() => {
  const reason = degradeReason.value
  if (reason) return t(DEGRADE_LABEL_KEYS[reason] ?? 'panel.htmlPreview.unresolvedPath')
  if (probeState.value.kind === 'pending') return t('panel.htmlPreview.checking')
  const size = probeState.value.kind === 'servable' ? probeState.value.size : undefined
  const sizeText = size !== undefined ? formatSize(size) : ''
  const kind = t('panel.htmlPreview.kind')
  return sizeText ? `${kind} · ${sizeText}` : kind
})

/** 单动作可用性：路径可解析、非降级态、预检不在途 */
const canOpen = computed(
  () => resolvedPath.value !== null && degradeReason.value === null && probeState.value.kind !== 'pending',
)

let probeSeq = 0

/**
 * 预检：路径解析结果变化时重跑。序号守卫防旧请求覆盖（路径改写/组件复用场景）。
 * 未 provide / 通道异常 → skipped（跳过预检，不显示大小）——设计 D3「未 provide 跳过预检」，
 * 通道异常同款处置：本卡片不把预览钉死在降级，失败面由抽屉自身的预检 + 重试承载。
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
    // 出声不静默（渲染失败可诊断），失败不阻塞：退回中性态交抽屉兜底
    console.warn('[HtmlPreviewCard] probeArtifact failed, skipping precheck:', e)
    probeState.value = { kind: 'skipped' }
  }
}

watch(resolvedPath, (p) => { void runProbe(p) }, { immediate: true })

/** 唯一动作：打开抽屉 detail（已解析的绝对路径；抽屉内由 u3 渲染态呈现预览） */
function onOpen(): void {
  const path = resolvedPath.value
  if (path === null || !canOpen.value) return
  deps.openDrawer('detail', { filePath: path })
}
</script>
