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
          :agent-dir="agentDir"
          @toggle="onToggle"
          @test="onTest"
          @cancel-test="onTestCancel"
          @edit="openEdit"
          @remove="askRemove"
          @copy-login="copyLoginCommand"
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
 * 实时刷新，重开分区或保存后可见）。协议动作编排：启停（setEnabled 专用操作——runtime
 * 仅翻转 enabled 键，不带清单投影回写，§3.1 最小语义）/ 删除（确认后 remove）/ 连接测试
 *（test 发起，徽标转「测试中」；测试进行中按钮切「取消」→ testCancel 杀 probe 子进程，
 * D3 主动终止形态）。写入生效语义 = 新会话生效（D1，页头说明）。I3 登录引导：needs-auth
 * 条目的登录命令 PI_CODING_AGENT_DIR 值取自 mcp.list reply 的 agentDir，复制经 toast 反馈。
 *
 * probe 结果回填通道：协议面 test 只回异步句柄（McpTestHandle），终态经 runtime 的
 * `mcp:testResult` 广播帧回填——连接测试三组状态（徽标 / 上次结果 / testId 登记）、广播
 * 订阅与 applyProbeResult 接缝（defineExpose 透传；「测试超时」同样经此回填，D3 语义 =
 * 整体无本次结果，保留上次成功测试结果展示）整体在 useMcpTestState（composables/ 同级
 * 抽取）；分区未挂载窗口的广播结果自然丢失（徽标是 UI 本地态，D8②「本次界面会话未跑过
 * 测试」，重开分区回落「未测试」为既定形态）。
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle, Copy, Plus } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { GroupCard } from '@taiji/ui/features/settings'
import ConfirmDialog from '@/components/ui/dialog/ConfirmDialog.vue'
import McpServerList from './McpServerList.vue'
import McpServerForm from './McpServerForm.vue'
import {
  addMcpServer,
  cancelMcpServerTest,
  listMcpServers,
  removeMcpServer,
  setMcpServerEnabled,
  testMcpServer,
  updateMcpServer,
} from '@taiji/core/transport/api/domains/mcp'
import type { McpConfigCorruption, McpServerEntry, McpServerEntryValue } from '@taiji/shared'
import { useMcpTestState } from '@/composables/useMcpTestState'
import { useToast } from '@/composables/useToast'

const { t } = useI18n()
const { info: toastInfo, error: toastError } = useToast()

const loadError = ref(false)
const servers = ref<McpServerEntry[]>([])
const corruption = ref<McpConfigCorruption | null>(null)
/** pi agent 目录绝对路径（mcp.list reply 携带；I3 登录命令 PI_CODING_AGENT_DIR 值） */
const agentDir = ref('')

const busyName = ref<string | null>(null)

// 连接测试状态域（徽标三组 refs + probe 终态广播订阅 + 状态操作）整体在 useMcpTestState
//（composable 抽取，useMcpServerForm 同款分工——协议调用编排与 busy 互斥留本组件）
const {
  badges,
  lastProbe,
  activeTestIds,
  markTesting,
  registerActiveTest,
  clearActiveTest,
  resetTestState,
  clearBadgeState,
  revertBadge,
  applyProbeResult,
} = useMcpTestState()

const formOpen = ref(false)
const editingName = ref<string | null>(null)
const formServerError = ref<string | null>(null)
const pendingRemoveName = ref<string | null>(null)

const editingEntry = computed(() => servers.value.find((s) => s.name === editingName.value) ?? null)
const existingNames = computed(() => servers.value.map((s) => s.name))

onMounted(() => {
  void refresh()
})

async function refresh(): Promise<void> {
  loadError.value = false
  try {
    const res = await listMcpServers()
    servers.value = res.servers
    corruption.value = res.corruption
    agentDir.value = res.agentDir
    resetTestState()
  } catch (e) {
    loadError.value = true
    console.warn('[McpSection] failed to load mcp servers:', e)
  }
}

/** 损坏拒入统一处理（清单行动作与表单保存共用）：转整页损坏态（先修复文件，S6）+ toast */
function applyCorruptionFailure(corrupt: McpConfigCorruption): void {
  formOpen.value = false
  formServerError.value = null
  corruption.value = corrupt
  toastError(t('settings.mcp.saveRejected', { path: corrupt.filePath }))
}

/** 表单保存失败：损坏转整页损坏态；校验/拦截错误内联显示在编辑弹层（D4 失败样例语境） */
function applyMutationFailure(err: string, corrupt: McpConfigCorruption | null | undefined): void {
  if (corrupt) {
    applyCorruptionFailure(corrupt)
    return
  }
  formServerError.value = err
}

/**
 * 清单行动作失败（启停/删除）：损坏转整页损坏态；其余错误走 toast——formServerError
 * 仅由编辑弹层渲染（弹层未开时不可达），清单行失败写它则用户无任何可见反馈（错误
 * 「错误 → 原因 → 修复动作」文案经 toast 到达用户，与 handleRpcError 同通道）
 */
function applyRowActionFailure(err: string, corrupt: McpConfigCorruption | null | undefined): void {
  if (corrupt) {
    applyCorruptionFailure(corrupt)
    return
  }
  toastError(err)
}

// ── 清单行动作 ──

async function onToggle(entry: McpServerEntry, enabled: boolean): Promise<void> {
  if (busyName.value) return
  busyName.value = entry.name
  try {
    // 启停专用操作（§3.1「写入 enabled 字段」最小语义）：runtime 锁内仅翻转 enabled 键，
    // 不带清单投影回写——外部并发改动（终端 pi mcp 命令/手编）不被旧投影覆盖（D2 丢失
    // 窗口保持锁内亚秒级）；reply entry = 写后落盘终态，服务端校准清单
    const res = await setMcpServerEnabled({ name: entry.name, enabled })
    if (res.ok) {
      replaceEntry(res.entry)
    } else {
      applyRowActionFailure(res.error, res.corruption)
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
  markTesting(name)
  try {
    const handle = await testMcpServer({ name })
    // 异步任务已受理；终态徽标经 applyProbeResult 回填；testId 登记供「取消」按钮按句柄终止（D3）
    registerActiveTest(name, handle.testId)
  } catch (e) {
    revertBadge(name)
    handleRpcError(e)
  } finally {
    busyName.value = null
  }
}

async function onTestCancel(name: string): Promise<void> {
  if (busyName.value) return
  const testId = activeTestIds.value[name]
  if (testId === undefined) return
  busyName.value = name
  try {
    const res = await cancelMcpServerTest({ testId })
    if (res.cancelled) {
      // 取消生效：probe 以 cancelled 终态收敛（不回填徽标），本侧恢复取消前徽标——
      // 主动取消与 D3 超时同源语义（整体无本次结果），上次成功结果自然保留展示
      clearActiveTest(name)
      revertBadge(name)
    }
    // cancelled false = 任务已结束：结果徽标已经（或即将）经 mcp:testResult 回填，不动
  } catch (e) {
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
      applyRowActionFailure(res.error, res.corruption)
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

function handleRpcError(e: unknown): void {
  const detail = e instanceof Error && e.message ? e.message : ''
  toastError(detail || t('settings.mcp.rpcFailed'))
}

/** I3 登录引导：复制完整登录命令（含 PI_CODING_AGENT_DIR 隔离环境变量），toast 反馈 */
async function copyLoginCommand(command: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(command)
    toastInfo(t('settings.mcp.loginCmdCopied'))
  } catch (e) {
    // best-effort：复制失败不打断（命令在清单行完整可见，用户可手动选中复制，copyCorruptedPath 同款降级）
    console.warn('[McpSection] failed to copy login command:', e)
  }
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
