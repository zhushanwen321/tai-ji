/**
 * useMcpServerForm —— MCP 服务器表单的字段状态域（McpServerForm.vue 抽取）。
 *
 * 持有表单字段 refs（名称 / 传输类型 / stdio 字段组 / http 字段组 / 描述 / exposure）
 * 与字段级操作（条目回填、传输类型切换清空另一类型字段、exposure 展示提示）。
 * 弹层开关重置、表单 ↔ 代码互转、校验与提交编排留在 McpServerForm.vue——它们跨
 * 字段域与代码模式域，不属单一字段状态。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AcceptableValue } from 'reka-ui'
import type { McpExposureLevel, McpServerEntryValue } from '@taiji/shared'

export type TransportKind = 'stdio' | 'http'

export function useMcpServerForm() {
  const { t } = useI18n()

  const name = ref('')
  const transport = ref<TransportKind>('stdio')
  const command = ref('')
  const argsText = ref('')
  const envText = ref('')
  const cwd = ref('')
  const url = ref('')
  const headersText = ref('')
  const description = ref('')
  const exposure = ref<McpExposureLevel>('codemode')

  const exposureHint = computed(() => t(`settings.mcp.exposureHint.${exposure.value}`))

  function clearTransportFields(): void {
    command.value = ''
    argsText.value = ''
    envText.value = ''
    cwd.value = ''
    url.value = ''
    headersText.value = ''
  }

  function fillFormFromEntry(value: McpServerEntryValue): void {
    transport.value = value.url ? 'http' : 'stdio'
    command.value = value.command ?? ''
    argsText.value = (value.args ?? []).join('\n')
    // env/headers 键集自由（pi 语义：用户可配任意环境变量/请求头名），此处为对象 → 行文本回显，
    // 无注入面，不做键白名单过滤
    envText.value = kvRecordToText(value.env)
    cwd.value = value.cwd ?? ''
    url.value = value.url ?? ''
    headersText.value = kvRecordToText(value.headers)
    description.value = value.description ?? ''
    exposure.value = value.exposure ?? 'codemode'
  }

  function kvRecordToText(record: Record<string, string> | undefined): string {
    if (!record) return ''
    const lines: string[] = []
    for (const key of Object.keys(record)) lines.push(`${key}=${record[key]}`)
    return lines.join('\n')
  }

  /** 传输类型切换清空另一类型字段（D7：表单字段与条目对象键两级清理由此 + 只按当前类型收键共同保证） */
  function onTransportChange(value: AcceptableValue): void {
    const next = value as TransportKind
    if (next === transport.value) return
    transport.value = next
    if (next === 'stdio') {
      url.value = ''
      headersText.value = ''
    } else {
      command.value = ''
      argsText.value = ''
      envText.value = ''
      cwd.value = ''
    }
  }

  function onExposureChange(value: AcceptableValue): void {
    exposure.value = value as McpExposureLevel
  }

  return {
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
  }
}
