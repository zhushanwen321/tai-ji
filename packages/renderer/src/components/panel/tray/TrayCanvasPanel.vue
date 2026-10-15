<!--
  TrayCanvasPanel —— composer 任务托盘第 5 件「画布」面板（problem-solve-canvas §3.1(3) u-tray-entry）。

  ── 数据面（native 直连，零新协议）──
  inject TRAY_COUNTS_KEY（外壳单例）：本面板**不自建 useTrayCounts 实例**（面板随 Popover
  开合反复挂载，自建即每次打开重发首拉）；画布清单来自 `tray.lists.canvas.entries`
  （canvas.list 投影；订阅/首拉/`canvas.updated` 失效重拉在 use-canvas-sync 订阅链内收敛，
  外壳挂载即活）。画布是跨 session 共享资源（设计 D4/D7）：清单无 session 过滤（全量）、
  面板 props 无 sessionId（数据与焦点会话无关）。

  ── 形态 ──
  扁平列表：每行 = 名称 + 阶段徽标 + must-fix 计数，行点击 = `openCanvasTab(canvasId)`
  （renderer 直达入口 = core openCanvasOverlay + overlay tab 归位 canvas，对齐 scheduler
  直开 openSchedulerTab 先例——两入口同态是设计 §3.1(3) 的明文要求）。
  阶段徽标是**派生值，非可写状态**（设计 §3.1(3)）：由 canvas.list 返回的派生输入计算——
  converged 终态 = 已收敛；有开放 must-fix 或审查进行中 = 审查中；其余 = 生长中。
  「＋ 新建画布」按钮恒在面板尾部：走三要素表单 modal（问题陈述 / 完成判据每行一条 /
  范围与排除项每行一条），缺一拒绝 = 不变量 1 的 GUI 前置校验（拒绝文案指明缺哪项；
  runtime 侧兜底校验更宽——statement 非空 + criterias 至少一条）。
  创建成功后本面板只关 modal 清表单：画布自动唤起由 use-canvas-sync 的 CanvasCreated
  广播分流承接（零新机制）；失败 toast 呈现结构化错误（message + recover 恢复指引）。
-->
<template>
  <div
    data-testid="tray-canvas-panel"
    :aria-label="t('panel.tray.title.canvas')"
    class="flex min-h-0 w-full flex-1 flex-col gap-1"
  >
    <!-- 段头摘要（与行集同源：total = entries.length，active = 未收敛数） -->
    <div
      v-if="entries.length > 0"
      data-testid="tray-canvas-header"
      class="flex shrink-0 items-center px-1.5 font-mono text-[length:var(--text-3xs)] text-neutral-dim"
    >
      <span class="min-w-0 flex-1 truncate">{{ headerText }}</span>
    </div>

    <ScrollArea v-if="entries.length > 0" class="min-h-0 flex-1">
      <div class="flex flex-col px-1.5">
        <div
          v-for="entry in entries"
          :key="entry.canvasId"
          data-testid="tray-canvas-row"
          :data-canvas-id="entry.canvasId"
          class="flex min-h-[26px] cursor-pointer select-none items-start gap-2 rounded-sm px-1.5 py-1 text-neutral-mid transition-colors hover:bg-surface-hover hover:text-neutral-fg"
          :title="entry.name"
          @click="openCanvas(entry)"
        >
          <!-- 7px 阶段点（色语言：生长中 accent / 审查中 warn / 已收敛 success） -->
          <span
            data-testid="tray-canvas-dot"
            class="mt-[5px] size-[7px] shrink-0 rounded-full"
            :class="PHASE_DOT_CLASS[phaseOf(entry)]"
            :title="phaseText(entry)"
            aria-hidden="true"
          />
          <div class="min-w-0 flex-1">
            <div class="flex min-w-0 items-center gap-1 text-[length:var(--text-xs)] leading-[1.35]">
              <span class="min-w-0 flex-1 truncate">{{ entry.name }}</span>
              <!-- must-fix 计数（>0 才渲染——归零不虚亮，与外壳三态同哲学） -->
              <span
                v-if="entry.openMustFix > 0"
                data-testid="tray-canvas-mustfix"
                class="shrink-0 font-mono text-[length:var(--text-3xs)] tabular-nums text-warn"
              >{{ t('panel.tray.canvas.mustFix', { count: entry.openMustFix }) }}</span>
            </div>
            <div
              data-testid="tray-canvas-meta"
              class="mt-0.5 flex min-w-0 items-center gap-1 font-mono text-[length:var(--text-3xs)] leading-[1.3] text-neutral-dim"
            >
              <span class="min-w-0 flex-1 truncate">
                {{ phaseText(entry) }}<template v-if="entry.statement"> · {{ entry.statement }}</template>
              </span>
            </div>
          </div>
        </div>
      </div>
    </ScrollArea>

    <!-- 空态（画布件按钮恒渲染，零画布时可到达：提示 + 引导新建） -->
    <div
      v-else
      data-testid="tray-canvas-empty"
      class="flex min-h-0 flex-1 items-center justify-center py-6 text-center"
    >
      <p class="text-[length:var(--text-2xs)] text-neutral-dim opacity-55">
        {{ t('panel.tray.canvas.empty') }}
      </p>
    </div>

    <!-- 「＋ 新建画布」：创建入口唯一落点（外壳对 canvas 件豁免「全无不渲染」过滤的根因） -->
    <div class="shrink-0 border-t border-hairline px-1.5 pb-1 pt-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-testid="tray-canvas-create"
        class="w-full justify-start gap-1.5 text-neutral-mid"
        @click="openCreateModal"
      >
        <Plus class="size-[14px] shrink-0" aria-hidden="true" />
        <span class="truncate">{{ t('panel.tray.canvas.create') }}</span>
      </Button>
    </div>

    <!-- 三要素表单 modal（问题陈述 / 完成判据 / 范围与排除项；缺一拒绝 = 不变量 1 前置校验） -->
    <Dialog :open="createOpen" @update:open="onCreateOpenChange">
      <DialogContent class="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{{ t('panel.tray.canvas.form.title') }}</DialogTitle>
          <DialogDescription>{{ t('panel.tray.canvas.form.description') }}</DialogDescription>
        </DialogHeader>

        <form
          data-testid="tray-canvas-form"
          class="mt-2 space-y-4"
          @submit.prevent="onSubmitCreate"
        >
          <div class="space-y-2">
            <Label for="tray-canvas-statement">{{ t('panel.tray.canvas.form.statement') }}</Label>
            <Input
              id="tray-canvas-statement"
              v-model="formStatement"
              data-testid="tray-canvas-statement"
              :placeholder="t('panel.tray.canvas.form.statementPlaceholder')"
              autocomplete="off"
            />
          </div>
          <div class="space-y-2">
            <Label for="tray-canvas-criterias">{{ t('panel.tray.canvas.form.criterias') }}</Label>
            <Textarea
              id="tray-canvas-criterias"
              v-model="formCriterias"
              data-testid="tray-canvas-criterias"
              :placeholder="t('panel.tray.canvas.form.criteriasPlaceholder')"
              :rows="3"
            />
          </div>
          <div class="space-y-2">
            <Label for="tray-canvas-scope">{{ t('panel.tray.canvas.form.scopeExclusions') }}</Label>
            <Textarea
              id="tray-canvas-scope"
              v-model="formScope"
              data-testid="tray-canvas-scope"
              :placeholder="t('panel.tray.canvas.form.scopeExclusionsPlaceholder')"
              :rows="3"
            />
          </div>

          <!-- 缺一拒绝文案：提交时列出全部缺失项（指明缺哪项——不变量 1 的拒绝呈现） -->
          <p
            v-if="missingText"
            data-testid="tray-canvas-form-error"
            class="text-[length:var(--text-xs)] font-medium text-danger"
            role="alert"
          >
            {{ missingText }}
          </p>

          <div class="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" @click="closeCreateModal">
              {{ t('panel.tray.canvas.form.cancel') }}
            </Button>
            <Button type="submit" size="sm" data-testid="tray-canvas-submit" :disabled="creating">
              {{ t('panel.tray.canvas.form.submit') }}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  </div>
</template>

<script setup lang="ts">
/**
 * 脚本分区：数据面（inject 外壳单例 + 阶段徽标派生）/ 行动作（打开 = openCanvasTab）/
 * 三要素 modal（开合 + 表单态 + 不变量 1 前置校验 + create mutate）。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus } from '@lucide/vue'
import { command, RPC_BACKSTOP_TIMEOUT_MS } from '@taiji/core/transport/api'
import { toErrorMessage } from '@taiji/core'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/composables/useToast'
import { useTrayCountsContext } from '@/components/panel/tray/useTrayCounts'
import { openCanvasTab } from '@/components/panel/workflow-viz/overlay/workflow-viz-overlay'
import { phaseOfFacts, type CanvasPhase } from '@/components/canvas/canvas-display'
import type { CanvasListEntry } from '@zhushanwen/extension-protocol'

withDefaults(defineProps<{
  /** pin 态（外壳统一透传：行内操作仅 pin 态渲染，D8 防误触——托盘段内面板的共同契约；
   * 画布无行内破坏性操作，唯一动作是打开 overlay，故本面板不消费该值） */
  pinned?: boolean
}>(), { pinned: false })

const { t } = useI18n()
const { error: toastError } = useToast()

/** 数据面（单例注入）：实例由外壳 ComposerTray 创建并 provide，本面板零拉取（见文件头） */
const tray = useTrayCountsContext()
const entries = computed(() => tray.lists.canvas.entries.value)

/** 段头摘要（计数与行集同源：进行中 = 未收敛数） */
const headerText = computed(() =>
  t('panel.tray.canvas.header', {
    total: tray.counts.value.canvas.total,
    active: tray.counts.value.canvas.running,
  }),
)

// ── 阶段徽标（派生值非可写状态：由 canvas.list 派生输入计算，见文件头）──

/** 阶段点色（色语言 SSOT = 语义色类：活动 accent / 待人 warn / 完成 success） */
const PHASE_TEXT_KEY: Record<CanvasPhase, string> = {
  growing: 'growing',
  reviewing: 'reviewing',
  converged: 'converged',
}

const PHASE_DOT_CLASS: Record<CanvasPhase, string> = {
  growing: 'bg-accent',
  reviewing: 'bg-warn',
  converged: 'bg-success',
}

/** 清单条目适配（全量态适配在 canvas-display 的 canvasPhaseOf——规则单处 = phaseOfFacts）。 */
function phaseOf(entry: CanvasListEntry): CanvasPhase {
  return phaseOfFacts({
    converged: entry.converged,
    openMustFix: entry.openMustFix,
    reviewInProgress: entry.reviewStatus === 'in-progress',
  })
}

function phaseText(entry: CanvasListEntry): string {
  return t(`panel.tray.canvas.phase.${PHASE_TEXT_KEY[phaseOf(entry)]}`)
}

// ── 行动作：打开画布（renderer 直达入口，core openCanvasOverlay + tab 归位，见文件头）──

function openCanvas(entry: CanvasListEntry): void {
  openCanvasTab(entry.canvasId)
}

// ── 三要素 modal（新建画布）──

const createOpen = ref(false)
const formStatement = ref('')
const formCriterias = ref('')
const formScope = ref('')
const creating = ref(false)

/** 多行文本 → 行集（每行一条；trim 后丢弃空行） */
function linesOf(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * 不变量 1 前置校验：三要素缺一拒绝，返回全部缺失项的本地化名（拒绝文案指明缺哪项——
 * 多项同缺一次性列出，用户一次补全）。
 */
function missingFields(): string[] {
  const missing: string[] = []
  if (formStatement.value.trim() === '') missing.push(t('panel.tray.canvas.form.statement'))
  if (linesOf(formCriterias.value).length === 0) missing.push(t('panel.tray.canvas.form.criterias'))
  if (linesOf(formScope.value).length === 0) missing.push(t('panel.tray.canvas.form.scopeExclusions'))
  return missing
}

const missingText = computed(() => {
  const missing = missingFields()
  if (missing.length === 0) return ''
  return t('panel.tray.canvas.missing', { items: missing.join(t('panel.tray.canvas.listSep')) })
})

function resetForm(): void {
  formStatement.value = ''
  formCriterias.value = ''
  formScope.value = ''
}

function openCreateModal(): void {
  resetForm()
  createOpen.value = true
}

function closeCreateModal(): void {
  createOpen.value = false
}

function onCreateOpenChange(open: boolean): void {
  if (!open) closeCreateModal()
}

/**
 * 提交：缺一拒绝（modal 内就近呈现，不发 mutate）；通过 = mutate(create, actor=user)。
 * 成功只关 modal——CanvasCreated 广播驱动自动唤起（use-canvas-sync 承接）+ 清单刷新；
 * 失败 toast 结构化错误（message + recover 恢复指引），modal 保持可改。
 */
async function onSubmitCreate(): Promise<void> {
  if (creating.value) return
  if (missingFields().length > 0) return
  creating.value = true
  try {
    const reply = await command('canvas.mutate', {
      actor: 'user',
      action: 'create',
      params: {
        statement: formStatement.value.trim(),
        criterias: linesOf(formCriterias.value),
        scopeExclusions: linesOf(formScope.value),
      },
    }, RPC_BACKSTOP_TIMEOUT_MS)
    if (!reply.ok) {
      toastError(t('panel.tray.canvas.createFailed', {
        msg: `${reply.error.message} ${reply.error.recover}`.trim(),
      }))
      return
    }
    closeCreateModal()
  } catch (e) {
    toastError(t('panel.tray.canvas.createFailed', { msg: toErrorMessage(e) }))
  } finally {
    creating.value = false
  }
}
</script>
