<template>
  <!--
    ToolDetailRenderer —— read/write/edit 工具展开细节富渲染的路由壳（tool-detail-rich）。

    经 ChatViewDeps.toolDetailRenderer 由壳注入 ui Block.vue（ui 只路由不实现，反向依赖
    禁令）；本组件在 renderer 侧实现，复用 detail-renderers 既有资产（DiffView/parseDiff/
    extToLang/gitApi），零新数据通路：

    - edit → pi 返回的 details.patch 本身就是 unified patch（Diff.createTwoFilesPatch；
      注意 details.diff 是展示格式非 unified，不可混用），直接喂 DiffView。
    - write → 懒加载 git diff：非空 patch（已跟踪文件被改写）→ DiffView + 「相对 git HEAD」；
      空 patch（untracked）→ input.content 合成全增 patch + 「新文件」；api 失败/无 sessionId
      → 合成全增 patch 无标注（不误标）。合成 patch 形态与 git 对新文件的 diff 输出同构
      （--- /dev/null +++ b/path @@ -0,0 +1,N @@），parseDiff 可解析。
    - read → output 剥掉 pi 截断脚注（[Showing lines ...] 等移为块内底部收口行）→
      ReadFileCode 行号代码块；起始行号 = input.offset（分段读续读行号连续）。

    水平滚动各分支自管理（overflow-x-auto）；限高/渐隐由宿主 ui BlockScrollBox 承担。
  -->
  <!-- edit：unified patch 直接渲染 -->
  <div v-if="toolName === 'edit' && editPatch" class="overflow-x-auto" data-testid="tool-detail-edit">
    <div class="flex items-center gap-2 py-1 pl-4 font-mono text-[length:var(--text-2xs)] text-neutral-dim">{{ argPath }}</div>
    <DiffView :patch="editPatch" :path="argPath" :injectable="false" />
  </div>

  <!-- write：懒加载 git diff（pending 显加载行） -->
  <div v-else-if="toolName === 'write'" class="overflow-x-auto" data-testid="tool-detail-write">
    <div
      v-if="writeState === 'loading'"
      class="py-1 pl-4 font-mono text-[length:var(--text-2xs)] text-neutral-dim"
      data-testid="tool-detail-write-loading"
    >{{ t('panel.message.toolDetailDiffLoading') }}</div>
    <template v-else-if="writePatch">
      <div
        v-if="writeState === 'new' || writeState === 'git'"
        class="flex items-center gap-2 py-1 pl-4 font-mono text-[length:var(--text-2xs)]"
        :class="writeState === 'new' ? 'text-success' : 'text-neutral-dim'"
        data-testid="tool-detail-write-label"
      >{{ writeState === 'new' ? t('panel.message.toolDetailNewFile') : t('panel.message.toolDetailGitDiff') }}</div>
      <DiffView :patch="writePatch" :path="argPath" :injectable="false" />
    </template>
  </div>

  <!-- read：行号 gutter 代码块 -->
  <ReadFileCode
    v-else-if="toolName === 'read' && readDetail"
    :content="readDetail.content"
    :path="argPath"
    :start-line="readDetail.startLine"
    :footer="readDetail.footer"
    data-testid="tool-detail-read"
  />
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ToolCall } from '@taiji/shared'
import { git as gitApi } from '@/api'
import { parseDiff } from '@/composables/logic/parseDiff'
import DiffView from './DiffView.vue'
import ReadFileCode from './ReadFileCode.vue'

const props = defineProps<{
  tool: ToolCall
  sessionId?: string | null
}>()

const { t } = useI18n()

const toolName = computed(() => props.tool.toolName)

/** 顶层 input 安全读取（拍平 schema：pi builtin 工具参数都在顶层） */
const inputObj = computed<Record<string, unknown>>(() => {
  const input = props.tool.input
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
})

const argPath = computed(() => (typeof inputObj.value.path === 'string' ? inputObj.value.path : ''))

/* ── edit：details.patch（unified patch）──
 * pi edit details 两个字段语义不同（pi-coding-agent edit.js L137 实装锚点）：
 * - details.patch = generateUnifiedPatch（标准 unified，Diff.createTwoFilesPatch）→ 本组件嗂 DiffView；
 * - details.diff  = generateDiffString 展示格式（`+行号 内容`），core parseDiffStat 消费它算
 *   chip 增删统计——不可嗂 parseDiff（hunk 解析为 0，曾误用致「无差异内容」空态，真机验收抓出）。 */
const editPatch = computed(() => {
  if (toolName.value !== 'edit') return undefined
  const patch = props.tool.details?.patch
  return typeof patch === 'string' && patch ? patch : undefined
})

/* ── write：懒加载 git diff ──
 * 态语义：loading = api 在途；git = 已跟踪文件（非空 patch，相对 HEAD 累计差异）；
 * new = untracked（git patch 空 ⇒ untracked ⇒ 「新文件」标注成立）；plain = api 失败 /
 * 无 sessionId / 二进制（内容照常全增展示，不标注来源）。 */
const writeState = ref<'idle' | 'loading' | 'git' | 'new' | 'plain'>('idle')
const writePatch = ref('')
let writeSeq = 0

const writeContent = computed(() => {
  if (toolName.value !== 'write') return undefined
  const content = inputObj.value.content
  return typeof content === 'string' ? content : undefined
})

/** 合成全增 patch（形态与 git 对新文件的 diff 同构，parseDiff 可解析） */
function syntheticAddPatch(path: string, content: string): string {
  const lines = content.split('\n')
  const header = `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@`
  return `${header}\n${lines.map((l) => `+${l}`).join('\n')}`
}

watch(
  [() => props.tool.id, writeContent, argPath] as const,
  async ([, content, path]) => {
    if (toolName.value !== 'write' || content === undefined) {
      writeState.value = 'idle'
      writePatch.value = ''
      return
    }
    const seq = ++writeSeq
    writeState.value = 'loading'
    writePatch.value = ''
    if (!props.sessionId || !path) {
      // 无 session 上下文（测试/mock）：内容照常展示，不标来源
      writePatch.value = syntheticAddPatch(path, content)
      writeState.value = 'plain'
      return
    }
    try {
      const result = await gitApi.getDiff(props.sessionId, path)
      if (seq !== writeSeq) return
      if (result.binary) {
        writePatch.value = syntheticAddPatch(path, content)
        writeState.value = 'plain'
        return
      }
      const hasHunks = parseDiff(result.patch).hunks.length > 0
      writePatch.value = hasHunks ? result.patch : syntheticAddPatch(path, content)
      writeState.value = hasHunks ? 'git' : 'new'
    } catch {
      // api 失败：内容照常展示，不标来源（不误标新文件/重写）
      if (seq !== writeSeq) return
      writePatch.value = syntheticAddPatch(path, content)
      writeState.value = 'plain'
    }
  },
  { immediate: true },
)

/* ── read：剥截断脚注 + 起始行号 ──
 * pi read 输出尾部可能带三类续读提示（读源 pi-coding-agent read.js）：
 * [Showing lines A-B of C. Use offset=N to continue.] / [N more lines in file. ...] /
 * [Line N is X, exceeds Y limit. ...]——全部移为块内底部收口行，代码区只留纯内容。 */
const FOOTER_RES: readonly RegExp[] = [
  /\n?\[Showing lines \d+-\d+ of \d+\.[^\]]*\]\s*$/,
  /\n?\[\d+ more lines in file\.[^\]]*\]\s*$/,
  /\n?\[Line \d+ is [^\]]*exceeds[^\]]*\]\s*$/,
]

const readDetail = computed(() => {
  if (toolName.value !== 'read') return undefined
  const raw = props.tool.output ?? ''
  if (!raw) return undefined
  let content = raw
  let footer: string | undefined
  for (const re of FOOTER_RES) {
    const m = content.match(re)
    if (m?.index !== undefined) {
      footer = m[0].trim()
      content = content.slice(0, m.index).replace(/\n+$/, '')
      break
    }
  }
  const offset = inputObj.value.offset
  const startLine = typeof offset === 'number' && offset > 0 ? offset : 1
  return { content, footer, startLine }
})
</script>
