<!--
  Settings · SystemPrompt 菜单页（FR-4/FR-5）。
  两卡片：替换系统提示词 / 注入额外提示词（卡 2 含 taiji 内置能力告知开关，capability 段）。
  数据层：config.getSystemPrompt / setSystemPrompt（保存为显式按钮触发，不自动保存，
  失败走 toast error，成功走 toast info）。
  替换卡下方含可折叠的 pi 默认提示词参考区，展开后可一键复制（DEFAULT_PI_SYSTEM_PROMPT）。
-->
<template>
  <!-- max-w-[860px]：设置页内容列标准宽度（与 SystemPage.vue 共用同一约定）。
       非 Tailwind 标准档（3xl=768/4xl=896）——介于两者间为长表单宽度，改需同步 SystemPage。 -->
  <div data-testid="system-prompt-page" class="flex max-w-[860px] flex-col gap-3">
    <header class="page-head">
      <div class="head-text">
        <h1 class="title">{{ t('settings.menu.systemPrompt') }}</h1>
        <p class="desc">{{ t('settings.menu.systemPromptDesc') }}</p>
      </div>
    </header>

    <!-- corrupted 提示条：getSystemPrompt 返回 corrupted=true 时显示 -->
    <div
      v-if="corrupted"
      class="flex items-start gap-2 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-[12px] text-neutral-fg"
    >
      <AlertTriangle class="mt-px size-4 flex-shrink-0 text-warn" />
      <span>{{ t('settings.systemPrompt.corruptedHint') }}</span>
    </div>

    <!-- 卡 1：替换系统提示词 -->
    <GroupCard>
      <template #head>
        <div class="gc-head-text">
          <h3 class="gc-title">{{ t('settings.systemPrompt.replaceTitle') }}</h3>
          <p class="gc-sub">{{ t('settings.systemPrompt.replaceSubtitle') }}</p>
        </div>
      </template>
      <template #actions>
        <Switch
          :data-testid="'system-prompt-replace-switch'"
          :model-value="replaceEnabled"
          @update:model-value="replaceEnabled = $event === true"
        />
      </template>
      <div class="px-4 py-3">
        <p class="mb-2 text-[11px] leading-relaxed text-neutral-mid">{{ t('settings.systemPrompt.replaceWarning') }}</p>
        <Label class="mb-1 block text-[11px] text-neutral-dim" for="system-prompt-replace-input">
          {{ t('settings.systemPrompt.replaceLabel') }}
        </Label>
        <Textarea
          id="system-prompt-replace-input"
          data-testid="system-prompt-replace-input"
          v-model="replacePrompt"
          :placeholder="t('settings.systemPrompt.replacePlaceholder')"
          :disabled="!replaceEnabled"
          class="min-h-[120px] resize-y font-mono text-[12px]"
        />
        <div class="mt-1 flex items-center justify-between">
          <span class="font-mono text-[10px] text-neutral-dim">{{ replacePrompt.length }}/{{ maxLength }}</span>
          <!-- foot 操作簇（v6 demo sp-foot 范式）：放弃（还原快照）+ 恢复默认（清空关开关，仅 replace 卡）+ 保存。dirty 才可用。 -->
          <div class="flex items-center gap-1.5">
            <Button
              data-testid="system-prompt-replace-discard"
              variant="danger"
              size="dense"
              :disabled="!replaceDirty"
              @click="discardReplace"
            >
              {{ t('settings.systemPrompt.discard') }}
            </Button>
            <Button
              data-testid="system-prompt-replace-reset"
              variant="secondary"
              size="dense"
              :disabled="!replaceDirty"
              @click="resetReplace"
            >
              {{ t('settings.systemPrompt.restoreDefault') }}
            </Button>
            <Button
              data-testid="system-prompt-replace-save"
              size="dense"
              :disabled="!replaceDirty"
              @click="saveReplace"
            >
              {{ t('settings.systemPrompt.save') }}
            </Button>
          </div>
        </div>

        <!-- 可折叠：查看 pi 默认提示词参考 -->
        <div class="mt-3 border-t border-border pt-3">
          <Button
            data-testid="system-prompt-default-toggle"
            variant="ghost"
            size="sm"
            class="h-auto w-full justify-start gap-1 px-0 py-0 text-[11px] font-normal text-accent hover:bg-transparent hover:text-accent [&_svg]:size-3"
            @click="showDefaultPrompt = !showDefaultPrompt"
          >
            <ChevronRight class="transition-transform duration-[var(--duration)] ease-[var(--ease)]" :class="{ 'rotate-90': showDefaultPrompt }" />
            {{ t('settings.systemPrompt.defaultToggle') }}
          </Button>
          <div v-if="showDefaultPrompt" class="mt-2">
            <p class="mb-2 text-[10px] leading-relaxed text-neutral-dim">
              {{ t('settings.systemPrompt.defaultHint') }}
            </p>
            <Button
              data-testid="system-prompt-default-copy"
              variant="ghost"
              size="sm"
              class="mb-2 h-auto gap-1 px-0 py-0 text-[11px] text-neutral-dim hover:bg-transparent hover:text-neutral-fg [&_svg]:size-3"
              @click="copyDefaultPrompt"
            >
              <Copy />
              {{ t('settings.systemPrompt.copy') }}
            </Button>
            <pre
              data-testid="system-prompt-default-content"
              class="max-h-[240px] select-text overflow-auto whitespace-pre-wrap break-words rounded-sm bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-neutral-fg"
            >{{ DEFAULT_PI_SYSTEM_PROMPT }}</pre>
          </div>
        </div>
      </div>
    </GroupCard>

    <!-- 卡 2：注入额外提示词 -->
    <GroupCard>
      <template #head>
        <div class="gc-head-text">
          <h3 class="gc-title">{{ t('settings.systemPrompt.appendTitle') }}</h3>
          <p class="gc-sub">{{ t('settings.systemPrompt.appendSubtitle') }}</p>
        </div>
      </template>
      <template #actions>
        <Switch
          :data-testid="'system-prompt-append-switch'"
          :model-value="appendEnabled"
          @update:model-value="appendEnabled = $event === true"
        />
      </template>
      <div class="px-4 py-3">
        <p class="mb-2 text-[11px] leading-relaxed text-neutral-mid">{{ t('settings.systemPrompt.appendHint') }}</p>
        <!-- taiji 内置能力告知开关（capability 段）：与 append 同卡同保存流（编辑不写盘，保存生效）。 -->
        <div class="mb-3 flex items-start justify-between gap-3 border-b border-border pb-3" data-testid="system-prompt-capability-row">
          <div class="min-w-0">
            <Label class="block text-[11px] text-neutral-dim" for="system-prompt-capability-switch">
              {{ t('settings.systemPrompt.capabilityLabel') }}
            </Label>
            <p class="mt-0.5 text-[11px] leading-relaxed text-neutral-mid">{{ t('settings.systemPrompt.capabilityHint') }}</p>
          </div>
          <Switch
            id="system-prompt-capability-switch"
            data-testid="system-prompt-capability-switch"
            :model-value="capabilityEnabled"
            @update:model-value="capabilityEnabled = $event === true"
          />
        </div>
        <Label class="mb-1 block text-[11px] text-neutral-dim" for="system-prompt-append-input">
          {{ t('settings.systemPrompt.appendLabel') }}
        </Label>
        <Textarea
          id="system-prompt-append-input"
          data-testid="system-prompt-append-input"
          v-model="appendPrompt"
          :placeholder="t('settings.systemPrompt.appendPlaceholder')"
          :disabled="!appendEnabled"
          class="min-h-[120px] resize-y font-mono text-[12px]"
        />
        <div class="mt-1 flex items-center justify-between">
          <!-- append 走 hook 不经 argv，无 32k/16000 硬上限约束，故只显示字符数不显示上限（R3）。 -->
          <span class="font-mono text-[10px] text-neutral-dim">{{ appendPrompt.length }} {{ t('settings.systemPrompt.charCount') }}</span>
          <div class="flex items-center gap-1.5">
            <Button
              data-testid="system-prompt-append-discard"
              variant="danger"
              size="dense"
              :disabled="!appendDirty"
              @click="discardAppend"
            >
              {{ t('settings.systemPrompt.discard') }}
            </Button>
            <Button
              data-testid="system-prompt-append-save"
              size="dense"
              :disabled="!appendDirty"
              @click="saveAppend"
            >
              {{ t('settings.systemPrompt.save') }}
            </Button>
          </div>
        </div>
      </div>
    </GroupCard>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle, ChevronRight, Copy } from '@lucide/vue'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { GroupCard } from '@taiji/ui/features/settings'
import { config } from '@/api'
import { useToast } from '@/composables/useToast'
import { SYSTEM_PROMPT_MAX_LENGTH, DEFAULT_PI_SYSTEM_PROMPT } from '@taiji/shared'
import type { SystemPromptConfig } from '@taiji/shared'

const { t } = useI18n()
const { info, error } = useToast()

const maxLength = SYSTEM_PROMPT_MAX_LENGTH

/** 当前加载的配置（getSystemPrompt 返回）。corrupted=true 表示磁盘损坏已回退默认。 */
const corrupted = ref(false)
const replaceEnabled = ref(false)
const replacePrompt = ref('')
const appendEnabled = ref(false)
const appendPrompt = ref('')
// capability 默认开：v1 存量 json / merge 层缺字段 → undefined → true（与扩展侧
// 「仅显式布尔 false 关闭」解析语义同向，见 @taiji/shared SystemPromptConfig 注释）
const capabilityEnabled = ref(true)

/** 已保存快照（v6 demo 范式）：loadConfig / 保存成功后刷新，dirty = 快照 diff。 */
const saved = ref({ replaceEnabled: false, replacePrompt: '', appendEnabled: false, appendPrompt: '', capabilityEnabled: true })
function snapshot() {
  saved.value = {
    replaceEnabled: replaceEnabled.value,
    replacePrompt: replacePrompt.value,
    appendEnabled: appendEnabled.value,
    appendPrompt: appendPrompt.value,
    capabilityEnabled: capabilityEnabled.value,
  }
}
const replaceDirty = computed(
  () => replaceEnabled.value !== saved.value.replaceEnabled || replacePrompt.value !== saved.value.replacePrompt,
)
// 卡 2（注入卡）dirty = append 编辑 + capability 开关（同卡同保存流）
const appendDirty = computed(
  () => appendEnabled.value !== saved.value.appendEnabled || appendPrompt.value !== saved.value.appendPrompt
    || capabilityEnabled.value !== saved.value.capabilityEnabled,
)

/** 参考区展开态（默认折叠）。 */
const showDefaultPrompt = ref(false)

/** 构造完整 SystemPromptConfig（schema v2：含 capability 段，保存时写回完整结构）。 */
function buildConfig(): SystemPromptConfig {
  return {
    version: 2,
    replace: { enabled: replaceEnabled.value, prompt: replacePrompt.value },
    append: { enabled: appendEnabled.value, prompt: appendPrompt.value },
    capability: { enabled: capabilityEnabled.value },
  }
}

/** 加载系统提示词配置到本地编辑态。 */
async function loadConfig(): Promise<void> {
  try {
    const res = await config.getSystemPrompt()
    corrupted.value = res.corrupted
    replaceEnabled.value = res.config.replace.enabled
    replacePrompt.value = res.config.replace.prompt
    appendEnabled.value = res.config.append.enabled
    appendPrompt.value = res.config.append.prompt
    capabilityEnabled.value = res.config.capability?.enabled ?? true
    snapshot()
  } catch (e) {
    error(e instanceof Error ? e.message : String(e))
  }
}

/** 放弃替换卡编辑：还原已保存快照（dirty 归零）。 */
function discardReplace(): void {
  replaceEnabled.value = saved.value.replaceEnabled
  replacePrompt.value = saved.value.replacePrompt
}

/** 放弃追加卡编辑（含 capability 开关）：还原已保存快照（dirty 归零）。 */
function discardAppend(): void {
  appendEnabled.value = saved.value.appendEnabled
  appendPrompt.value = saved.value.appendPrompt
  capabilityEnabled.value = saved.value.capabilityEnabled
}

/** 恢复默认（v6 demo resetDefault 语义）：清空 replace 文本 + 关开关。编辑操作不写盘，需保存生效。 */
function resetReplace(): void {
  replaceEnabled.value = false
  replacePrompt.value = ''
}

/** 保存替换卡：以当前编辑态写回 config。 */
async function saveReplace(): Promise<void> {
  try {
    await config.setSystemPrompt(buildConfig())
    snapshot()
    info(t('settings.systemPrompt.savedToast'))
  } catch (e) {
    error(e instanceof Error ? e.message : String(e))
  }
}

/** 保存追加卡：以当前编辑态写回 config。 */
async function saveAppend(): Promise<void> {
  try {
    await config.setSystemPrompt(buildConfig())
    snapshot()
    info(t('settings.systemPrompt.savedToast'))
  } catch (e) {
    error(e instanceof Error ? e.message : String(e))
  }
}

/** 复制 pi 默认提示词到剪贴板。失败走 error toast，成功走 info toast。 */
async function copyDefaultPrompt(): Promise<void> {
  try {
    await navigator.clipboard.writeText(DEFAULT_PI_SYSTEM_PROMPT)
    info(t('settings.systemPrompt.copiedToast'))
  } catch (e) {
    error(e instanceof Error ? e.message : String(e))
  }
}

onMounted(() => {
  void loadConfig()
})
</script>
