<template>
  <!--
    展示组件 · Markdown 渲染（W03）。
    shiki 代码高亮（VSCode 级）+ markdown-it 结构解析（标题/列表/表格/行内代码/链接）。

    渲染模式：renderMarkdownSegments 把 markdown 拆成 text 段（HTML，走 v-html）+ mermaid 段
    （源码，走 <MermaidRenderer> 组件）交替。mermaid 作为 template 里的正常 Vue 组件，
    无 Vue render 函数动态挂载（该模式不可靠，曾导致渲染失败）。

    代码块增强（fence 规则覆盖，markdown.ts）：语言标签 + 复制按钮（事件委托）。

    双主题（ADR-0022-B：暗为默认）：shiki defaultColor:false 产出 --shiki-dark(暗)/--shiki-light(亮)
    双套 span，由 :root(暗默认) / [data-theme="light"] 的 scoped 样式切换，走 design-tokens 体系。

    v-html：text 段消费 renderMarkdown 输出，已经 markdown-sanitize 分通道净化——markdown-it html:true，
    可信段（shiki/KaTeX/md-* 契约）以 nonce 哨兵摘出-回填绕过净化，用户 HTML 走 DOMPurify 两级
    白名单（class/style/data-* 构造性全剥）。故在此受控渲染点局部放开 taste-lint vue/no-v-html。仅此组件。
  -->
  <div class="md-render select-text" :class="{ 'md-render--thinking': variant === 'thinking' }" @click="onClick">
    <!-- v-for key：增量路径用段稳定键 segId（前缀段引用与 segId 跨帧不变 → DOM 复用，R-19）；
         streaming-fence 占位段例外——segId 每帧重分配，若 key 随帧变 → 占位 DOM 重建 →
         spinner 旋转动画每帧重启（W23 review Fix-2），故用固定哨兵 'sf'（见 segKey）；
         全量/降级路径不携带 segId → 回退 index（等价旧版行为）。s/i 前缀隔离防两类 key 撞号。 -->
    <template v-for="(seg, i) in segments" :key="segKey(seg, i)">
      <!-- eslint-disable-next-line vue/no-v-html -- text 段已经 markdown-sanitize 分通道净化（可信段摘出-回填 + 用户内容白名单），仅此受控点放开。 -->
      <div v-if="seg.type === 'text'" v-html="seg.content" />
      <!-- streaming-fence 占位（D-5/W23，R-20）：未闭合 fence 流式期不跑 shiki/mermaid——语言标签 +
           loader 行；token 静默 ≥阈值或消息 complete 后 finalize 转完整渲染（.md-codeblock/MermaidRenderer） -->
      <div
        v-else-if="seg.type === 'streaming-fence'"
        data-testid="md-streaming-fence"
        class="my-2.5 flex items-center gap-1.5 rounded border border-border bg-surface-2 px-2.5 py-1.5"
      >
        <!-- eslint-disable-next-line vue/no-v-html -- 硬编码常量 loader SVG（block-icon.ts，同 Block.vue running 态用法） -->
        <span class="inline-flex size-[13px] shrink-0 items-center justify-center text-accent animate-loader-spin" v-html="RUNNING_LOADER_SVG" />
        <span data-testid="md-streaming-fence-lang" class="font-mono text-[length:var(--text-2xs)] font-semibold lowercase tracking-[0.08em] text-neutral-dim">{{ seg.lang }}</span>
      </div>
      <MermaidRenderer v-else :source="seg.content" />
    </template>
    <!-- 歧义文件选择浮层：裸 basename 多匹配时弹出（锚定到点击的 <a>，portal 到 body） -->
    <AmbiguousFilePopover
      :open="!!ambiguousState"
      :basename="ambiguousState?.basename ?? ''"
      :candidates="ambiguousCandidates"
      :anchor-el="ambiguousState?.anchorEl ?? null"
      @update:open="(v) => { if (!v) ambiguousState = null }"
      @select="onAmbiguousSelect"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * Markdown 渲染器（w6 迁 ui，deps 注入重构）。
 * - D-5 增量消费（W23）：流式渲染状态机在 useMarkdownStreaming（rAF 节流 + latest-wins 串行 +
 *   前缀段引用恒等缓存 + tail 段每帧重建 + streaming-fence 占位/finalize/粘滞 + 卸载清理）；
 *   壳未提供增量能力时回退 renderMarkdown 全量（等价旧版）
 * - 文件路径/歧义选择经 deps.onFileClick/onAmbiguousSelect/openDrawer 桥接
 * - 代码块复制是 DOM 副作用（v-html 内），ui 内本地处理（base64 解码 data-code + is-copied class）
 * - mermaid 段走 <MermaidRenderer>（经 deps.renderMermaid 渲染 SVG）
 */
import { ref, watch } from 'vue'
import type { FileNode } from '@taiji/shared'
import type { MarkdownSegment } from './markdown-types'
import { findByBasename } from '../../lib/file-basename'
import { RUNNING_LOADER_SVG } from './block-icon'
import AmbiguousFilePopover from './AmbiguousFilePopover.vue'
import MermaidRenderer from './MermaidRenderer.vue'
import { useChatViewDeps } from './chat-view-deps'
import { useMarkdownStreaming } from './composables/useMarkdownStreaming'

const props = defineProps<{
  content: string
  /** 所属 session（文件路径识别 + 歧义候选加载用）；命令文档等无 session 场景传 undefined */
  sessionId?: string | null
  /** 渲染变体：默认 undefined（正文级排版）；'thinking' 用于 thinking 块/次要过程信息。 */
  variant?: 'thinking'
  /** 所属 assistant 是否正在流式（Block text 分支透传）。true 期间未闭合 fence 走 streaming-fence
   *  占位（静默 ≥阈值或翻 false 时 finalize 转完整渲染）；false/undefined（complete/静态内容）直接完整渲染。 */
  streaming?: boolean
  /** 相对资源解析基准目录（绝对路径；设计 markdown-html-sanitize-render D4，双通道取值
   *  props 覆盖优先）：props 供 DetailPane 等静态宿主传打开文件所在目录（④路点击语义）；
   *  缺省（对话流/命令文档零模板传 props）经 deps.sessionCwdOf 拿 session cwd；两者皆缺
   *  （未知 sid / mock 壳未 provide）→ ④路 preventDefault 无动作（死链无害）。
   *  注意：本 props 只喂 ④路点击；img 相对 src 重写走 deps env（壳层工厂装配）——drawer
   *  宿主经工厂 override 参数使 env 与本 props 同值（D4 矩阵 drawer 行「两通道同值」）。 */
  resourceBaseDir?: string
}>()

const deps = useChatViewDeps()
// D-5 增量流式渲染状态机（content watch → rAF 节流 → 增量协议 → 渲染树，生命周期同组件实例）
const { segments } = useMarkdownStreaming(props, deps)

/** data-path 解码（renderer 壳 linkify 产出 base64 编码路径，HISTORICAL：迁移时丢 decodeBase64 致点击打开错误路径） */
function decodeB64(b64: string): string {
  try {
    const binary = atob(b64)
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
  } catch {
    return b64
  }
}

/**
 * v-for 段 key（W23 review Fix-2）：streaming-fence 占位段固定哨兵 'sf'——占位段的 segId
 * 在协议层每帧重分配（tail 段每帧重建），若 key 随帧变则占位 DOM 重建、loader 旋转动画
 * （1.4s 周期）每帧从头重启，视觉冻结在起转 18°。文档级至多一个未闭合 fence，哨兵不撞号。
 * 其余段沿用 segId（前缀段跨帧不变 → DOM 复用）/ index（全量降级路径）。
 */
function segKey(seg: MarkdownSegment, i: number): string {
  if (seg.type === 'streaming-fence') return 'sf'
  return seg.segId !== undefined ? `s${seg.segId}` : `i${i}`
}

// ── 歧义文件选择浮层（多匹配 basename 点击时弹出，见 AmbiguousFilePopover）──
const ambiguousState = ref<{ basename: string; anchorEl: HTMLElement } | null>(null)
/** 歧义浮层候选（经 deps.loadFileCandidates 加载，findByBasename 过滤） */
const ambiguousCandidates = ref<FileNode[]>([])

// ambiguousState 变化 → 经 deps 桥接 useFileSearch 加载候选
watch(ambiguousState, async (st) => {
  if (!st) {
    ambiguousCandidates.value = []
    return
  }
  const sid = props.sessionId
  if (!sid) {
    ambiguousCandidates.value = []
    return
  }
  const nodes = await deps.loadFileCandidates(sid, st.basename)
  ambiguousCandidates.value = findByBasename(nodes, st.basename)
})

/** 歧义浮层选中 → 打开文件 detail + 清状态 */
function onAmbiguousSelect(path: string): void {
  deps.onFileClick(path)
  deps.openDrawer('detail', { filePath: path })
  ambiguousState.value = null
}

// ── 代码块复制反馈态（DOM imperative：v-html 内 .md-codeblock__copy 无 Vue 响应式）──
let copiedBtn: HTMLElement | null = null
let copiedTimer: ReturnType<typeof setTimeout> | null = null
const COPIED_FEEDBACK_MS = 1200

// ── ④路相对链接判定/resolve（设计 markdown-html-sanitize-render D4）──
// 与 renderer markdown-sanitize.ts 的 isRelativeResourcePath/resolveResourcePath 同标准镜像
// （ui→renderer 依赖禁令不可直接 import——镜像纪律同 markdown-types.ts 的协议镜像，两侧
// 注释互指，改动需同批同步）。

/** scheme 前缀正则（http: / data: / mailto: 等带协议头的 URL——非相对路径，与 sanitize 侧同款） */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i

/** 相对资源路径判定：非 # 开头（页内锚点）、非 // 开头（协议相对 = 远程）、无 scheme 前缀。空串非路径。 */
function isRelativeHref(value: string): boolean {
  if (value === '') return false
  if (value.startsWith('#')) return false
  if (value.startsWith('//')) return false
  return !SCHEME_RE.test(value)
}

/** POSIX resolve（Node path.resolve 语义的纯函数实现；renderer 运行时无 node:path，两侧同款镜像） */
function resolveHrefPath(base: string, rel: string): string {
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

/**
 * v-html 内点击事件委托路由（代码块复制 / 文件路径 / 歧义 basename / 相对链接 / 外链）。
 * 文件操作经 deps 桥接（onFileClick/openDrawer）。代码块复制是 DOM 副作用，ui 本地处理。
 */
function onClick(e: MouseEvent): void {
  const target = e.target as HTMLElement

  // ① 代码块复制按钮（data-code 是 base64 编码的源码）
  const btn = target.closest('.md-codeblock__copy') as HTMLElement | null
  if (btn) {
    e.preventDefault()
    // base64 解码失败（无合法 data-code）：code 保持空串，跳过剪贴板写入，仅保留反馈态
    let code = ''
    try {
      code = atob(btn.dataset.code ?? '')
    } catch {
      code = ''
    }
    if (code) {
      navigator.clipboard.writeText(code).catch(() => { /* 剪贴板失败静默 */ })
    }
    btn.classList.add('is-copied')
    if (copiedBtn && copiedBtn !== btn) copiedBtn.classList.remove('is-copied')
    copiedBtn = btn
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => {
      btn.classList.remove('is-copied')
      if (copiedBtn === btn) copiedBtn = null
    }, COPIED_FEEDBACK_MS)
    return
  }

  // ② 含/路径文件链接（.md-filepath 带 data-path，base64 编码）
  const pathLink = target.closest('.md-filepath') as HTMLElement | null
  if (pathLink) {
    e.preventDefault()
    const raw = pathLink.dataset.path
    const path = raw ? decodeB64(raw) : (pathLink.textContent ?? '')
    if (path) {
      deps.onFileClick(path)
      deps.openDrawer('detail', { filePath: path })
    }
    return
  }

  // ③ 裸 basename（.md-ambiguous）：弹歧义浮层（多匹配时由 AmbiguousFilePopover 选择）
  const ambLink = target.closest('.md-ambiguous') as HTMLElement | null
  if (ambLink) {
    e.preventDefault()
    const basename = ambLink.textContent ?? ''
    if (basename) ambiguousState.value = { basename, anchorEl: ambLink }
    return
  }
  // ④ 相对链接分流（④路扩展，设计 D4）：原生 <a> 的 href 命中相对路径 → 应用内打开对应
  // 文件（drawer detail，与路②同通道；目标有未提交改动显 diff / untracked 自动降级 preview
  // 是 detail 通道统一语义）。# 锚点 / // 协议相对 / scheme 链接不拦截（默认冒泡走外链闸）。
  const anchor = target.closest('a')
  if (anchor) {
    // 用 getAttribute 原始值判定：element.href 是浏览器绝对化后的值，相对形态失真（D4）
    const href = anchor.getAttribute('href')
    if (href && isRelativeHref(href)) {
      e.preventDefault()
      // 基准目录双通道（D4 传值矩阵）：props 覆盖优先（drawer 文件目录语义）；props 缺省
      // （对话流/命令文档）经 deps.sessionCwdOf 拿 session cwd（可选链容错——mock 壳未
      // provide 时 undefined）；两者皆缺 → preventDefault + 无动作（死链无害，优于窗口导航走）
      const base = props.resourceBaseDir ?? deps.sessionCwdOf?.(props.sessionId ?? '')
      if (base) {
        deps.openDrawer('detail', { filePath: resolveHrefPath(base, href) })
      }
    }
  }
  // 其余点击：默认冒泡，不拦截
}
</script>

<style scoped>
/* ── markdown 排版（design-tokens 语义色，不硬编码）──
   user-select:text 走 Tailwind select-text 类（template 的 .md-render div），
   覆盖 body 全局 user-select:none（style.css:165）—— 那条全局 none 是为让
   chrome/按钮区不可选，markdown 正文/代码是可读内容应允许框选。 */
.md-render :deep(h1),
.md-render :deep(h2),
.md-render :deep(h3),
.md-render :deep(h4) {
  font-weight: 600;
  line-height: 1.3;
  margin: 1em 0 0.5em;
  color: var(--neutral-fg);
}
.md-render :deep(h1) { font-size: 1.3em; }
.md-render :deep(h2) { font-size: 1.18em; }
.md-render :deep(h3),
.md-render :deep(h4) { font-size: 1.06em; }

/* p margin 归零：用户气泡里列表与相邻段落紧贴（旧 0.5em 0 让列表上下多 7px 空行）。
   块级 <p> 天然换行，margin:0 后多段落仍可区分（换行在，只是无额外间距）。
   assistant summary 同此样式，多段落紧贴也是合理节奏。 */
.md-render :deep(p) {
  margin: 0;
  line-height: 1.7;
}

/* 列表样式：让编号/符号列表在视觉上接近普通正文行（用户气泡里手打的编号列表
   不该被当成大间距结构化块）。紧凑节奏：无项间 margin、行高对齐 <p>、左缩进仅留编号位。
   [HISTORICAL] 旧值 margin:0.5em 0 + li margin:0.2em 0 + padding-left:1.5em + marker --subtle，
   导致编号行上下多空行、左缩进过深、编号是三级灰与正文不一致——被用户判定为「像多一个空行」。 */
.md-render :deep(ul),
.md-render :deep(ol) {
  margin: 0;
  padding-left: 1.2em;
}
/* 恢复 Tailwind preflight 清掉的 list-style-type（preflight 对 ol/ul 设 list-style:none）。
   不恢复则 <ol> 数字编号不可见——用户气泡里的编号列表会丢编号只剩换行。 */
.md-render :deep(ul) {
  list-style-type: disc;
}
.md-render :deep(ol) {
  list-style-type: decimal;
}
.md-render :deep(li) {
  margin: 0;
  line-height: 1.7;
}
/* 编号颜色与正文一致（旧 --subtle 让编号变灰，与正文 fg 脱节） */
.md-render :deep(li)::marker {
  color: var(--neutral-fg);
}

.md-render :deep(blockquote) {
  border-left: 2px solid var(--border-strong);
  padding-left: 0.85em;
  margin: 0.6em 0;
  color: var(--neutral-mid);
}

/* img 布局约束（设计 D8）：README 的 width=900 截图等撑破容器——max-width 封顶 + height
   auto 保比例；垂直 margin 对齐 blockquote 同族节奏（图片是内容通道，不引入装饰）。 */
.md-render :deep(img) {
  max-width: 100%;
  height: auto;
  margin: 0.6em 0;
}

.md-render :deep(a) {
  color: var(--accent);
  text-decoration: none;
}
.md-render :deep(a:hover) { text-decoration: underline; }

/* 文件路径链接：等宽 + 下划线点示，区别于普通外链（提示是文件而非网页） */
.md-render :deep(.md-filepath) {
  font-family: var(--font-mono);
  font-size: 0.9em;
  color: var(--accent);
  text-decoration: underline dotted;
  text-underline-offset: 2px;
  cursor: pointer;
}
.md-render :deep(.md-filepath:hover) {
  text-decoration: underline;
}

/* 行内代码：弱底色 + 等宽，区分正文 */
.md-render :deep(code:not(pre code)) {
  font-family: var(--font-mono);
  font-size: 0.88em;
  background: var(--surface-2);
  padding: 0.1em 0.35em;
  border-radius: var(--radius-sm);
}

/* ── 代码块容器（fence 规则覆盖产出 .md-codeblock）──
   shiki 产出的 <pre class="shiki"> 被包在 .md-codeblock 内，外层统一控制圆角/边框/overflow。
   header 含语言标签（左）+ 复制按钮（右）。复制按钮 icon 用 CSS 伪元素 + .is-copied 切换。
   代码区底色：pre 用 var(--bg-input)（min-dark/min-light 透明底，跟随全部主题/preset），
   header 用 --surface-2。 */
.md-render :deep(.md-codeblock) {
  margin: 0.7em 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.md-render :deep(.md-codeblock__header) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.25em 0.4em 0.25em 0.8em;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
}
.md-render :deep(.md-codeblock__lang) {
  font-family: var(--font-mono);
  font-size: 0.72em;
  color: var(--neutral-dim);
  text-transform: lowercase;
  letter-spacing: 0.02em;
}
.md-render :deep(.md-codeblock__copy) {
  appearance: none;
  border: 0;
  background: transparent;
  cursor: pointer;
  width: 20px;
  height: 20px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  color: var(--neutral-mid);
  transition: color var(--duration-fast) var(--ease), background var(--duration-fast) var(--ease);
}
.md-render :deep(.md-codeblock__copy:hover) {
  color: var(--neutral-fg);
  background: var(--surface-hover);
}
/* 复制 icon：默认 Copy（用 inline SVG mask），已复制态用 .is-copied 切换为 Check。
   v-html 内不能用 Vue 组件 icon，用 CSS background + currentColor mask 实现 icon 着色。 */
.md-render :deep(.md-codeblock__copy::before) {
  content: '';
  display: block;
  width: 13px;
  height: 13px;
  background-color: currentColor;
  /* Copy icon（lucide copy path） */
  -webkit-mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='9' y='9' width='13' height='13' rx='2' ry='2'/><path d='M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'/></svg>") center / contain no-repeat;
  mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='9' y='9' width='13' height='13' rx='2' ry='2'/><path d='M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'/></svg>") center / contain no-repeat;
}
.md-render :deep(.md-codeblock__copy.is-copied) {
  color: var(--success);
}
.md-render :deep(.md-codeblock__copy.is-copied::before) {
  /* Check icon（lucide check path） */
  -webkit-mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='20 6 9 17 4 12'/></svg>") center / contain no-repeat;
  mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='20 6 9 17 4 12'/></svg>") center / contain no-repeat;
}

/* shiki <pre>：被容器包住后去掉自身 margin/圆角，仅保留内边距 + 横向滚动。
   背景用 --bg-input（凹陷容器语义，跟随 6 套主题；min 系列 shiki 主题背景透明）。 */
.md-render :deep(.md-codeblock pre.shiki) {
  margin: 0;
  padding: 0.8em 1em;
  border-radius: 0;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 0.85em;
  line-height: 1.6;
  background: var(--bg-input);
}
.md-render :deep(.md-codeblock pre.shiki code) {
  font-family: inherit;
  background: transparent;
  padding: 0;
}

/* mermaid 容器：居中 + 内边距（MermaidRenderer 内的 .md-mermaid-wrap） */
.md-render :deep(.md-mermaid) {
  margin: 0.8em 0;
  text-align: center;
}

/* 表格滚动 CSS 化（原 .md-table-wrap div 包裹已删——markdown.ts 不再产出 wrapper，
   table 直挂滚动能力）：GitHub 全套四条声明缺一不可——只写 display:block+overflow 时
   块盒默认撑满容器、收缩只发生在内部匿名 table 盒，出现「全宽外框 + 收缩网格 + 外框
   内大片空白」的混合形态；补 width:max-content 后窄表真收缩、max-width:100% 封顶，
   超宽表横向滚动不撑宽 .md-render / detail-content。窄表收缩到内容宽 = GitHub 同形态
   （显式接受的行为变化，设计 §3.5）。border/radius/margin 自原 wrapper 迁移直挂。 */
.md-render :deep(table) {
  display: block;
  overflow-x: auto;
  width: max-content;
  max-width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  margin: 0.7em 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 0.92em;
}
/* th/td 规则拆两条（th/td 对齐转写的配套条件，设计 D3 R5/R6）：border/padding 无条件
   ——整条加守卫会让带 align 的单元格连边框内边距一起丢；仅 text-align 移入 :not([align])
   守卫——无 align 属性兜底 left（维持现状视觉基线），有 align 属性（markdown-it 的
   style 经 markdown.ts 转写而来）时守卫不命中、HTML 呈现属性生效（align 优先级低于
   任何作者规则，转写不同批改宿主 CSS 则列对齐回归依旧）。 */
.md-render :deep(th),
.md-render :deep(td) {
  border-right: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  padding: 0.35em 0.6em;
}
.md-render :deep(th:not([align])),
.md-render :deep(td:not([align])) {
  text-align: left;
}
.md-render :deep(th:last-child),
.md-render :deep(td:last-child) {
  border-right: 0;
}
.md-render :deep(tbody tr:last-child td) {
  border-bottom: 0;
}
.md-render :deep(th) {
  background: var(--surface-2);
  font-weight: 600;
  color: var(--neutral-fg);
}

.md-render :deep(hr) {
  border: 0;
  border-top: 1px solid var(--border);
  margin: 1em 0;
}

/* ── shiki 双主题切换（defaultColor:false，min-dark/min-light 透明底）──
   [HISTORICAL] 亮色切换曾写 :global([data-theme="light"]) X :deep(Y)，Vue scoped 编译
   把「:global 开头 + :deep 结尾」的组合退化成裸 [data-theme="light"]（只匹配 html 元素），
   亮色规则从未作用于代码块——亮色主题下代码块恒为暗色画布。修复：整条选择器包进
   :global（compileStyle 验证输出 [data-theme="light"] .md-render .shiki span）。
   代码块底色由 .md-codeblock pre.shiki 的 var(--bg-input) 提供（跟随全部主题），
   shiki 只提供语法 token 色（明暗两档，独立彩色通道不跟 accent 走）。 */
.md-render :deep(.shiki span) {
  color: var(--shiki-dark);
}

:global([data-theme="light"] .md-render .shiki span) {
  color: var(--shiki-light);
}

/* ── thinking variant：次要过程信息的降级排版 ──
   用于 thinking 块等「过程性次要信息」语境。
   设计取向（impeccable critique 确认）：
   - 标题用 --reasoning（紫）而非 --fg（白），避免与正文 summary 白标题撞色，保持紫色语义族
   - li::marker / blockquote 压到 --subtle（三级灰），结构存在但不抢戏
   - strong 回升到 --fg，提供强调层级（muted 段落里 fg 粗体是唯一强调点）
   - p 行高保持 1.7（继承默认），段落间距与正文一致 */
.md-render--thinking :deep(h1),
.md-render--thinking :deep(h2),
.md-render--thinking :deep(h3),
.md-render--thinking :deep(h4) {
  color: var(--reasoning);
}
.md-render--thinking :deep(li)::marker {
  color: var(--neutral-dim);
}
.md-render--thinking :deep(blockquote) {
  color: var(--neutral-dim);
  border-left-color: var(--border-strong);
}
.md-render--thinking :deep(blockquote) p {
  color: var(--neutral-dim);
}
.md-render--thinking :deep(strong) {
  color: var(--neutral-fg);
  font-weight: 600;
}
</style>
