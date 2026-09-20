<!--
  Settings · Terminal 菜单页（Phase 6）。
  单卡片表单：shell / shellArgs / fontSize / fontFamily / scrollback / cursorStyle / bell。
  数据层：config.getTerminalConfig / setTerminalConfig（整体保存为显式按钮触发，不自动保存，
  失败走 toast error，成功走 toast info）。
  shellArgs 以逗号分隔输入，存储为 string[]。
-->
<template>
  <!-- max-w-[860px]：设置页内容列标准宽度（与 SystemPromptPage.vue / SystemPage.vue 共用同一约定）。 -->
  <div data-testid="terminal-page" class="flex max-w-[860px] flex-col gap-3">
    <header class="page-head">
      <div class="head-text">
        <h1 class="title">{{ t('settings.menu.terminal') }}</h1>
        <p class="desc">{{ t('settings.menu.terminalDesc') }}</p>
      </div>
    </header>

    <!-- corrupted 提示条：getTerminalConfig 返回 corrupted=true 时显示 -->
    <div
      v-if="corrupted"
      class="flex items-start gap-2 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-[12px] text-neutral-fg"
    >
      <AlertTriangle class="mt-px size-4 flex-shrink-0 text-warn" />
      <span>{{ t('settings.terminal.corruptedHint') }}</span>
    </div>

    <!-- 单卡片：终端配置表单 -->
    <GroupCard>
      <template #head>
        <div class="gc-head-text">
          <h3 class="gc-title">{{ t('settings.terminal.title') }}</h3>
        </div>
      </template>
      <div class="px-4 py-3">
        <div class="flex flex-col gap-4">
          <!-- shell -->
          <div class="flex flex-col gap-1.5">
            <Label class="text-[11px] text-neutral-dim" for="terminal-shell-input">
              {{ t('settings.terminal.shell') }}
            </Label>
            <Input
              id="terminal-shell-input"
              data-testid="terminal-shell-input"
              v-model="shell"
              type="text"
              :placeholder="t('settings.terminal.shellPlaceholder')"
              class="h-9 font-mono text-[12px]"
            />
          </div>

          <!-- shellArgs -->
          <div class="flex flex-col gap-1.5">
            <Label class="text-[11px] text-neutral-dim" for="terminal-shell-args-input">
              {{ t('settings.terminal.shellArgs') }}
            </Label>
            <Input
              id="terminal-shell-args-input"
              data-testid="terminal-shell-args-input"
              v-model="shellArgsInput"
              type="text"
              :placeholder="t('settings.terminal.shellArgsPlaceholder')"
              class="h-9 font-mono text-[12px]"
            />
          </div>

          <!-- fontSize -->
          <div class="flex flex-col gap-1.5">
            <Label class="text-[11px] text-neutral-dim" for="terminal-font-size-input">
              {{ t('settings.terminal.fontSize') }}
            </Label>
            <Input
              id="terminal-font-size-input"
              data-testid="terminal-font-size-input"
              v-model.number="fontSize"
              type="number"
              :min="6"
              :max="72"
              class="h-9 w-[120px] text-[12px]"
            />
          </div>

          <!-- fontFamily -->
          <div class="flex flex-col gap-1.5">
            <Label class="text-[11px] text-neutral-dim" for="terminal-font-family-input">
              {{ t('settings.terminal.fontFamily') }}
            </Label>
            <Input
              id="terminal-font-family-input"
              data-testid="terminal-font-family-input"
              v-model="fontFamily"
              type="text"
              :placeholder="t('settings.terminal.fontFamilyPlaceholder')"
              class="h-9 font-mono text-[12px]"
            />
          </div>

          <!-- scrollback -->
          <div class="flex flex-col gap-1.5">
            <Label class="text-[11px] text-neutral-dim" for="terminal-scrollback-input">
              {{ t('settings.terminal.scrollback') }}
            </Label>
            <Input
              id="terminal-scrollback-input"
              data-testid="terminal-scrollback-input"
              v-model.number="scrollback"
              type="number"
              :min="0"
              :max="100000"
              class="h-9 w-[160px] text-[12px]"
            />
          </div>

          <!-- cursorStyle -->
          <div class="flex flex-col gap-1.5">
            <Label class="text-[11px] text-neutral-dim" for="terminal-cursor-style-select">
              {{ t('settings.terminal.cursorStyle') }}
            </Label>
            <Select v-model="cursorStyle">
              <SelectTrigger id="terminal-cursor-style-select" data-testid="terminal-cursor-style-select" class="h-9 w-[160px] text-[12px]">
                <SelectValue :placeholder="t('settings.terminal.cursorStyle')" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="block" data-testid="terminal-cursor-block">{{ t('settings.terminal.cursorBlock') }}</SelectItem>
                <SelectItem value="underline" data-testid="terminal-cursor-underline">{{ t('settings.terminal.cursorUnderline') }}</SelectItem>
                <SelectItem value="bar" data-testid="terminal-cursor-bar">{{ t('settings.terminal.cursorBar') }}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <!-- bell -->
          <div class="flex items-center justify-between">
            <Label class="text-[11px] text-neutral-dim" for="terminal-bell-switch">
              {{ t('settings.terminal.bell') }}
            </Label>
            <Switch
              id="terminal-bell-switch"
              data-testid="terminal-bell-switch"
              :model-value="bell"
              @update:model-value="bell = $event === true"
            />
          </div>
        </div>

        <!-- 底部整体保存按钮 -->
        <div class="mt-4 flex justify-end">
          <Button
            data-testid="terminal-save"
            size="dense"
            :disabled="saving"
            @click="save"
          >
            {{ t('settings.terminal.save') }}
          </Button>
        </div>
      </div>
    </GroupCard>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle } from '@lucide/vue'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { GroupCard } from '@taiji/ui/features/settings'
import { config } from '@/api'
import { useToast } from '@/composables/useToast'
import type { TerminalConfig } from '@taiji/shared'

const { t } = useI18n()
const { info, error } = useToast()

/** 当前加载的配置（getTerminalConfig 返回）。corrupted=true 表示磁盘损坏已回退默认。 */
const corrupted = ref(false)
const shell = ref('')
const shellArgsInput = ref('')
// eslint-disable-next-line no-magic-numbers -- 加载前占位初值，loadConfig 后被真实配置覆盖
const fontSize = ref(14)
const fontFamily = ref('')
// eslint-disable-next-line no-magic-numbers -- 加载前占位初值，loadConfig 后被真实配置覆盖
const scrollback = ref(1000)
const cursorStyle = ref<TerminalConfig['cursorStyle']>('block')
const bell = ref(false)

/** 保存 in-flight 标志（RD-4#7）：整体保存为显式按钮触发，65s 窗口内防重复点击
 *  （并发覆盖同一 config + 双 toast）。 */
const saving = ref(false)

/** 从本地编辑态组装 TerminalConfig。shellArgs 由逗号分隔串转为 string[]。 */
function buildConfig(): TerminalConfig {
  return {
    version: 1,
    shell: shell.value,
    shellArgs: shellArgsInput.value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    fontSize: Number(fontSize.value),
    fontFamily: fontFamily.value,
    scrollback: Number(scrollback.value),
    cursorStyle: cursorStyle.value,
    bell: bell.value,
  }
}

/** 加载终端配置到本地编辑态。shellArgs 由 string[] 转为逗号分隔串便于编辑。 */
async function loadConfig(): Promise<void> {
  try {
    const res = await config.getTerminalConfig()
    corrupted.value = res.corrupted
    shell.value = res.config.shell
    shellArgsInput.value = res.config.shellArgs.join(',')
    fontSize.value = res.config.fontSize
    fontFamily.value = res.config.fontFamily
    scrollback.value = res.config.scrollback
    cursorStyle.value = res.config.cursorStyle
    bell.value = res.config.bell
  } catch (e) {
    error(e instanceof Error ? e.message : String(e))
  }
}

/** 整体保存终端配置。 */
async function save(): Promise<void> {
  if (saving.value) return
  saving.value = true
  try {
    await config.setTerminalConfig(buildConfig())
    info(t('settings.terminal.savedToast'))
  } catch (e) {
    error(e instanceof Error ? e.message : String(e))
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  void loadConfig()
})
</script>
