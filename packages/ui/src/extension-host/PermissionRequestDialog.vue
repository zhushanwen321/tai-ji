<script setup lang="ts">
/**
 * PermissionRequestDialog（W2 · T4，S4 IF4 + clarify Q4）——AC4 权限请求对话框。
 *
 * runtime PluginActivator 广播 plugin:permissionRequest（payload { pluginId, permissions: string[] }）
 * 后，壳把消息驱动成本组件（pluginId/permissions prop + pending 控制 open）：
 * 展示插件申请的权限列表，用户可部分勾选批准（全选/部分）或拒绝。
 *
 * 回传双通道（clarify Q4，职责分离）：
 *  - emit('approve', selectedPermissions) / emit('revoke') —— 组件契约面，供父层 UI 编排（关浮层/置 pending=false）
 *  - transport.approve(pluginId, selected) / transport.revoke(pluginId) —— RPC 唯一通道（plugin.approvePermissions / plugin.revokePermissions）
 *
 * transport 经 PERMISSION_TRANSPORT_KEY inject；未注入时只 emit 不 RPC（壳未接时不崩，design-review T3 cost）。
 */
import { computed, inject, ref, watch } from 'vue'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../primitives/dialog'
import { Button } from '../primitives/button'
import { Checkbox } from '../primitives/checkbox'
import { PERMISSION_TRANSPORT_KEY } from './permission-transport'

const props = defineProps<{
  /** 申请权限的插件 id */
  pluginId: string
  /** 插件申请的权限列表 */
  permissions: string[]
  /** 请求是否挂起（控制浮层 open；壳从消息生命周期驱动） */
  pending: boolean
}>()

const emit = defineEmits<{
  approve: [permissions: string[]]
  revoke: []
}>()

const transport = inject(PERMISSION_TRANSPORT_KEY, null)

/** 当前勾选的权限集合（部分批准；permissions 变化/挂起重置时清空） */
const selected = ref<string[]>([])

// permissions / pending 变化时重置勾选（新请求到来不带旧选择）
watch(
  () => [props.pluginId, props.permissions, props.pending] as const,
  () => {
    selected.value = []
  },
  { immediate: true },
)

const allSelected = computed(() => props.permissions.length > 0 && selected.value.length === props.permissions.length)

function togglePermission(perm: string): void {
  const idx = selected.value.indexOf(perm)
  if (idx >= 0) {
    selected.value.splice(idx, 1)
  } else {
    selected.value.push(perm)
  }
}

/** 全选/取消全选 */
function toggleAll(): void {
  if (allSelected.value) {
    selected.value = []
  } else {
    selected.value = [...props.permissions]
  }
}

/** 批准：emit 通知 + transport RPC（勾选的权限） */
function onApprove(): void {
  emit('approve', [...selected.value])
  transport?.approve(props.pluginId, [...selected.value])
}

/** 拒绝：emit 通知 + transport RPC */
function onRevoke(): void {
  emit('revoke')
  transport?.revoke(props.pluginId)
}
</script>

<template>
  <Dialog :open="pending">
    <DialogContent hide-close class="max-w-[420px]" data-testid="permission-dialog">
      <DialogHeader>
        <DialogTitle data-testid="permission-dialog-title">{{ pluginId }}</DialogTitle>
        <DialogDescription>{{ '插件申请了以下权限，批准后即可使用' }}</DialogDescription>
      </DialogHeader>

      <!-- 权限列表 -->
      <div class="flex flex-col gap-1">
        <!-- 全选切换 -->
        <label
          data-testid="permission-dialog-toggle-all"
          class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-neutral-dim hover:bg-white/[0.04]"
          @click.prevent="toggleAll"
        >
          <Checkbox :model-value="allSelected" />
          <span>{{ '全选' }}</span>
        </label>
        <label
          v-for="perm in permissions"
          :key="perm"
          :data-testid="`permission-item-${perm}`"
          class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 transition-colors hover:bg-white/[0.04]"
          @click.prevent="togglePermission(perm)"
        >
          <Checkbox :model-value="selected.includes(perm)" />
          <span data-testid="permission-item-label" class="font-mono text-[13px] text-neutral-fg">{{ perm }}</span>
        </label>
      </div>

      <!-- actions -->
      <div class="flex justify-end gap-2 pt-2">
        <Button variant="ghost" data-testid="permission-reject" @click="onRevoke">{{ '拒绝' }}</Button>
        <Button variant="default" data-testid="permission-approve" :disabled="selected.length === 0" @click="onApprove">
          {{ '批准' }}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
