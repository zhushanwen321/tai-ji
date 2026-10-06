<script setup lang="ts">
/**
 * ANSI 文本渲染组件（v6）——用 ansi_up 解析 ANSI 转义序列，输出着色 HTML。
 *
 * 用于 tool result 的原始 ANSI 文本（ToolCall.outputRaw）。
 * 当 extension 未引入协议包时，tool result 的 ANSI 输出走此组件兜底（§5.5 永远保留）。
 *
 * 渲染策略（增量续喂 + DOM 追加）：
 * - content 在已喂入前缀之后纯增长（流式输出常态）时，只解析增量 delta 并
 *   insertAdjacentHTML 追加到容器尾部，已有 DOM 节点不动（避免几千个 span 销毁重建）。
 * - ansi_up 是有状态流式解析器：fg/bg/bold 状态跨调用持久，不完整转义序列残段
 *   留在实例内部 buffer 等下次续喂——同一段文本持续增长必须复用同一实例，
 *   否则颜色状态在段边界丢失（如「red 无 reset」后续喂的文本不再着色）。
 * - 前缀收缩 / 整条替换 / 首挂载 / 降级后恢复：新建 AnsiUp 实例全量重渲染。
 *   「换内容必须隔离状态」：复用实例会让上次未 reset 的颜色污染下一段纯文本（串色）。
 * - processedLen = 已喂入解析器的 content 字符数。转义残段留在实例 buffer 时
 *   processedLen 已推进到 content 末尾是正确的：残段字节已喂入解析器，
 *   前缀判定只依赖已喂入前缀，不依赖 buffer 状态。
 *
 * v6 视觉契约（§3.7 + §8）：
 * - use_classes=true：ansi_up 输出 `ansi-{color}-fg` class（而非内联 rgb），由 CSS 层映射 v6 token。
 * - 16 fg class 双主题映射（DM1 对照 §8）：暗色基础 16 条，亮色仅覆盖 black/white 明度反转。
 * - bg 丢弃：不定义任何 .ansi-*-bg CSS 规则，ansi_up 输出的 bg span 无样式 = 透明（§8「不自加背景」）。
 * - escape_html 显式钉 true（XSS 安全）。
 *
 * 已知限制：ansi_up use_classes 对 256 色 truecolor 仍输出内联 rgb（不映射 v6 token），
 * spec §8 明确范围仅 16 色，256 色不映射（RK2，不扩 scope）。
 */
import { ref, watch, onMounted } from 'vue'
import { AnsiUp } from 'ansi_up'

const props = defineProps<{
  /** tool result 文本（含 ANSI 转义）。 */
  content: string
}>()

/** HTML 转义：catch 降级回退路径经 insertAdjacentHTML 注入，必须转义防 XSS */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const containerEl = ref<HTMLSpanElement | null>(null)

/** content 运行时归一：容器降级透传（原 props 无 content，PrimitiveRouter 未注册
 * 边缘路径）等场景下可为 undefined，统一收窄为字符串。 */
function textOf(v: string | undefined): string {
  return typeof v === 'string' ? v : ''
}

/** 续喂解析器实例：仅追加分支复用；重建分支新建（隔离旧内容的颜色状态）。 */
let parser: AnsiUp | null = null
/** 已喂入 parser 的 content 字符数；-1 = 降级态（parser 与 DOM 脱钩，下轮强制重建）。 */
let processedLen = -1

function createParser(): AnsiUp {
  const ansi = new AnsiUp()
  // v6：输出 class 而非内联 rgb，由 CSS 层映射 v6 token（双主题可 CSS 变量化）
  ansi.use_classes = true
  // 钉死 XSS 安全属性，不依赖 ansi_up 默认值（纵深防御）
  ansi.escape_html = true
  return ansi
}

/** 重建分支：新建实例全量解析整段替换；解析抛错降级为转义纯文本（语义与旧版一致）。 */
function renderFull(content: string): void {
  const el = containerEl.value
  if (!el) return
  parser = createParser()
  let html: string
  try {
    html = parser.ansi_to_html(content)
    // processedLen 与 parser 消费进度绑定：解析成功即推进，与 DOM 插入成败无关
    processedLen = content.length
  } catch {
    // 解析失败回退纯文本（ES2 降级）：注入前转义防 XSS；parser 置空，下轮强制重建
    html = escapeHtml(content)
    parser = null
    processedLen = -1
  }
  el.innerHTML = html
}

onMounted(() => {
  renderFull(textOf(props.content))
})

watch(
  () => textOf(props.content),
  (next, prev) => {
    const el = containerEl.value
    if (!el || !parser || prev === undefined) return
    // 追加分支：next 以「已喂入前缀」开头且纯增长 → 只解析 delta 只追加节点。
    // slice(0, processedLen) 而非 prev 全长：正常态两者相等，万一 processedLen 滞后
    // 仍保证 delta 从 parser 真实消费进度切起（DOM 与 parser 状态对齐）。
    if (next.length > processedLen && next.startsWith(prev.slice(0, processedLen))) {
      let html: string
      try {
        html = parser.ansi_to_html(next.slice(processedLen))
        processedLen = next.length
      } catch {
        renderFull(next)
        return
      }
      el.insertAdjacentHTML('beforeend', html)
      return
    }
    // 重建分支：前缀收缩（如 8KB 尾窗头删）/ 整条替换 → 全量重渲染
    renderFull(next)
  },
  { flush: 'post' },
)
</script>

<template>
  <!-- 内容经 createParser（escape_html=true）/ escapeHtml 两条受控路径生成，均为转义后文本 -->
  <span ref="containerEl" class="whitespace-pre-wrap font-mono" data-testid="ansi-text"></span>
</template>

<!--
  非 scoped <style>：ansi_up use_classes 输出的 span 经命令式 DOM 注入，scoped 选择器
  会加 [data-v-xxx] 属性后缀，但注入的子元素无该属性，scoped 无法命中。
  ansi-* class 名是 ansi_up 约定专属前缀，全局污染风险低（escape hatch：受控注入）。
  16 fg class 映射 v6 token；bg 不定义（丢弃）。
-->
<style>
.ansi-black-fg { color: var(--neutral-faint); }
.ansi-red-fg { color: var(--danger); }
.ansi-green-fg { color: var(--success); }
.ansi-yellow-fg { color: var(--warn); }
.ansi-blue-fg { color: var(--accent); }
.ansi-magenta-fg { color: var(--reasoning); }
.ansi-cyan-fg { color: var(--info); }
.ansi-white-fg { color: var(--neutral-fg); }
.ansi-bright-black-fg { color: var(--neutral-mid); }
.ansi-bright-red-fg { color: var(--danger); }
.ansi-bright-green-fg { color: var(--success); }
.ansi-bright-yellow-fg { color: var(--warn); }
.ansi-bright-blue-fg { color: var(--accent-hover); }
.ansi-bright-magenta-fg { color: var(--reasoning); }
.ansi-bright-cyan-fg { color: var(--info); }
.ansi-bright-white-fg { color: var(--neutral-fg); }

/* 亮色主题：black/white 明度反转（§8 亮色表，白底需深字）。
   其余 14 色语义 token 暗亮一致，靠 var(--danger) 等自动跟随主题。 */
[data-theme="light"] .ansi-black-fg { color: var(--neutral-fg); }
[data-theme="light"] .ansi-white-fg { color: var(--neutral-faint); }
</style>
