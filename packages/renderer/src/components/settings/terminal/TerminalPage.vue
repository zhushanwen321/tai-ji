<!--
  Settings · Terminal 菜单页（Phase 6）。
  单卡片表单：shell / shellArgs / fontSize / fontFamily / scrollback / cursorStyle / bell。
  数据层：SettingsTransport seam 的 getTerminalConfig / setTerminalConfig（整体保存为显式按钮触发，不自动保存，
  失败走 toast error，成功走 toast info）。
  shellArgs 以逗号分隔输入，存储为 string[]。
  [w2] demo 对照（TerminalSection.vue + pages.css）：内容列限宽由壳层承担（terminal = 720）；
  字段 = .vrow 纵排（label text-2xs fg-2 在上 + 控件在下，gap 6px / py 10px / border-t hairline）；
  响铃 = .frow（min-h 44 / border-t hairline / label text-xs fw 600 fg）；保存 = btn solid h32
  右对齐 pt 12px。卡间距靠 GroupCard 相邻 margin（16px）。
-->
<template>
  <div data-testid="terminal-page" class="flex flex-col">
    <header class="page-head">
      <div class="head-text">
        <h1 class="title">{{ t('settings.menu.terminal') }}</h1>
        <p class="desc">{{ t('settings.menu.terminalDesc') }}</p>
      </div>
    </header>

    <!-- corrupted 提示条：getTerminalConfig 返回 corrupted=true 时显示（real 功能，demo 无对应物） -->
    <div
      v-if="corrupted"
      class="mb-[16px] flex items-start gap-2 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-[length:var(--text-xs)] text-neutral-fg"
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
      <div class="py-[12px] px-[16px]">
        <!-- shell -->
        <div class="flex flex-col gap-[6px] border-t border-hairline py-[10px] first:border-t-0">
          <Label class="text-[length:var(--text-2xs)] font-normal text-neutral-fg-2" for="terminal-shell-input">
            {{ t('settings.terminal.shell') }}
          </Label>
          <Input
            id="terminal-shell-input"
            data-testid="terminal-shell-input"
            v-model="shell"
            type="text"
            :placeholder="t('settings.terminal.shellPlaceholder')"
            class="font-mono"
          />
        </div>

        <!-- shellArgs -->
        <div class="flex flex-col gap-[6px] border-t border-hairline py-[10px] first:border-t-0">
          <Label class="text-[length:var(--text-2xs)] font-normal text-neutral-fg-2" for="terminal-shell-args-input">
            {{ t('settings.terminal.shellArgs') }}
          </Label>
          <Input
            id="terminal-shell-args-input"
            data-testid="terminal-shell-args-input"
            v-model="shellArgsInput"
            type="text"
            :placeholder="t('settings.terminal.shellArgsPlaceholder')"
            class="font-mono"
          />
        </div>

        <!-- fontSize -->
        <div class="flex flex-col gap-[6px] border-t border-hairline py-[10px] first:border-t-0">
          <Label class="text-[length:var(--text-2xs)] font-normal text-neutral-fg-2" for="terminal-font-size-input">
            {{ t('settings.terminal.fontSize') }}
          </Label>
          <Input
            id="terminal-font-size-input"
            data-testid="terminal-font-size-input"
            v-model.number="fontSize"
            type="number"
            :min="6"
            :max="72"
            class="w-[120px]"
          />
        </div>

        <!-- fontFamily -->
        <div class="flex flex-col gap-[6px] border-t border-hairline py-[10px] first:border-t-0">
          <Label class="text-[length:var(--text-2xs)] font-normal text-neutral-fg-2" for="terminal-font-family-input">
            {{ t('settings.terminal.fontFamily') }}
          </Label>
          <Input
            id="terminal-font-family-input"
            data-testid="terminal-font-family-input"
            v-model="fontFamily"
            type="text"
            :placeholder="t('settings.terminal.fontFamilyPlaceholder')"
            class="font-mono"
          />
        </div>

        <!-- scrollback -->
        <div class="flex flex-col gap-[6px] border-t border-hairline py-[10px] first:border-t-0">
          <Label class="text-[length:var(--text-2xs)] font-normal text-neutral-fg-2" for="terminal-scrollback-input">
            {{ t('settings.terminal.scrollback') }}
          </Label>
          <Input
            id="terminal-scrollback-input"
            data-testid="terminal-scrollback-input"
            v-model.number="scrollback"
            type="number"
            :min="0"
            :max="100000"
            class="w-[160px]"
          />
        </div>

        <!-- cursorStyle -->
        <div class="flex flex-col gap-[6px] border-t border-hairline py-[10px] first:border-t-0">
          <Label class="text-[length:var(--text-2xs)] font-normal text-neutral-fg-2" for="terminal-cursor-style-select">
            {{ t('settings.terminal.cursorStyle') }}
          </Label>
          <Select v-model="cursorStyle">
            <SelectTrigger id="terminal-cursor-style-select" data-testid="terminal-cursor-style-select" class="w-[160px]">
              <SelectValue :placeholder="t('settings.terminal.cursorStyle')" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="block" data-testid="terminal-cursor-block">{{ t('settings.terminal.cursorBlock') }}</SelectItem>
              <SelectItem value="underline" data-testid="terminal-cursor-underline">{{ t('settings.terminal.cursorUnderline') }}</SelectItem>
              <SelectItem value="bar" data-testid="terminal-cursor-bar">{{ t('settings.terminal.cursorBar') }}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <!-- bell（demo .frow：min-h 44 / border-t hairline / label text-xs fw 600 fg） -->
        <div class="flex min-h-[44px] items-center justify-between gap-4 border-t border-hairline py-[8px]">
          <Label class="text-neutral-fg" for="terminal-bell-switch">
            {{ t('settings.terminal.bell') }}
          </Label>
          <Switch
            id="terminal-bell-switch"
            data-testid="terminal-bell-switch"
            :model-value="bell"
            @update:model-value="bell = $event === true"
          />
        </div>

        <!-- 底部整体保存按钮（demo：右对齐 + padding-top 12px） -->
        <div class="flex justify-end pt-[12px]">
          <Button
            data-testid="terminal-save"
            size="dense"
            class="h-[32px] px-[12px] text-[length:var(--text-sm)]"
            :disabled="saving"
            @click="saveConfig.run()"
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
import { getSettingsTransport } from '@taiji/core'
import { useToast } from '@/composables/useToast'
import { createExplicitSave } from '@/composables/features/settings/setting-field'
import type { TerminalConfig } from '@taiji/shared'

const { t } = useI18n()
const { error } = useToast()

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

// 保存动作（setting-field module · createExplicitSave）：整体保存为显式按钮触发，唯一 saving
// 窗口（RD-4#7，65s 窗口内防重复点击并发覆盖 + 双 toast）。失败 toast = e.message 原文 error。
const saveConfig = createExplicitSave({
  run: () => getSettingsTransport().setTerminalConfig(buildConfig()).then(() => undefined),
  savedToastKey: 'settings.terminal.savedToast',
})
const saving = saveConfig.saving

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
    const res = await getSettingsTransport().getTerminalConfig()
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

onMounted(() => {
  void loadConfig()
})
</script>
