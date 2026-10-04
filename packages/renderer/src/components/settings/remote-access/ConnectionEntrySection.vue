<!--
  远程访问 · 连接入口区（纯展示 + 本地交互态，不持 IPC 状态）。
  展示完整连接链接（`http://<ip>:<port>/?token=<token>`）+ 二维码 + 复制按钮；
  多地址（多网卡）时经 Select 切换，链接/二维码/复制跟随选中地址。
  轮换按钮由父层（RemoteAccessPage）编排——token 变化经 props 流入，本组件自动重渲染。
-->
<template>
  <div class="flex flex-col gap-3 px-4 py-3">
    <!-- 警告文案（太极纯灰 warn 语义 token，不硬编码颜色） -->
    <div
      class="flex items-start gap-2 rounded-sm bg-warn-soft px-3 py-2"
      data-testid="remote-access-warning"
    >
      <AlertTriangle class="mt-0.5 size-3.5 shrink-0 text-warn" />
      <p class="text-[11px] leading-relaxed text-warn">{{ t('settings.remoteAccess.warning') }}</p>
    </div>

    <!-- 空态：无 LAN 候选（runtime 未运行/重启中）——不产死链接 -->
    <p v-if="info.urls.length === 0" class="text-[11px] text-muted" data-testid="remote-access-no-urls">
      {{ t('settings.remoteAccess.noUrls') }}
    </p>

    <template v-else>
      <!-- 多地址切换（多网卡场景；单地址不渲染选择器） -->
      <div v-if="info.urls.length > 1" class="flex items-center justify-between">
        <Label class="text-[12px] text-fg">{{ t('settings.remoteAccess.addressLabel') }}</Label>
        <Select :model-value="selectedUrl" @update:model-value="(v) => (selectedUrl = String(v))">
          <SelectTrigger class="h-8 w-[240px] px-2 font-mono text-[11px]" data-testid="remote-access-url-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="url in info.urls" :key="url" :value="url">{{ url }}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div class="flex items-start gap-4">
        <!-- 二维码（qrcode toDataURL 自绘 img，不引 vue 包装依赖） -->
        <div class="shrink-0 rounded-sm border border-border bg-white p-1.5">
          <img
            v-if="qrDataUrl"
            :src="qrDataUrl"
            :alt="t('settings.remoteAccess.qrAlt')"
            class="size-[140px] block"
            data-testid="remote-access-qr"
          >
          <div v-else class="size-[140px]" aria-hidden="true"></div>
        </div>

        <!-- 链接 + 复制 -->
        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <p
            class="break-all rounded-sm border border-border-strong bg-bg-input px-2 py-1.5 font-mono text-[11px] leading-relaxed text-fg"
            data-testid="remote-access-url"
          >{{ fullUrl }}</p>
          <div>
            <Button
              variant="secondary"
              size="dense"
              class="h-8 px-3 text-[11px]"
              :data-testid="copied ? 'remote-access-copied' : 'remote-access-copy'"
              @click="onCopy"
            >
              <component :is="copied ? Check : Copy" class="size-3.5" />
              {{ copied ? t('settings.remoteAccess.copied') : t('settings.remoteAccess.copyLink') }}
            </Button>
          </div>
          <p class="text-[11px] leading-relaxed text-muted">{{ t('settings.remoteAccess.entryDesc') }}</p>
        </div>
      </div>
    </template>

    <!-- 防火墙授权提示（OS 级行为说明；非 macOS 用户看到亦无害，不做平台分支） -->
    <p class="text-[11px] leading-relaxed text-muted">{{ t('settings.remoteAccess.firewallHint') }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle, Check, Copy } from '@lucide/vue'
import QRCode from 'qrcode'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useCopy } from '@/composables/panel/useCopy'
import type { RemoteAccessConnectionInfo } from '@/lib/ipc'

const props = defineProps<{
  info: RemoteAccessConnectionInfo
}>()

const { t } = useI18n()
const { copied, copy } = useCopy()

/** 当前展示的地址候选（默认首个；urls 变化后失效时回落首个） */
const selectedUrl = ref('')

watch(
  () => props.info.urls,
  (urls) => {
    if (!urls.includes(selectedUrl.value)) selectedUrl.value = urls[0] ?? ''
  },
  { immediate: true },
)

/** 完整连接链接：地址候选（`http://<ip>:<port>`）拼 remote token（design §3.1 成功路径第 2 步形态） */
const fullUrl = computed(() =>
  selectedUrl.value && props.info.token ? `${selectedUrl.value}/?token=${props.info.token}` : '',
)

/** 二维码 data URL（生成失败置空渲染占位块，不阻塞链接/复制通路） */
const qrDataUrl = ref('')

watch(fullUrl, async (url) => {
  if (!url) {
    qrDataUrl.value = ''
    return
  }
  try {
    qrDataUrl.value = await QRCode.toDataURL(url, { width: 280, margin: 1 })
  } catch (e) {
    // 降级占位不变：生成失败不阻断链接/复制通路，warn 留排障依据（QR 空白时可归因）
    console.warn('[remote-access] QRCode.toDataURL failed:', e)
    qrDataUrl.value = ''
  }
}, { immediate: true })

function onCopy(): void {
  if (!fullUrl.value) return
  copy(fullUrl.value, 'remote-access-url')
}
</script>
