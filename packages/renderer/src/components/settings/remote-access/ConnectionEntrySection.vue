<!--
  远程访问 · 连接入口区（纯展示 + 本地交互态，不持 IPC 状态）。
  展示完整连接链接（`http://<ip>:<port>/?token=<token>`）+ 二维码 + 复制按钮；
  多地址（多网卡）时经 Select 切换，链接/二维码/复制跟随选中地址。
  轮换按钮由父层（RemoteAccessPage）编排——token 变化经 props 流入，本组件自动重渲染。
-->
<template>
  <!--
    [w3b] demo 对照：RemoteAccessSection.vue 连接入口卡体（.gcard-body 内 .srow 行节奏）——
    警告行 = srow（warn 图标 16px + desc 13px fg-2，无软底）；地址行 = srow（label + Select w320）；
    二维码行 = srow align-start（140px 方块 r-md border + 内衬 8px；右侧 mono 链接行 + 复制钮
    .btn.secondary + desc）；提示/防火墙行 = srow desc。text-muted/text-fg 为 preset 无映射的
    无效工具类（静默 inherit），本波顺手换确定形态。
  -->
  <div class="flex flex-col">
    <!-- 警告文案（太极纯灰 warn 语义 token，不硬编码颜色） -->
    <div
      class="flex items-start gap-4 px-1.5 py-2.5"
      data-testid="remote-access-warning"
    >
      <AlertTriangle class="mt-[2px] size-[16px] shrink-0 text-warn" />
      <p class="text-[length:var(--text-sm)] text-[color:var(--neutral-fg-2)]">{{ t('settings.remoteAccess.warning') }}</p>
    </div>

    <!-- 空态：无 LAN 候选（runtime 未运行/重启中）——不产死链接（demo 卡内空态行：desc p 8px 6px） -->
    <p v-if="info.urls.length === 0" class="border-t border-hairline px-[6px] py-[8px] text-[length:var(--text-sm)] text-[color:var(--neutral-fg-2)]" data-testid="remote-access-no-urls">
      {{ t('settings.remoteAccess.noUrls') }}
    </p>

    <template v-else>
      <!-- 多地址切换（多网卡场景；单地址不渲染选择器）。
           下拉项文本 = url + Tailscale 项标注后缀——SelectItemText 的 textContent 即
           SelectValue 触发器显示文本，后缀形态让关闭态也能看出选中的是 Tailscale 地址 -->
      <SettingRow v-if="info.urls.length > 1" :label="t('settings.remoteAccess.addressLabel')">
        <Select :model-value="selectedUrl" @update:model-value="(v) => (selectedUrl = String(v))">
          <SelectTrigger class="w-[320px] font-mono" data-testid="remote-access-url-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="entry in info.urls" :key="entry.url" :value="entry.url">
              {{ entry.kind === 'tailscale' ? `${entry.url}${t('settings.remoteAccess.tailscaleSuffix')}` : entry.url }}
            </SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>

      <!-- 选中 Tailscale 地址的使用前提（选中态提示；单 tailscale 地址无下拉也渲染） -->
      <p
        v-if="selectedKind === 'tailscale'"
        class="flex min-h-[44px] items-center border-t border-hairline px-1.5 py-2.5 text-[length:var(--text-sm)] text-[color:var(--neutral-fg-2)]"
        data-testid="remote-access-tailscale-selected-hint"
      >
        {{ t('settings.remoteAccess.tailscaleSelectedHint') }}
      </p>

      <!-- 二维码行（demo srow align-start gap 16px；qrcode toDataURL 自绘 img，不引 vue 包装依赖）；
           生成失败/在途渲染占位提示。二维码底白 = 内容语义色例外条款（点阵黑白是内容本身） -->
      <div class="flex items-start gap-4 border-t border-hairline px-1.5 py-2.5">
        <div class="h-[140px] w-[140px] shrink-0 rounded-md border border-border bg-white p-[8px]" :aria-label="t('settings.remoteAccess.qrAlt')">
          <img
            v-if="qrDataUrl"
            :src="qrDataUrl"
            :alt="t('settings.remoteAccess.qrAlt')"
            class="block size-full"
            data-testid="remote-access-qr"
          >
          <div
            v-else
            class="flex size-full items-center justify-center"
            data-testid="remote-access-qr-placeholder"
          >
            <p class="text-center text-[length:var(--text-2xs)] leading-[1.55] text-[color:var(--neutral-fg-2)]">
              {{ t('settings.remoteAccess.qrFailed') }}
            </p>
          </div>
        </div>

        <!-- 链接 + 复制 -->
        <div class="flex min-w-0 flex-1 flex-col gap-[8px]">
          <p
            class="break-all font-mono text-[length:var(--text-sm)] text-[color:var(--neutral-fg-2)]"
            data-testid="remote-access-url"
          >{{ fullUrl }}</p>
          <Button
            variant="secondary"
            class="h-[32px] self-start px-[12px] text-[length:var(--text-sm)] [&_svg]:size-[14px]"
            :data-testid="copied ? 'remote-access-copied' : 'remote-access-copy'"
            @click="onCopy"
          >
            <component :is="copied ? Check : Copy" />
            {{ copied ? t('settings.remoteAccess.copied') : t('settings.remoteAccess.copyLink') }}
          </Button>
          <p class="text-[length:var(--text-sm)] text-[color:var(--neutral-fg-2)]">{{ t('settings.remoteAccess.entryDesc') }}</p>
        </div>
      </div>
    </template>

    <!-- 防火墙授权提示（OS 级行为说明；非 macOS 用户看到亦无害，不做平台分支） -->
    <p class="border-t border-hairline px-1.5 py-2.5 text-[length:var(--text-sm)] text-[color:var(--neutral-fg-2)]">{{ t('settings.remoteAccess.firewallHint') }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle, Check, Copy } from '@lucide/vue'
import QRCode from 'qrcode'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import SettingRow from '../SettingRow.vue'
import { useCopy } from '@/composables/panel/useCopy'
import type { RemoteAccessInfo } from '@taiji/shared'

const props = defineProps<{
  info: RemoteAccessInfo
}>()

const { t } = useI18n()
const { copied, copy } = useCopy()

/** 当前展示的地址候选（默认首个；urls 变化后失效时回落首个——数组已按 Tailscale 优先排序） */
const selectedUrl = ref('')

watch(
  () => props.info.urls,
  (urls) => {
    if (!urls.some((entry) => entry.url === selectedUrl.value)) selectedUrl.value = urls[0]?.url ?? ''
  },
  { immediate: true },
)

/** 选中候选的地址类型（lan 兜底：selectedUrl 未命中时按局域网形态渲染，不显示 Tailscale 提示） */
const selectedKind = computed(() =>
  props.info.urls.find((entry) => entry.url === selectedUrl.value)?.kind ?? 'lan',
)

/** 完整连接链接：地址候选（`http://<ip>:<port>`）拼 remote token（design §3.1 成功路径第 2 步形态） */
const fullUrl = computed(() =>
  selectedUrl.value && props.info.token ? `${selectedUrl.value}/?token=${props.info.token}` : '',
)

/** 二维码 data URL（生成失败/在途置空渲染占位提示块——文案引导复制链接兜底，不阻塞链接/复制通路） */
const qrDataUrl = ref('')

/**
 * QR 生成序号（竞态守卫）：fullUrl 快速切换（轮换 token / 换地址）时多代生成并发在途，
 * toDataURL 异步返回乱序——旧一代慢返回不得覆盖新一代结果，每代 await 后比对序号。
 */
let qrSeq = 0

watch(fullUrl, async (url) => {
  const seq = ++qrSeq
  if (!url) {
    qrDataUrl.value = ''
    return
  }
  try {
    const dataUrl = await QRCode.toDataURL(url, { width: 280, margin: 1 })
    if (seq !== qrSeq) return
    qrDataUrl.value = dataUrl
  } catch (e) {
    // 降级占位不变：生成失败不阻断链接/复制通路，warn 留排障依据（QR 空白时可归因）
    console.warn('[remote-access] QRCode.toDataURL failed:', e)
    if (seq !== qrSeq) return
    qrDataUrl.value = ''
  }
}, { immediate: true })

function onCopy(): void {
  if (!fullUrl.value) return
  copy(fullUrl.value, 'remote-access-url')
}
</script>
