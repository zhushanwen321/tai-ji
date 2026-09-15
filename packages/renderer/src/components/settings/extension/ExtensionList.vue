<template>
  <!-- 已安装列表：按 layer 分两组（builtin 系统强制在前 / user 用户安装在后）。
       组头对齐 v6 demo GroupCard：标题 + scope pill + count + aux。
       空组整体隐藏（不渲染组头），全部为空时保留统一空态。 -->
  <section>
    <!-- builtin 组（系统强制） -->
    <div v-if="builtinExts.length" data-testid="extension-group-builtin">
      <div class="mb-2 flex items-center gap-2">
        <h3 class="text-[12px] font-medium text-neutral-fg">{{ t('settings.extension.installedBuiltinTitle') }}</h3>
        <span class="inline-flex items-center gap-1 rounded-full bg-surface px-2 py-0.5 text-[10px] font-medium text-neutral-mid">
          <Lock :size="11" />
          {{ t('settings.extension.scopeBuiltinPill') }}
        </span>
        <span class="rounded-sm bg-surface px-1.5 py-0.5 text-[10px] text-neutral-dim">{{ builtinExts.length }}</span>
        <span class="text-[10px] text-neutral-mid">{{ t('settings.extension.builtinAux') }}</span>
      </div>

      <div v-for="ext in builtinExts" :key="ext.name" class="flex items-center gap-3 rounded-card bg-card px-3 py-2.5">
        <ExtensionDetail :ext="ext" />
        <ExtensionActions :ext="ext" />
      </div>
    </div>

    <!-- user 组（用户安装） -->
    <div v-if="userExts.length" data-testid="extension-group-user">
      <div class="mb-2 flex items-center gap-2">
        <h3 class="text-[12px] font-medium text-neutral-fg">{{ t('settings.extension.installedBuiltinTitle') }}</h3>
        <span class="inline-flex items-center gap-1 rounded-full bg-surface px-2 py-0.5 text-[10px] font-medium text-neutral-mid">
          {{ t('settings.extension.scopeUserPill') }}
        </span>
        <span class="rounded-sm bg-surface px-1.5 py-0.5 text-[10px] text-neutral-dim">{{ userExts.length }}</span>
        <span class="text-[10px] text-neutral-mid">{{ t('settings.extension.userAux') }}</span>
      </div>

      <div v-for="ext in userExts" :key="ext.name" class="flex items-center gap-3 rounded-card bg-card px-3 py-2.5">
        <ExtensionDetail :ext="ext" />
        <ExtensionActions :ext="ext" />
      </div>
    </div>

    <!-- 全空态（两组都为空） -->
    <div v-if="!extensions.length" class="py-8 text-center text-[12px] text-neutral-mid">{{ t('settings.extension.noExtensions') }}</div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Lock } from '@lucide/vue'
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
