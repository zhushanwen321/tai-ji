<template>
  <!-- 已安装列表：按 layer 分两组（builtin 系统强制在前 / user 用户安装在后）。
       [w3b] demo 对照：ExtensionSection.vue「内置扩展（系统强制）」「已安装扩展（用户）」两卡
       （.gcard + 卡头 gc-title + tight body + .srow align-start 行）。scope 信息 = 卡头
       gc-title 旁 tag（i18n 现状两卡共用 installedBuiltinTitle，demo 括号后缀以「标题 + 徽标」
       组合表达，不新增 key）；卡头右 = aux 文案（.gcard .srow-desc 档）+ .bdg 计数徽标。
       空组整体隐藏（不渲染卡），全部为空时保留统一空态（demo .empty 语言）。 -->
  <div class="flex flex-col">
    <!-- builtin 组（系统强制） -->
    <GroupCard v-if="builtinExts.length" data-testid="extension-group-builtin">
      <template #head>
        <div class="gc-head-text flex items-center gap-2">
          <h3 class="gc-title">{{ t('settings.extension.installedBuiltinTitle') }}</h3>
          <span class="inline-flex h-[18px] items-center rounded-full bg-accent-soft px-[7px] text-[length:var(--text-2xs)] font-semibold text-accent">{{ t('settings.extension.scopeBuiltinPill') }}</span>
        </div>
      </template>
      <template #actions>
        <span class="text-[length:var(--text-sm)] text-[color:var(--neutral-fg-2)]">{{ t('settings.extension.builtinAux') }}</span>
        <span class="inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-surface px-[5px] font-mono text-[length:var(--text-3xs)] font-bold text-[color:var(--neutral-fg-2)]">{{ builtinExts.length }}</span>
      </template>
      <div class="px-[10px] pt-[4px] pb-[8px]">
        <div v-for="ext in builtinExts" :key="ext.name" class="flex min-h-[44px] items-start gap-[16px] border-t border-hairline px-[6px] py-[10px] first:border-t-0">
          <ExtensionDetail :ext="ext" />
          <ExtensionActions :ext="ext" />
        </div>
      </div>
    </GroupCard>

    <!-- user 组（用户安装） -->
    <GroupCard v-if="userExts.length" data-testid="extension-group-user">
      <template #head>
        <div class="gc-head-text flex items-center gap-2">
          <h3 class="gc-title">{{ t('settings.extension.installedBuiltinTitle') }}</h3>
          <span class="inline-flex h-[18px] items-center rounded-full bg-accent-soft px-[7px] text-[length:var(--text-2xs)] font-semibold text-accent">{{ t('settings.extension.scopeUserPill') }}</span>
        </div>
      </template>
      <template #actions>
        <span class="text-[length:var(--text-sm)] text-[color:var(--neutral-fg-2)]">{{ t('settings.extension.userAux') }}</span>
        <span class="inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-surface px-[5px] font-mono text-[length:var(--text-3xs)] font-bold text-[color:var(--neutral-fg-2)]">{{ userExts.length }}</span>
      </template>
      <div class="px-[10px] pt-[4px] pb-[8px]">
        <div v-for="ext in userExts" :key="ext.name" class="flex min-h-[44px] items-start gap-[16px] border-t border-hairline px-[6px] py-[10px] first:border-t-0">
          <ExtensionDetail :ext="ext" />
          <ExtensionActions :ext="ext" />
        </div>
      </div>
    </GroupCard>

    <!-- 全空态（两组都为空；demo .pg-set .empty 语言：64px 虚线圆 ring + 描述行） -->
    <div v-if="!extensions.length" class="flex flex-col items-center px-[16px] py-[40px] text-center">
      <div class="mb-[12px] grid size-16 place-items-center rounded-full border-[1.5px] border-dashed border-border-strong">
        <Blocks class="size-[26px] text-neutral-mid" />
      </div>
      <p class="text-[length:var(--text-sm)] text-neutral-mid">{{ t('settings.extension.noExtensions') }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Blocks } from '@lucide/vue'
import { GroupCard } from '@taiji/ui/features/settings'
import type { ExtensionItem } from '@taiji/core'
import ExtensionDetail from './ExtensionDetail.vue'
import ExtensionActions from './ExtensionActions.vue'

const props = defineProps<{ extensions: ExtensionItem[] }>()

const { t } = useI18n()

/** builtin 组（系统强制）：layer='builtin'（含 infrastructure / feature 两级） */
const builtinExts = computed(() => props.extensions.filter((e) => e.layer === 'builtin'))
/** user 组（用户安装）：layer 非 builtin（含旧数据 layer 缺失）一律归用户组，避免扩展静默消失 */
const userExts = computed(() => props.extensions.filter((e) => e.layer !== 'builtin'))
</script>
