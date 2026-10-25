<script setup lang="ts">
// NewTaskSheet —— 新建任务 Sheet（remote-use-mobile-v2 §6.12：项目 chip 主路径 + cwd 派生
// + 手输兜底；v1 形态的字段与幂等键语义原样保留）。
//
// 项目 chip 数据面（§6.12 采用段字面）：
// - 清单 = project.load RPC（fetchProjects，V-2 结论）；排序 = 客户端按 SessionSummary
//   （projectId, lastActiveAt）聚合（aggregateProjectChips 纯函数单点）——**禁用
//   Project.lastUsedAt 作活跃信号**（R6.2：仅创建时写入、不可变，按它排得到创建序）；
// - cwd 派生 = 选中项目最近一个会话的 SessionSummary.cwd（客户端自 config.sessions 摘要
//   派生，摘要含 cwd）；项目无会话（chip.cwd 缺）或 RPC 失败/空 → v1 手输路径兜底
//   （Input 形态保留，主路径降级链终点）；
// - 选中 chip 创建时携带 projectId（D14 创建时归属语义，createMobileTask 透传）。
// 首条消息必填校验 + clientUuid 幂等（per-open 黏滞槽，v1 A17/U18 语义原样）。
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { randomUuid } from '@taiji/core'
import { Button, Input, Sheet, Textarea } from '@taiji/ui'
import type { Project, SessionSummary } from '@taiji/shared'
import { createMobileTask, fetchProjects, sessionList } from '../shell/app-runtime'
import { aggregateProjectChips, type ProjectChip } from './project-chips'

const props = defineProps<{ open: boolean }>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'created', session: SessionSummary): void
}>()

const { t } = useI18n()

// ── 项目 chip 数据（§6.12 主路径）───────────────────────────────────────

/** 全量项目清单（project.load；null = 未拉取，[] = 拉取成功但空） */
const projects = ref<Project[]>([])
/** RPC 失败标记（降级手输路径的判据之一；失败不重试不占错误条——新建任务是辅助流，
 * 失败面 = 手输兜底即恢复路径，§7.4 错误处理契约「接入点降级」） */
const projectsLoadFailed = ref(false)

onMounted(() => {
  fetchProjects()
    .then((state) => {
      projects.value = state.projects
    })
    .catch((e: unknown) => {
      console.warn('[NewTaskSheet] project.load failed, falling back to manual cwd input:', e)
      projectsLoadFailed.value = true
    })
})

/** chip 横滑数据（清单 × 会话摘要聚合排序；响应式跟随 sessionList 广播刷新） */
const chips = computed<ProjectChip[]>(() => aggregateProjectChips(projects.value, sessionList.value))

/** 手输兜底形态（§6.12 降级链：RPC 失败 / 项目清单与聚合双空 → 主路径不可用） */
const manualMode = computed(() => projectsLoadFailed.value || chips.value.length === 0)

/** 用户显式切换手输（chip 模式下的逃生口——目标项目不在清单时不必回桌面） */
const manualOverride = ref(false)
const isManual = computed(() => manualMode.value || manualOverride.value)

/** 选中 chip（null = 手输模式或未选） */
const selectedChip = ref<ProjectChip | null>(null)

function selectChip(chip: ProjectChip): void {
  selectedChip.value = chip
  // cwd 派生：该项目最近会话的 cwd（chip.cwd 缺 = 项目无会话，回落手输并保留选中归属）
  cwd.value = chip.cwd ?? ''
}

function switchToManual(): void {
  manualOverride.value = true
  selectedChip.value = null
}

// ── 表单字段（v1 语义原样：必填校验 + 幂等键黏滞槽）────────────────────────

const cwd = ref('')
const firstMessage = ref('')
const submitting = ref(false)
const errorText = ref('')

// [remote-use A17/U18] 创建流幂等键（per-open 黏滞槽）：uuid 按「意图」稳定——打开时生成
// 一次存 ref，提交失败的原样重试复用同键（runtime 按 clientUuid 幂等返回已建 session，
// 弱网超时重试不双建，对齐 core 黏滞槽语义 new-task-search/flow.ts takeClientUuidFor）；
// 提交成功或关闭才重置（意图落定/放弃即换槽）。重置 = 换入新 uuid（非清空）：槽内恒为
// 合法键，成功后未关窗口内的再次提交（新意图）自带新键；禁 per-call 生成——onSubmit 只
// 读槽不生成，重试路径（失败）永不重置。
const clientUuid = ref('')

// 打开时重置表单 + 生成新意图键（关闭态保留 DOM 但字段清空，下次进入是干净表单）；
// immediate 覆盖「挂载即开」的边角（open 初始 true 时 watcher 不触发的窗口）
watch(
  () => props.open,
  (open) => {
    clientUuid.value = randomUuid()
    if (open) {
      cwd.value = ''
      firstMessage.value = ''
      errorText.value = ''
      selectedChip.value = null
      manualOverride.value = false
    }
  },
  { immediate: true },
)

async function onSubmit(): Promise<void> {
  if (submitting.value) return
  if (cwd.value.trim() === '' || firstMessage.value.trim() === '') {
    errorText.value = t('mobile.newTask.required')
    return
  }
  submitting.value = true
  errorText.value = ''
  try {
    const session = await createMobileTask({
      cwd: cwd.value,
      firstMessage: firstMessage.value,
      clientUuid: clientUuid.value,
      // 选中 chip 创建时归属该项目（手输模式不归属——默认项目兜底）
      projectId: selectedChip.value?.projectId,
    })
    if (session) {
      // 提交成功 = 意图落定，槽重置（换入新键，见上方 clientUuid 注释）
      clientUuid.value = randomUuid()
      emit('created', session)
      emit('close')
    } else {
      errorText.value = t('mobile.newTask.required')
    }
  } catch (e) {
    console.error('[new-task] create failed:', e)
    errorText.value = e instanceof Error ? e.message : String(e)
  } finally {
    submitting.value = false
  }
}

function onClose(): void {
  emit('close')
}
</script>

<template>
  <Sheet
    :open="open"
    :title="t('mobile.newTask.title')"
    data-testid="new-task-sheet"
    @update:open="!$event && onClose()"
  >
    <!-- 项目 chip 横滑（§6.12 主路径；chips 非空且未切手输时呈现） -->
    <div v-if="!isManual" class="flex flex-col gap-2" data-testid="new-task-chips">
      <p class="text-[length:var(--m-text-sub)] text-neutral-mid">{{ t('mobile.newTask.projectLabel') }}</p>
      <div class="flex gap-2 overflow-x-auto pb-1" data-testid="new-task-chip-row">
        <Button
          v-for="chip in chips"
          :key="chip.projectId"
          :data-testid="`new-task-chip-${chip.projectId}`"
          :variant="selectedChip?.projectId === chip.projectId ? 'secondary' : 'ghost'"
          class="flex min-h-[var(--m-tap)] shrink-0 flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left"
          :class="selectedChip?.projectId === chip.projectId
            ? 'border-accent bg-accent-soft'
            : 'border-border bg-surface-2'"
          @click="selectChip(chip)"
        >
          <span class="text-[length:var(--m-text-sub)] font-medium text-neutral-fg">
            {{ chip.name !== '' ? chip.name : t('mobile.newTask.defaultProjectName') }}
          </span>
          <span class="text-[length:var(--m-text-sub)] text-neutral-mid">
            {{ t('mobile.newTask.chipMeta', { count: chip.sessionCount }) }}
          </span>
          <span
            v-if="chip.cwd"
            class="max-w-[220px] truncate font-mono text-[length:var(--m-text-sub)] text-neutral-mid"
          >{{ chip.cwd }}</span>
        </Button>
      </div>
      <!-- 手输逃生口（chip 模式下目标项目不在清单时，不必回桌面） -->
      <Button variant="quiet" data-testid="new-task-manual-switch" @click="switchToManual">
        {{ t('mobile.newTask.switchToManual') }}
      </Button>
    </div>

    <!-- cwd（chip 选中派生只读展示 / 手输模式 Input；§6.12「路径只读展示」+ 兜底手输） -->
    <label class="flex flex-col gap-1">
      <span class="text-[length:var(--m-text-sub)] text-neutral-mid">{{ t('mobile.newTask.cwdLabel') }}</span>
      <Input
        v-if="isManual || !selectedChip"
        v-model="cwd"
        :placeholder="t('mobile.newTask.cwdPlaceholder')"
        data-testid="new-task-cwd"
      />
      <p
        v-else
        class="break-all rounded bg-surface-2 px-2.5 py-2 font-mono text-[length:var(--m-text-sub)] text-neutral-fg"
        data-testid="new-task-cwd-derived"
      >{{ cwd }}</p>
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-[length:var(--m-text-sub)] text-neutral-mid">{{ t('mobile.newTask.messageLabel') }}</span>
      <Textarea
        v-model="firstMessage"
        :placeholder="t('mobile.newTask.messagePlaceholder')"
        rows="3"
        data-testid="new-task-message"
      />
    </label>

    <p v-if="errorText" class="text-[length:var(--m-text-sub)] text-danger" data-testid="new-task-error" role="alert">
      {{ errorText }}
    </p>

    <template #footer>
      <Button variant="ghost" data-testid="new-task-cancel" @click="onClose">
        {{ t('mobile.newTask.cancel') }}
      </Button>
      <Button
        variant="default"
        data-testid="new-task-submit"
        :disabled="submitting || cwd.trim() === '' || firstMessage.trim() === ''"
        @click="onSubmit"
      >
        {{ t('mobile.newTask.submit') }}
      </Button>
    </template>
  </Sheet>
</template>
