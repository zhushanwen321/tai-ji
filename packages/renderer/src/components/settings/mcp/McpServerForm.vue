<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="max-w-[560px]" data-testid="mcp-form-dialog">
      <DialogHeader>
        <DialogTitle>{{ editing ? t('settings.mcp.editServer') : t('settings.mcp.addServer') }}</DialogTitle>
        <DialogDescription>{{ t('settings.mcp.formDesc') }}</DialogDescription>
      </DialogHeader>

      <!-- 表单/代码双 tab（D7）：切换保留内容；表单 → 代码自动序列化为包装形态；
           代码 → 表单解析成功才切换，失败留代码模式并显示解析错误 -->
      <div class="flex gap-1" role="tablist" data-testid="mcp-form-tabs">
        <Button
          v-for="tab in (['form', 'code'] as const)"
          :key="tab"
          type="button"
          role="tab"
          variant="ghost"
          class="h-7 rounded-[var(--radius-sm)] px-3 text-[12px]"
          :class="activeTab === tab ? 'bg-surface text-fg' : 'text-neutral-mid hover:text-fg'"
          :aria-selected="activeTab === tab"
          :data-testid="`mcp-form-tab-${tab}`"
          @click="tab === 'code' ? switchToCode() : switchToForm()"
        >
          {{ tab === 'form' ? t('settings.mcp.tabForm') : t('settings.mcp.tabCode') }}
        </Button>
      </div>

      <!-- 表单模式（D7 字段映射表定死） -->
      <div v-if="activeTab === 'form'" class="flex flex-col gap-3" data-testid="mcp-form-fields">
        <div class="flex flex-col gap-1">
          <Label class="text-[12px] text-neutral-fg" for="mcp-form-name">{{ t('settings.mcp.fieldName') }}</Label>
          <Input
            id="mcp-form-name"
            v-model="name"
            data-testid="mcp-form-name"
            :placeholder="t('settings.mcp.fieldNamePlaceholder')"
            :disabled="!!editing"
            class="h-8 text-[12px]"
          />
          <p v-if="fieldErrors.name" class="text-[11px] text-danger" data-testid="mcp-form-name-error">{{ fieldErrors.name }}</p>
          <p v-else-if="editing" class="text-[10px] text-neutral-mid">{{ t('settings.mcp.nameLockedHint') }}</p>
        </div>

        <div class="flex flex-col gap-1">
          <Label class="text-[12px] text-neutral-fg">{{ t('settings.mcp.fieldTransport') }}</Label>
          <!-- 编辑态可切换（设计 D4/D7 编辑流切换路径；另一类型字段清空 =
               onTransportChange 表单级 + store buildFormConfig 条目键级两级保证） -->
          <Select
            :model-value="transport"
            @update:model-value="onTransportChange"
          >
            <SelectTrigger class="h-8 w-full text-[12px]" data-testid="mcp-form-transport">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stdio">{{ t('settings.mcp.transportStdioOption') }}</SelectItem>
              <SelectItem value="http">{{ t('settings.mcp.transportHttpOption') }}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <!-- stdio 字段（命令 / 参数 / 环境变量 / 工作目录） -->
        <template v-if="transport === 'stdio'">
          <div class="flex flex-col gap-1">
            <Label class="text-[12px] text-neutral-fg" for="mcp-form-command">{{ t('settings.mcp.fieldCommand') }}</Label>
            <Input
              id="mcp-form-command"
              v-model="command"
              data-testid="mcp-form-command"
              :placeholder="t('settings.mcp.fieldCommandPlaceholder')"
              class="h-8 font-mono text-[12px]"
            />
            <p v-if="fieldErrors.command" class="text-[11px] text-danger" data-testid="mcp-form-command-error">{{ fieldErrors.command }}</p>
            <p v-else class="text-[10px] text-neutral-mid">{{ t('settings.mcp.fieldCommandHint') }}</p>
          </div>
          <div class="flex flex-col gap-1">
            <Label class="text-[12px] text-neutral-fg" for="mcp-form-args">{{ t('settings.mcp.fieldArgs') }}</Label>
            <Textarea
              id="mcp-form-args"
              v-model="argsText"
              data-testid="mcp-form-args"
              :placeholder="t('settings.mcp.fieldArgsPlaceholder')"
              class="min-h-[56px] font-mono text-[12px]"
            />
          </div>
          <div class="flex flex-col gap-1">
            <Label class="text-[12px] text-neutral-fg" for="mcp-form-env">{{ t('settings.mcp.fieldEnv') }}</Label>
            <Textarea
              id="mcp-form-env"
              v-model="envText"
              data-testid="mcp-form-env"
              :placeholder="t('settings.mcp.fieldEnvPlaceholder')"
              class="min-h-[56px] font-mono text-[12px]"
            />
            <p v-if="fieldErrors.env" class="text-[11px] text-danger" data-testid="mcp-form-env-error">{{ fieldErrors.env }}</p>
          </div>
          <div class="flex flex-col gap-1">
            <Label class="text-[12px] text-neutral-fg" for="mcp-form-cwd">{{ t('settings.mcp.fieldCwd') }}</Label>
            <Input
              id="mcp-form-cwd"
              v-model="cwd"
              data-testid="mcp-form-cwd"
              :placeholder="t('settings.mcp.fieldCwdPlaceholder')"
              class="h-8 font-mono text-[12px]"
            />
          </div>
        </template>

        <!-- http 字段（URL / 请求头） -->
        <template v-else>
          <div class="flex flex-col gap-1">
            <Label class="text-[12px] text-neutral-fg" for="mcp-form-url">{{ t('settings.mcp.fieldUrl') }}</Label>
            <Input
              id="mcp-form-url"
              v-model="url"
              data-testid="mcp-form-url"
              :placeholder="t('settings.mcp.fieldUrlPlaceholder')"
              class="h-8 font-mono text-[12px]"
            />
            <p v-if="fieldErrors.url" class="text-[11px] text-danger" data-testid="mcp-form-url-error">{{ fieldErrors.url }}</p>
          </div>
          <div class="flex flex-col gap-1">
            <Label class="text-[12px] text-neutral-fg" for="mcp-form-headers">{{ t('settings.mcp.fieldHeaders') }}</Label>
            <Textarea
              id="mcp-form-headers"
              v-model="headersText"
              data-testid="mcp-form-headers"
              :placeholder="t('settings.mcp.fieldHeadersPlaceholder')"
              class="min-h-[56px] font-mono text-[12px]"
            />
            <p v-if="fieldErrors.headers" class="text-[11px] text-danger" data-testid="mcp-form-headers-error">{{ fieldErrors.headers }}</p>
          </div>
        </template>

        <div class="flex flex-col gap-1">
          <Label class="text-[12px] text-neutral-fg" for="mcp-form-description">{{ t('settings.mcp.fieldDescription') }}</Label>
          <Input
            id="mcp-form-description"
            v-model="description"
            data-testid="mcp-form-description"
            :placeholder="t('settings.mcp.fieldDescriptionPlaceholder')"
            class="h-8 text-[12px]"
          />
        </div>

        <div class="flex flex-col gap-1">
          <Label class="text-[12px] text-neutral-fg">{{ t('settings.mcp.fieldExposure') }}</Label>
          <Select :model-value="exposure" @update:model-value="onExposureChange">
            <SelectTrigger class="h-8 w-full text-[12px]" data-testid="mcp-form-exposure">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="codemode">{{ t('settings.mcp.exposureCodemode') }}</SelectItem>
              <SelectItem value="deferred">{{ t('settings.mcp.exposureDeferred') }}</SelectItem>
              <SelectItem value="direct">{{ t('settings.mcp.exposureDirect') }}</SelectItem>
              <SelectItem value="hidden">{{ t('settings.mcp.exposureHidden') }}</SelectItem>
            </SelectContent>
          </Select>
          <p class="text-[10px] leading-relaxed text-neutral-mid" data-testid="mcp-form-exposure-hint">{{ exposureHint }}</p>
        </div>

        <!-- runtime 保存校验失败的内联显示（ok:false error 透传——校验权威在 runtime，D4） -->
        <p v-if="serverError" class="text-[11px] text-danger" data-testid="mcp-form-server-error">{{ serverError }}</p>
      </div>

      <!-- 代码模式：textarea + 粘贴解析（单条目形态；表单外键原样保留写入） -->
      <div v-else class="flex flex-col gap-2" data-testid="mcp-form-code">
        <p class="text-[10px] leading-relaxed text-neutral-mid">{{ t('settings.mcp.codeHint') }}</p>
        <Textarea
          v-model="codeText"
          data-testid="mcp-form-code-text"
          :placeholder="t('settings.mcp.codePlaceholder')"
          class="min-h-[220px] font-mono text-[12px]"
        />
        <p v-if="codeError" class="text-[11px] text-danger" data-testid="mcp-form-code-error">{{ codeError }}</p>
        <p v-if="serverError" class="text-[11px] text-danger" data-testid="mcp-form-server-error-code">{{ serverError }}</p>
      </div>

      <div class="flex justify-end gap-2 pt-2">
        <Button variant="ghost" data-testid="mcp-form-cancel" @click="emit('update:open', false)">
          {{ t('settings.mcp.cancel') }}
        </Button>
        <Button data-testid="mcp-form-save" @click="submit">{{ t('settings.mcp.save') }}</Button>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
/**
 * MCP 服务器添加/编辑弹层（pi-mcp-management U3，D7 表单字段映射表定死）。
 *
 * 双 tab：表单 / 代码。切换保留内容——表单 → 代码自动序列化为包装形态（名称随内容可见，
 * 与手工粘贴形态统一）；代码 → 表单解析成功才切换，失败留在代码模式显示解析错误。
 * 校验链路（与代码模式共用，D7「解析后走与表单完全相同的校验与保存链路」）：
 * 名称字符集 / 必填 / command+url 互斥（D4 有意收紧项）/ 重名（含 -/_ 归并同名，D4）/
 * 添加流裸形态拦截（名称是聚合唯一键，包装形态提供）/ 编辑流包装键名改名拦截（改名 =
 * 删除后重建）。`type` 三值闭集与形态一致性校验归 runtime（u1 复刻校验权威），本组件把
 * ok:false 的 error 经 serverError 内联显示，不复刻闭集（防双源漂移）。
 */
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useMcpServerForm } from '@/composables/useMcpServerForm'
import type { McpServerEntry, McpServerEntryValue } from '@taiji/shared'

const props = defineProps<{
  open: boolean
  /** 编辑条目（null = 添加态） */
  editing: McpServerEntry | null
  /** 既有名称清单（客户端重名拦截用；编辑态内部排除自身） */
  existingNames: string[]
  /** runtime 保存校验失败信息（mcp.add/update ok:false 的 error 透传） */
  serverError: string | null
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  submit: [payload: { name: string; entry: McpServerEntryValue }]
}>()

const { t } = useI18n()

const {
  name,
  transport,
  command,
  argsText,
  envText,
  cwd,
  url,
  headersText,
  description,
  exposure,
  exposureHint,
  clearTransportFields,
  fillFormFromEntry,
  onTransportChange,
  onExposureChange,
} = useMcpServerForm()

type TabKind = 'form' | 'code'

const activeTab = ref<TabKind>('form')
const codeText = ref('')
const codeError = ref('')
const fieldErrors = ref<Record<string, string>>({})

watch(() => props.open, (open) => {
  if (!open) return
  activeTab.value = 'form'
  codeError.value = ''
  fieldErrors.value = {}
  if (props.editing) {
    name.value = props.editing.name
    fillFormFromEntry(props.editing.value)
    // 编辑初始即包装形态（外键在 textarea 中可见可改，D7 编辑写回契约）
    codeText.value = serializeToCode(props.editing.name)
  } else {
    name.value = ''
    transport.value = 'stdio'
    clearTransportFields()
    description.value = ''
    exposure.value = 'codemode'
    codeText.value = ''
  }
})

// ── 表单 ↔ 代码互转 ──

/** 行式 KEY=VALUE 文本 → Record；格式错行行号收集（1 起） */
function parseKvText(text: string): { pairs: Record<string, string>; badLines: number[] } {
  const pairs: Record<string, string> = {}
  const badLines: number[] = []
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim()
    if (!line) return
    const eq = line.indexOf('=')
    if (eq <= 0) {
      badLines.push(i + 1)
      return
    }
    pairs[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  })
  return { pairs, badLines }
}

function linesToList(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
}

/** 表单当前值 → 条目对象（只含有值键：清空 = 删键，D7 合并空值语义；type 键不落，D7 映射表） */
function formToEntry(): { entry: McpServerEntryValue; envBadLines: number[]; headersBadLines: number[] } {
  const entry: McpServerEntryValue = {}
  const desc = description.value.trim()
  if (desc) entry.description = desc
  entry.exposure = exposure.value
  if (transport.value === 'stdio') {
    const cmd = command.value.trim()
    if (cmd) entry.command = cmd
    const args = linesToList(argsText.value)
    if (args.length > 0) entry.args = args
    const env = parseKvText(envText.value)
    if (Object.keys(env.pairs).length > 0) entry.env = env.pairs
    const dir = cwd.value.trim()
    if (dir) entry.cwd = dir
    return { entry, envBadLines: env.badLines, headersBadLines: [] }
  }
  const u = url.value.trim()
  if (u) entry.url = u
  const headers = parseKvText(headersText.value)
  if (Object.keys(headers.pairs).length > 0) entry.headers = headers.pairs
  return { entry, envBadLines: [], headersBadLines: headers.badLines }
}

/** 代码模式 JSON 缩进（与粘贴惯例一致的 2 空格） */
const JSON_DISPLAY_INDENT = 2

/** 序列化为包装形态（表单 → 代码的目标形态：名称随内容一并可见，D7） */
function serializeToCode(entryName: string): string {
  const { entry } = formToEntry()
  return JSON.stringify({ [entryName]: entry }, null, JSON_DISPLAY_INDENT)
}

function switchToCode(): void {
  codeText.value = serializeToCode(name.value.trim())
  codeError.value = ''
  activeTab.value = 'code'
}

function switchToForm(): void {
  const parsed = parseCodeText()
  if (!parsed.ok) {
    codeError.value = parsed.error
    return
  }
  // 解析成功才切换（失败留在代码模式显示解析错误）；内容经字段填充保留
  if (parsed.name !== null) name.value = parsed.name
  fillFormFromEntry(parsed.entry)
  codeError.value = ''
  activeTab.value = 'form'
}

type ParseResult =
  | { ok: true; name: string | null; entry: McpServerEntryValue }
  | { ok: false; error: string }

/**
 * 代码模式解析（单条目形态）：
 * - 包装形态 { "名称": { ... } }：名称自动取键名；编辑流键名 ≠ 被编辑名 → 拦截（改名 =
 *   删除后重建，D7 编辑态名称键语义；在切换/保存两个入口同样拦截，不静默丢弃改名意图）
 * - 裸条目值对象（含 command/url/type 顶层键）：编辑流可用（名称沿用被编辑条目名）；添加流
 *   无键名可取 → 提示包装形态（解析层照常接受输入，拒绝发生在保存校验链路，D7 添加态条款）
 */
function parseCodeText(): ParseResult {
  const text = codeText.value.trim()
  if (!text) return { ok: false, error: t('settings.mcp.errCodeEmpty') }
  let obj: unknown
  try {
    obj = JSON.parse(text)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: t('settings.mcp.errCodeJson', { message: msg }) }
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { ok: false, error: t('settings.mcp.errCodeWrapperValue') }
  }
  const record = obj as Record<string, unknown>
  const isBare = 'command' in record || 'url' in record || 'type' in record
  if (isBare) {
    if (!props.editing) {
      return { ok: false, error: t('settings.mcp.errCodeBareNeedsWrapper') }
    }
    return { ok: true, name: props.editing.name, entry: record as McpServerEntryValue }
  }
  const keys = Object.keys(record)
  if (keys.length !== 1) {
    return { ok: false, error: t('settings.mcp.errCodeSingle') }
  }
  const value = record[keys[0]]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: t('settings.mcp.errCodeWrapperValue') }
  }
  if (props.editing && keys[0] !== props.editing.name) {
    return { ok: false, error: t('settings.mcp.errCodeRenameLocked', { name: props.editing.name }) }
  }
  return { ok: true, name: keys[0], entry: value as McpServerEntryValue }
}

// ── 校验（表单/代码共用链路；错误消息按「错误 → 修复动作」组织，D4）──

/** -/_ 归并同名（pi 将两种字符视为同名：名称中连字符替换为下划线后比对，D4） */
function normalizeName(n: string): string {
  return n.replace(/-/g, '_')
}

function validateName(candidate: string): string | null {
  if (!candidate) return t('settings.mcp.errNameRequired')
  if (!/^[A-Za-z0-9_-]+$/.test(candidate)) return t('settings.mcp.errNameCharset')
  const others = props.existingNames.filter((n) => n !== props.editing?.name)
  if (others.some((n) => normalizeName(n) === normalizeName(candidate))) {
    return t('settings.mcp.errNameDuplicate')
  }
  return null
}

function validateEntry(entry: McpServerEntryValue): boolean {
  if (entry.command && entry.url) {
    fieldErrors.value.command = t('settings.mcp.errExclusive')
    return false
  }
  if (!entry.command && !entry.url) {
    if (transport.value === 'http') {
      fieldErrors.value.url = t('settings.mcp.errUrlRequired')
    } else {
      fieldErrors.value.command = t('settings.mcp.errCommandRequired')
    }
    return false
  }
  return true
}

/** 提交（保存按钮）：当前 tab 内容 → 解析 → 校验 → emit（保存协议调用与损坏拒入处理归 McpSection） */
function submit(): void {
  fieldErrors.value = {}
  let candidateName: string
  let entry: McpServerEntryValue

  if (activeTab.value === 'code') {
    const parsed = parseCodeText()
    if (!parsed.ok) {
      codeError.value = parsed.error
      return
    }
    candidateName = props.editing ? props.editing.name : (parsed.name ?? '')
    entry = parsed.entry
  } else {
    candidateName = name.value.trim()
    const built = formToEntry()
    entry = built.entry
    if (built.envBadLines.length > 0) {
      fieldErrors.value.env = t('settings.mcp.errEnvBadLine', { lines: built.envBadLines.join(', ') })
    }
    if (built.headersBadLines.length > 0) {
      fieldErrors.value.headers = t('settings.mcp.errHeadersBadLine', { lines: built.headersBadLines.join(', ') })
    }
  }

  const nameError = validateName(candidateName)
  const entryValid = validateEntry(entry)
  if (!nameError && entryValid) {
    emit('submit', { name: candidateName, entry })
    return
  }
  if (activeTab.value === 'code') {
    // 代码模式：entry 级校验错误（互斥/必填）的字段位错误区在表单 tab 不可见——统一经 codeError 显示
    codeError.value = nameError ?? fieldErrors.value.command ?? fieldErrors.value.url ?? ''
    fieldErrors.value = {}
    return
  }
  if (nameError) fieldErrors.value.name = nameError
}
</script>
