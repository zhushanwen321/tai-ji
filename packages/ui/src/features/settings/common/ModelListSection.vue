<template>
  <!--
    ModelListSection —— ProviderEditModal 右侧「模型清单」子组件。
    从 ProviderEditModal.vue 提取，保持主模板 ≤400 行。
    包含：标题栏 + 手动添加表单 + 模型列表表格（输入类型 / 上下文 / 思考 / 删除）。
    状态与编排全在父组件 useProviderEdit composable，经 provide('modelListDeps') 注入。
  -->
  <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
    <div class="flex items-center justify-between border-b border-border px-5 py-3">
      <span class="text-[13px] font-semibold text-neutral-fg">{{ t(props.titleKey) }}</span>
      <Button variant="ghost" class="h-auto p-0 text-[11px] text-accent hover:bg-transparent hover:underline" @click="$emit('update:showAddModel', !showAddModel)">
        {{ showAddModel ? t('settings.providerEdit.collapse') : t('settings.providerEdit.manualAdd') }}
      </Button>
    </div>

    <!-- 手动添加模型表单（两行：模型名 + 输入类型 / 上下文 + 思考 + 添加）。 -->
    <div v-if="showAddModel" class="border-b border-border bg-surface px-5 py-3">
      <!-- 第 1 行：模型名称（占满）+ 输入类型分段 -->
      <div class="flex items-end gap-3">
        <div class="min-w-0 flex-1">
          <Label class="mb-1 block text-[10px] text-neutral-mid">{{ t('settings.providerEdit.modelNameLabel') }}</Label>
          <Input v-model="deps.newModel.name" :placeholder="t('settings.providerEdit.modelNamePlaceholder')" class="h-8 text-[12px]" />
        </div>
        <div>
          <Label class="mb-1 block text-[10px] text-neutral-mid">{{ t('settings.providerEdit.inputTypeLabel') }}</Label>
          <div class="flex h-8 gap-0.5 rounded-md border border-border bg-surface-2 p-0.5">
            <Button
              variant="ghost"
              class="h-full gap-1 rounded-sm px-2 text-[10px] hover:bg-transparent [&_svg]:size-3"
              :class="deps.newModel.inputTypes.includes('text') ? 'bg-accent-soft text-accent' : 'text-neutral-mid hover:text-neutral-fg'"
              @click="deps.toggleNewInput('text')"
            ><FileText /> {{ t('settings.providerEdit.inputText') }}</Button>
            <Button
              variant="ghost"
              class="h-full gap-1 rounded-sm px-2 text-[10px] hover:bg-transparent [&_svg]:size-3"
              :class="deps.newModel.inputTypes.includes('image') ? 'bg-accent-soft text-accent' : 'text-neutral-mid hover:text-neutral-fg'"
              @click="deps.toggleNewInput('image')"
            ><ImageIcon /> {{ t('settings.providerEdit.inputImage') }}</Button>
          </div>
        </div>
      </div>
      <!-- 第 2 行：上下文 + 思考 + 添加 -->
      <div class="mt-3 flex items-end gap-3">
        <div>
          <Label class="mb-1 block text-[10px] text-neutral-mid">{{ t('settings.providerEdit.contextLabel') }}</Label>
          <Select v-model="deps.newModel.contextWindow">
            <SelectTrigger class="h-8 w-[110px] px-2 text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="o in ctxOptions" :key="o.value" :value="o.value">{{ o.label }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label class="mb-1 block text-[10px] text-neutral-mid">{{ t('settings.providerEdit.thinkingLabel') }}</Label>
          <Select v-model="deps.newModel.thinking">
            <SelectTrigger class="h-8 w-[130px] px-1.5 py-0 text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="s in thinkingStrategies" :key="s.key" :value="s.key">{{ t(s.labelKey) }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <!-- D4 reasoning 开关：默认按思考策略自动推导（非 all-levels 自动 true），用户可显式关。
             显式 boolean 落盘——reasoning 缺失会让 pi 把思考档全钳回 off（事故 B）。 -->
        <div>
          <Label class="mb-1 block text-[10px] text-neutral-mid">{{ t('settings.providerEdit.reasoningLabel') }}</Label>
          <Switch
            :model-value="deps.newModel.reasoning"
            class="mt-[9px]"
            :aria-label="t('settings.providerEdit.reasoningLabel')"
            :title="t('settings.providerEdit.reasoningTitle')"
            @update:model-value="deps.newModel.reasoning = $event as boolean"
          />
        </div>
        <Button class="h-8 shrink-0 px-3 text-[12px]" @click="$emit('addModel')">{{ t('settings.providerEdit.addBtn') }}</Button>
      </div>
    </div>

    <!-- 模型列表 -->
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div v-if="!localModels.length" class="py-8 text-center text-[12px] text-neutral-mid">{{ t('settings.providerEdit.noModels') }}</div>

      <!-- 表头。非名称列统一 text-center，与下方行 value 单元格对齐方式一致。 -->
      <div v-if="localModels.length" class="flex items-center border-b border-border bg-surface px-5 py-2 text-center text-[10px] text-neutral-dim">
        <span class="flex-1 text-left">{{ t('settings.providerEdit.modelLabel') }}</span>
        <span class="w-14">{{ t('settings.providerEdit.headInput') }}</span>
        <span class="w-[80px]">{{ t('settings.providerEdit.headContext') }}</span>
        <span class="w-24">{{ t('settings.providerEdit.headThinking') }}</span>
        <span class="w-8" />
      </div>

      <div
        v-for="(m, i) in localModels"
        :key="m.id"
        class="border-b border-border"
      >
        <!-- 横向行（原列内容）-->
        <div class="flex items-center px-5 py-2 text-[12px]">
          <span class="flex flex-1 min-w-0 items-center gap-1.5">
            <span class="truncate font-mono text-neutral-fg">{{ m.id }}</span>
            <!-- 来源徽章（B-2：catalog 复用时标「自定义」；custom 不传不渲染） -->
            <span
              v-if="props.badgeText"
              data-testid="model-badge-custom"
              class="shrink-0 rounded-sm bg-surface-hover px-1.5 py-0.5 text-[9px] font-medium text-neutral-mid"
            >{{ props.badgeText }}</span>
          </span>
          <!-- 输入类型 icon 按钮 -->
          <div class="flex w-14 items-center justify-center gap-1">
            <Button
              variant="ghost"
              class="h-auto shrink-0 rounded-sm border p-1 hover:bg-transparent [&_svg]:size-3.5"
              :class="m.input?.includes('text') ? 'border-accent bg-accent-soft text-accent' : 'border-border text-neutral-dim opacity-60 hover:opacity-100'"
              :title="t('settings.providerEdit.textInputTitle')"
              @click.stop="deps.toggleInput(m, 'text')"
            ><FileText /></Button>
            <Button
              variant="ghost"
              class="h-auto shrink-0 rounded-sm border p-1 hover:bg-transparent [&_svg]:size-3.5"
              :class="m.input?.includes('image') ? 'border-accent bg-accent-soft text-accent' : 'border-border text-neutral-dim opacity-60 hover:opacity-100'"
              :title="t('settings.providerEdit.imageInputTitle')"
              @click.stop="deps.toggleInput(m, 'image')"
            ><ImageIcon /></Button>
          </div>
          <!-- 上下文（弹出 select） -->
          <div class="flex w-[80px] justify-center">
            <Select
              :model-value="m.contextWindow"
              @update:model-value="deps.updateCtx(m, $event as number)"
            >
              <SelectTrigger class="h-7 w-[72px] px-1.5 py-0 text-[11px]">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="o in ctxOptions" :key="o.value" :value="o.value">{{ o.label }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <!-- 思考策略（弹出 select） -->
          <div class="flex w-24 justify-center">
            <Select
              :model-value="deps.getStrategyFromMap(m.thinkingLevelMap)"
              @update:model-value="deps.pickStrategy(m, $event as ThinkingStrategy)"
            >
              <SelectTrigger class="h-7 w-[88px] px-1.5 py-0 text-[11px]">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="s in thinkingStrategies" :key="s.key" :value="s.key">{{ t(s.labelKey) }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <!-- compat 编辑器展开按钮 -->
          <Button
            variant="ghost"
            class="size-5 w-8 shrink-0 rounded-sm p-0 text-neutral-dim hover:bg-transparent hover:text-accent [&_svg]:size-3"
            :class="isCompatExpanded(m.id) ? 'text-accent' : ''"
            :aria-label="t('settings.compat.title')"
            :title="t('settings.compat.title')"
            @click.stop="deps.toggleCompatExpand(m.id)"
          >
            <Settings2 />
          </Button>
          <!-- 移除 -->
          <Button
            variant="ghost"
            class="size-5 w-8 shrink-0 rounded-sm p-0 text-neutral-dim hover:bg-transparent hover:text-danger [&_svg]:size-3"
            :aria-label="t('settings.providerEdit.removeModel')"
            @click.stop="deps.removeModel(i)"
          >
            <X />
          </Button>
        </div>
        <!-- compat 编辑区（展开时显示）。v-model 绑 m.compat：localModels 经 provide/inject
             注入，是同一 reactive 引用，改 m.compat 反应回 useProviderEdit，save 时透传。
             用 :model-value + @update:model-value 显式写法（与同模板的 inject 变更模式一致）。 -->
        <div v-if="isCompatExpanded(m.id)" class="border-t border-border bg-surface-2 px-5">
          <CompatEditor
            :api="resolveApi(m.api)"
            :model-value="m.compat"
            @update:model-value="m.compat = $event"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Button, Input, Label, Select, SelectTrigger, SelectValue, SelectContent, SelectItem, Switch } from '@taiji/ui'
import { inject, unref, computed, type Ref, type ComputedRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { FileText, ImageIcon, X, Settings2 } from '@lucide/vue'

import CompatEditor from '../compat/CompatEditor.vue'
import {
  CONTEXT_OPTIONS,
  THINKING_STRATEGIES,
  type ThinkingStrategy,
  type LocalModel,
} from '@taiji/core'

/**
 * 设计：showAddModel 受控 + update:showAddModel emit；
 * newModel / localModels / CRUD 方法经 provide('modelListDeps') 注入（父组件 useProviderEdit 单例）。
 * 用 inject 而非 prop 传 newModel：v-model 改 newModel.name 会触发 vue/no-mutating-props lint；
 * inject 拿到的是同一 reactive 引用，运行时改同一对象，lint 不报。
 *
 * B-2 混合列表复用：catalog provider 复用本组件编辑 override 条目——titleKey 换区标题
 * （「自定义模型」）、badgeText 在每行 id 旁渲染来源徽章（「自定义」），custom provider
 * 不传时行为与原先完全一致。
 */
const props = withDefaults(defineProps<{
  showAddModel: boolean
  /** 区标题 i18n key（B-2：catalog 复用时传「自定义模型」；缺省 = 模型清单） */
  titleKey?: string
  /** 行级来源徽章文案（B-2：catalog 复用时传「自定义」；缺省不渲染徽章） */
  badgeText?: string
}>(), {
  titleKey: 'settings.providerEdit.modelList',
  badgeText: '',
})

defineEmits<{
  'update:showAddModel': [value: boolean]
  addModel: []
}>()

interface ModelListDeps {
  newModel: {
    name: string
    inputTypes: Array<'text' | 'image'>
    contextWindow: number | undefined
    thinking: string | undefined
    /** 思考能力开关（D4：出厂显式 boolean；非 all-levels 策略自动 true，用户可显式关） */
    reasoning: boolean
  }
  localModels: Ref<LocalModel[]>
  toggleNewInput: (type: 'text' | 'image') => void
  toggleInput: (m: LocalModel, type: 'text' | 'image') => void
  updateCtx: (m: LocalModel, value: number) => void
  pickStrategy: (m: LocalModel, strategy: ThinkingStrategy) => void
  getStrategyFromMap: (map?: Record<string, string | null>) => ThinkingStrategy
  removeModel: (index: number) => void
  /** 展开了 compat 编辑器的 model id 集合（reactive Set，直接 mutate） */
  expandedCompat: Set<string>
  /** 切换某 model 的 compat 编辑器展开 */
  toggleCompatExpand: (modelId: string) => void
  /** provider 级 api（model 级 api 缺失时的回退，用于 compat 字段集判断） */
  providerApi: ComputedRef<string>
}

const deps = inject<ModelListDeps>('modelListDeps')!

const { t } = useI18n()

// 模板常量（composable 导出的纯数据）
const ctxOptions = CONTEXT_OPTIONS
const thinkingStrategies = THINKING_STRATEGIES

// deps.localModels / deps.expandedCompat / deps.providerApi 是 ref/computed（useProviderEdit return
// 的状态或 form.api 的 computed）。Vue 模板对 setup 顶层 ref 自动解包，但对 inject 对象的嵌套
// ref 不解包——模板里 deps.localModels.length 拿到的是 ref 本体（.length=undefined，导致「暂无
// 模型」永远显示）。用 computed 显式解包，模板用 localModels / isCompatExpanded / providerApi 读。
const localModels = computed(() => unref(deps.localModels))
const providerApi = computed(() => unref(deps.providerApi) as string | undefined)
const isCompatExpanded = (modelId: string): boolean => unref(deps.expandedCompat).has(modelId)
/** model 级 api 优先，缺失回退 provider 级 api（compat 字段集 + 预设按钮按此过滤） */
const resolveApi = (modelApi?: string): string | undefined => modelApi || providerApi.value
</script>
