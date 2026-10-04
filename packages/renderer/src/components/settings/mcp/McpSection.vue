<template>
  <div class="flex max-w-[860px] flex-col gap-3" data-testid="mcp-section">
    <header class="page-head">
      <div class="head-text">
        <h1 class="title">{{ t('settings.menu.mcp') }}</h1>
        <!-- 生效说明 + 覆盖说明（设计 §3.1 页头两行定死文案语义）+ D8 快照语义 -->
        <p class="desc" data-testid="mcp-effect-notice">{{ t('settings.mcp.effectNotice') }}</p>
        <p class="desc" data-testid="mcp-scope-notice">{{ t('settings.mcp.scopeNotice') }}</p>
        <p class="desc" data-testid="mcp-snapshot-notice">{{ t('settings.mcp.snapshotNotice') }}</p>
      </div>
      <div class="head-actions">
        <Button
          size="sm"
          class="h-8 gap-1 px-3 text-[12px]"
          :disabled="corruption !== null || loadError"
          data-testid="mcp-add-btn"
          @click="openAdd"
        >
          <Plus class="size-3.5" />
          {{ t('settings.mcp.addServer') }}
        </Button>
      </div>
    </header>

    <!-- 加载失败态（可重试；WorktreePage loadError 同形态） -->
    <div
      v-if="loadError"
      data-testid="mcp-load-error"
      class="flex items-center gap-2 px-4 text-[11px] text-warn"
    >
      <AlertTriangle class="size-3.5 shrink-0" />
      <span>{{ t('settings.mcp.loadError') }}</span>
      <Button
        variant="ghost"
        size="sm"
        class="h-5 px-1.5 text-[11px] text-accent"
        data-testid="mcp-load-retry"
        @click="refresh"
      >{{ t('settings.mcp.loadErrorRetry') }}</Button>
    </div>

    <!-- 损坏错误态（S6：显示损坏提示与文件路径而非空白；保存被拒提示先修复，对齐 codemode 损坏态形态） -->
    <GroupCard v-else-if="corruption">
      <template #head>
        <div class="gc-head-text">
          <h3 class="gc-title">{{ t('settings.mcp.listTitle') }}</h3>
        </div>
      </template>
      <div class="px-2.5 pt-1 pb-3" data-testid="mcp-corruption-error">
        <p class="flex items-center gap-1.5 text-[length:var(--text-sm)] text-warn" data-testid="mcp-corruption-title">
          <AlertTriangle class="size-3.5 shrink-0" />
          {{ t('settings.mcp.corruptionTitle') }}
        </p>
        <div class="mt-1.5 flex items-center gap-2">
          <code
            class="min-w-0 flex-1 truncate rounded-sm bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-neutral-mid"
            data-testid="mcp-corruption-path"
            :title="corruption.filePath"
          >
            {{ corruption.filePath }}
          </code>
          <Button
            variant="ghost"
            size="sm"
            class="h-6 shrink-0 gap-1 px-2 text-[11px] text-muted hover:text-fg"
            data-testid="mcp-copy-path-btn"
            @click="copyCorruptedPath"
          >
            <Copy class="size-3" />
            {{ t('settings.mcp.copyPath') }}
          </Button>
        </div>
        <p class="mt-1.5 text-[11px] leading-relaxed text-neutral-mid" data-testid="mcp-corruption-guide">
          {{ t('settings.mcp.corruptionGuide') }}
        </p>
        <p
          v-if="corruption.corruptCopyPath"
          class="mt-1 text-[11px] leading-relaxed text-warn"
          data-testid="mcp-corrupt-copy-path"
        >
          {{ t('settings.mcp.corruptionCopyHint', { path: corruption.corruptCopyPath }) }}
        </p>
      </div>
    </GroupCard>

    <!-- 清单 -->
    <GroupCard v-else>
      <template #head>
        <div class="gc-head-text">
          <h3 class="gc-title">{{ t('settings.mcp.listTitle') }}</h3>
          <p class="gc-sub">{{ t('settings.mcp.listDesc') }}</p>
        </div>
      </template>
      <div class="px-2.5 pt-1 pb-2">
        <McpServerList
          :servers="servers"
          :badges="badges"
          :last-probe="lastProbe"
          :busy-name="busyName"
          @toggle="onToggle"
          @test="onTest"
          @edit="openEdit"
          @remove="askRemove"
        />
      </div>
    </GroupCard>

    <!-- 添加/编辑弹层（D7 双 tab 表单） -->
    <McpServerForm
      v-model:open="formOpen"
      :editing="editingEntry"
      :existing-names="existingNames"
      :server-error="formServerError"
      @submit="onFormSubmit"
    />

    <!-- 删除确认（§3.1：误操作有确认） -->
    <ConfirmDialog
      :open="pendingRemoveName !== null"
      :title="t('settings.mcp.deleteConfirmTitle', { name: pendingRemoveName ?? '' })"
      :description="t('settings.mcp.deleteConfirmDesc')"
      :confirm-text="t('settings.mcp.delete')"
      :loading="busyName !== null"
      data-testid="mcp-remove-confirm"
      @update:open="onConfirmOpenChange"
      @confirm="doRemove"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * 设置页 MCP 分区（pi-mcp-management U3）。
 *
 * 数据通道：直连 core transport 域（@taiji/core/transport/api/domains/mcp，设计 §2.4
 * 「表现层依赖 core transport 域」；不经 SettingsTransport seam——MCP 非 settings 域语义）。
 * 打开时经 mcp.list 拉取一次（§3.1 拉取一次模型：pi 无状态推送通道，运行期间外部改动不
 * 实时刷新，重开分区或保存后可见）。协议动作编排：启停（update 写 enabled）/ 删除（确认
 * 后 remove）/ 连接测试（test 发起，徽标转「测试中」）。写入生效语义 = 新会话生效（D1，
 * 页头说明）。
 *
 * probe 结果回填通道（u5b 打回接线）：协议面 test 只回异步句柄（McpTestHandle），终态经
 * runtime 的 `mcp:testResult` 广播帧回填——本组件挂载期间订阅该帧（onGlobalType 全局通道，
 * rollingRestart:* 先例同构）转交 applyProbeResult；分区未挂载窗口的广播结果自然丢失
 *（徽标是 UI 本地态，D8②「本次界面会话未跑过测试」，重开分区回落「未测试」为既定形态）。
 * applyProbeResult 同为 defineExpose 接缝（「测试超时」同样经此回填，D3 语义 = 整体无
 * 本次结果，保留上次成功测试结果展示）。
 */
import { computed, onMounted, onScopeDispose, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle, Copy, Plus } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { GroupCard } from '@taiji/ui/features/settings'
import ConfirmDialog from '@/components/ui/dialog/ConfirmDialog.vue'
import McpServerList from './McpServerList.vue'
import McpServerForm from './McpServerForm.vue'
import {
  addMcpServer,
  listMcpServers,
  removeMcpServer,
  testMcpServer,
  updateMcpServer,
} from '@taiji/core/transport/api/domains/mcp'
import { onGlobalType } from '@taiji/core/transport/api'
import type { McpConfigCorruption, McpServerEntry, McpServerEntryValue, McpServerStatusBadge } from '@taiji/shared'
import { useToast } from '@/composables/useToast'

const { t } = useI18n()
const { info: toastInfo, error: toastError } = useToast()

const loadError = ref(false)
const servers = ref<McpServerEntry[]>([])
const corruption = ref<McpConfigCorruption | null>(null)

/** 条目当前展示徽标（name → badge；缺省未测试，经 McpServerList 缺省渲染） */
const badges = ref<Record<string, McpServerStatusBadge>>({})
/** 最近一次 probe 终态徽标（「测试超时」时保留展示，D3） */
const lastProbe = ref<Record<string, McpServerStatusBadge>>({})
const busyName = ref<string | null>(null)

const formOpen = ref(false)
const editingName = ref<string | null>(null)
const formServerError = ref<string | null>(null)
const pendingRemoveName = ref<string | null>(null)

const editingEntry = computed(() => servers.value.find((s) => s.name === editingName.value) ?? null)
const existingNames = computed(() => servers.value.map((s) => s.name))

onMounted(() => {
  void refresh()
})

// probe 终态广播订阅（u5b 打回接线）：runtime probe 完成 → mcp:testResult 帧 → 徽标回填。
// setup 同步订阅 + 作用域销毁注销（组件多实例防泄漏；applyProbeResult 是函数声明提升，
// 订阅注册早于其定义位置亦可安全引用）。
const offTestResult = onGlobalType('mcp:testResult', (msg) => {
  applyProbeResult(msg.payload.name, msg.payload.badge)
})
onScopeDispose(offTestResult)

async function refresh(): Promise<void> {
  loadError.value = false
  try {
    const res = await listMcpServers()
    servers.value = res.servers
    corruption.value = res.corruption
    badges.value = {}
    lastProbe.value = {}
  } catch (e) {
    loadError.value = true
    console.warn('[McpSection] failed to load mcp servers:', e)
  }
}

/** 损坏拒入统一处理：携带 corruption 时关闭弹层转整页损坏态（先修复文件，S6） */
function applyMutationFailure(err: string, corrupt: McpConfigCorruption | null | undefined): void {
  if (corrupt) {
    formOpen.value = false
    formServerError.value = null
    corruption.value = corrupt
    toastError(t('settings.mcp.saveRejected', { path: corrupt.filePath }))
    return
  }
  formServerError.value = err
}

// ── 清单行动作 ──

async function onToggle(entry: McpServerEntry, enabled: boolean): Promise<void> {
  if (busyName.value) return
  busyName.value = entry.name
  try {
    // 整条目值带回（文件投影含表单外键）+ enabled 覆盖；合并契约归 runtime store（D7）
    const res = await updateMcpServer({ name: entry.name, entry: { ...entry.value, enabled } })
    if (res.ok) {
      replaceEntry(res.entry)
    } else {
      applyMutationFailure(res.error, res.corruption)
    }
  } catch (e) {
    handleRpcError(e)
  } finally {
    busyName.value = null
  }
}

async function onTest(name: string): Promise<void> {
  if (busyName.value) return
  busyName.value = name
  badges.value = { ...badges.value, [name]: { source: 'ui-local', state: 'testing' } }
  try {
    await testMcpServer({ name })
    // 异步任务已受理；终态徽标经 applyProbeResult 回填（通道归 runtime 实施期接线）
  } catch (e) {
    revertBadge(name)
    handleRpcError(e)
  } finally {
    busyName.value = null
  }
}

function askRemove(name: string): void {
  pendingRemoveName.value = name
}

function onConfirmOpenChange(open: boolean): void {
  if (!open) pendingRemoveName.value = null
}

async function doRemove(): Promise<void> {
  const name = pendingRemoveName.value
  if (!name || busyName.value) return
  busyName.value = name
  try {
    const res = await removeMcpServer({ name })
    if (res.ok) {
      servers.value = servers.value.filter((s) => s.name !== name)
      clearBadgeState(name)
      pendingRemoveName.value = null
    } else {
      pendingRemoveName.value = null
      applyMutationFailure(res.error, res.corruption)
    }
  } catch (e) {
    pendingRemoveName.value = null
    handleRpcError(e)
  } finally {
    busyName.value = null
  }
}

// ── 添加/编辑弹层 ──

function openAdd(): void {
  editingName.value = null
  formServerError.value = null
  formOpen.value = true
}

function openEdit(entry: McpServerEntry): void {
  editingName.value = entry.name
  formServerError.value = null
  formOpen.value = true
}

async function onFormSubmit(payload: { name: string; entry: McpServerEntryValue }): Promise<void> {
  if (busyName.value) return
  const isEdit = editingName.value !== null
  busyName.value = payload.name
  try {
    const res = isEdit
      ? await updateMcpServer({ name: editingName.value as string, entry: payload.entry })
      : await addMcpServer({ name: payload.name, entry: payload.entry })
    if (res.ok) {
      // 服务端终态校准清单（写后落盘终态条目）；新条目徽标重置「未测试」
      if (isEdit) replaceEntry(res.entry)
      else servers.value = [...servers.value, res.entry]
      delete badges.value[payload.name]
      badges.value = { ...badges.value }
      formOpen.value = false
      formServerError.value = null
    } else {
      applyMutationFailure(res.error, res.corruption)
    }
  } catch (e) {
    formServerError.value = e instanceof Error && e.message ? e.message : String(e)
  } finally {
    busyName.value = null
  }
}

// ── 本地清单/徽标状态维护 ──

function replaceEntry(next: McpServerEntry): void {
  servers.value = servers.value.map((s) => (s.name === next.name ? next : s))
}

function clearBadgeState(name: string): void {
  const next = { ...badges.value }
  delete next[name]
  badges.value = next
  const last = { ...lastProbe.value }
  delete last[name]
  lastProbe.value = last
}

function revertBadge(name: string): void {
  const next = { ...badges.value }
  if (lastProbe.value[name]) next[name] = lastProbe.value[name]
  else delete next[name]
  badges.value = next
}

function handleRpcError(e: unknown): void {
  const detail = e instanceof Error && e.message ? e.message : ''
  toastError(detail || t('settings.mcp.rpcFailed'))
}

/**
 * probe 终态徽标回填（defineExpose 接缝）：连接测试结果的唯一入口——来源通道（runtime 侧
 * 实施期登记的推送/拉取形态）落地后接到此处。timeout 态只更新当前展示徽标，lastProbe 保留
 * 上次成功结果（D3 超时语义）。
 */
function applyProbeResult(name: string, badge: McpServerStatusBadge): void {
  if (badge.source === 'probe' || badge.source === 'config') {
    lastProbe.value = { ...lastProbe.value, [name]: badge }
  }
  badges.value = { ...badges.value, [name]: badge }
}

async function copyCorruptedPath(): Promise<void> {
  if (!corruption.value) return
  try {
    await navigator.clipboard.writeText(corruption.value.filePath)
    toastInfo(t('settings.mcp.pathCopied'))
  } catch (e) {
    // best-effort：复制失败不打断错误态（路径仍完整可见，用户可手动选中复制，codemode 同款降级）
    console.warn('[McpSection] failed to copy corrupted path:', e)
  }
}

defineExpose({ applyProbeResult, refresh })
</script>
