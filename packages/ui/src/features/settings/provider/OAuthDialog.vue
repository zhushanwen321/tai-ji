<script setup lang="ts">
/**
 * OAuth 登录弹窗（feat-optimize-ui · 路径 B 前端 · slice design I4）。
 *
 * 纯展示 + 事件上抛组件，**零 renderer import**：不订阅 auth.* 事件、不调 api。
 * 状态推进完全由父组件驱动（父订阅 auth.deviceCode/auth.authUrl/auth.success/auth.error
 * 后经 props 传入，或按 RPC reply 失败置 error 态）：
 *
 *   status='idle'    → 登录按钮（emit oauth-login，父调 api.oauthLogin）；authorized 时显示已授权 + 重新授权
 *   status='pending' → deviceInfo 非空走 device 分支（user_code 大字号 + 复制 + 打开浏览器 + 倒计时），
 *                      authUrl 非空走 callback 分支（打开浏览器授权 + 本地端口提示），
 *                      两者皆空显示通用等待 spinner
 *   status='success' → 已授权 + 自动关闭（1.2s 后 emit update:open false）
 *   status='error'   → 错误信息 + 重试（emit oauth-login）/ 取消（emit oauth-cancel）
 *
 * emit 契约：oauth-login（点登录/打开浏览器/重试，父调 api.oauthLogin）、
 * oauth-cancel（点取消，父调 api.oauthCancel）、update:open（受控关闭）。
 */
import { computed, onScopeDispose, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, Check, Copy, ExternalLink, KeyRound, Loader2 } from '@lucide/vue'
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle } from '@taiji/ui'

export interface OAuthDialogDeviceInfo {
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresIn?: number
  interval?: number
}

export interface OAuthDialogAuthUrlInfo {
  url: string
  callbackPort?: number
}

export type OAuthDialogStatus = 'idle' | 'pending' | 'success' | 'error'

const props = withDefaults(
  defineProps<{
    /** 受控开关（配合 v-model:open） */
    open: boolean
    /** 目标 provider（oauthName 展示名优先于 name；oauthConfig 提供 callback flow 端口兜底） */
    provider: {
      id: string
      name: string
      oauthName?: string
      oauthConfig?: { flow: string; callbackPort?: number }
    } | null
    /** 父组件 RPC 调用中（登录/取消请求未返回） */
    busy?: boolean
    /** 状态机当前态（父经 auth.* 事件推进） */
    status?: OAuthDialogStatus
    /** device flow 中间态（auth.deviceCode 事件 payload） */
    deviceInfo?: OAuthDialogDeviceInfo | null
    /** callback flow 中间态（auth.authUrl 事件 payload） */
    authUrl?: OAuthDialogAuthUrlInfo | null
    /** error 态信息（auth.error 事件 message 或 oauthLogin RPC error） */
    errorMessage?: string
    /** provider 已有 token（已授权态：正文显示已授权 + 重新授权链接） */
    authorized?: boolean
  }>(),
  {
    provider: null,
    busy: false,
    status: 'idle',
    deviceInfo: null,
    authUrl: null,
    errorMessage: '',
    authorized: false,
  },
)

const emit = defineEmits<{
  'update:open': [value: boolean]
  /** 用户点登录 / 打开浏览器 / 重试：父组件调 api.oauthLogin（runtime 对进行中 flow 幂等） */
  'oauth-login': []
  /** 用户点取消：父组件调 api.oauthCancel（停轮询/关 server/清 state） */
  'oauth-cancel': []
}>()

const { t } = useI18n()

/** 展示名：oauthName 优先（如「GitHub」），fallback provider.name */
const displayName = computed(() => props.provider?.oauthName || props.provider?.name || '')

/** open 受控代理：关闭路径统一 emit update:open（与 ProviderQuickSetup 一致） */
const openProxy = computed<boolean>({
  get: () => props.open,
  set: (v) => {
    if (!v) emit('update:open', false)
  },
})

/** callback flow 本地端口：authUrl 优先，provider.oauthConfig.callbackPort 兜底 */
const callbackPort = computed(
  () => props.authUrl?.callbackPort ?? props.provider?.oauthConfig?.callbackPort,
)

// ── device 态倒计时（expiresIn 秒，每秒递减，归零停止）──
const COUNTDOWN_INTERVAL_MS = 1000
const countdown = ref(0)
let countdownTimer: ReturnType<typeof setInterval> | null = null

function stopCountdown(): void {
  if (countdownTimer) {
    clearInterval(countdownTimer)
    countdownTimer = null
  }
}

watch(
  () => props.deviceInfo,
  (info) => {
    stopCountdown()
    countdown.value = info?.expiresIn ?? 0
    if (info?.expiresIn) {
      countdownTimer = setInterval(() => {
        countdown.value = Math.max(0, countdown.value - 1)
        if (countdown.value <= 0) stopCountdown()
      }, COUNTDOWN_INTERVAL_MS)
    }
  },
  { immediate: true },
)

// ── success 自动关闭（1.2s 展示已授权后受控关闭，父组件不干预）──
const AUTO_CLOSE_MS = 1200
let closeTimer: ReturnType<typeof setTimeout> | null = null

watch(
  () => props.status,
  (status) => {
    if (closeTimer) {
      clearTimeout(closeTimer)
      closeTimer = null
    }
    if (status === 'success' && props.open) {
      closeTimer = setTimeout(() => emit('update:open', false), AUTO_CLOSE_MS)
    }
  },
  { immediate: true },
)

onScopeDispose(() => {
  stopCountdown()
  if (closeTimer) clearTimeout(closeTimer)
})

// ── 复制验证码（navigator.clipboard，失败显示「复制失败」短暂提示，不打断流程）──
const copied = ref(false)
const copyFailed = ref(false)
/** 复制状态提示重置延迟（已复制/复制失败文案展示时长） */
const COPY_RESET_MS = 1500
let copyResetTimer: ReturnType<typeof setTimeout> | null = null

function onCopyCode(): void {
  const code = props.deviceInfo?.userCode
  if (!code) return
  try {
    const clipboard = navigator.clipboard
    if (!clipboard) {
      copyFailed.value = true
    } else {
      // void：writeText promise 的结果经 then 分支处理，无需 await（复制不阻塞 UI）
      void clipboard.writeText(code).then(
        () => {
          copied.value = true
          copyFailed.value = false
        },
        () => {
          copyFailed.value = true
        },
      )
    }
  } catch {
    copyFailed.value = true
  }
  if (copyResetTimer) clearTimeout(copyResetTimer)
  copyResetTimer = setTimeout(() => {
    copied.value = false
    copyFailed.value = false
  }, COPY_RESET_MS)
}

// ── 打开浏览器：device 用验证链接（优先带 code 的完整链接），callback 用授权 URL ──
function onOpenBrowser(): void {
  const url =
    props.deviceInfo?.verificationUriComplete ??
    props.deviceInfo?.verificationUri ??
    props.authUrl?.url
  if (url) window.open(url, '_blank', 'noopener,noreferrer')
  emit('oauth-login')
}
</script>

<template>
  <Dialog v-model:open="openProxy">
    <DialogContent data-testid="oauth-dialog" class="max-w-md">
      <DialogHeader>
        <DialogTitle>{{ t('settings.provider.oauthDialog.title', { name: displayName }) }}</DialogTitle>
      </DialogHeader>

      <!-- 正文区：四态状态机（idle / pending / success / error） -->
      <div class="flex flex-col gap-3">
        <!-- idle：登录按钮 + oauthName 说明；已授权时显示已授权 + 重新授权 -->
        <template v-if="status === 'idle'">
          <div
            v-if="authorized"
            data-testid="oauth-authorized"
            class="flex items-center gap-1.5 rounded-md border border-success/30 bg-success-soft px-3 py-2 text-[12px] text-success"
          >
            <Check class="size-4 shrink-0" />
            <span class="font-medium">{{ t('settings.provider.oauthDialog.alreadyAuthorized') }}</span>
            <span class="text-neutral-mid">{{ t('settings.provider.oauthDialog.authorizedDesc', { name: displayName }) }}</span>
          </div>
          <p
            v-else
            data-testid="oauth-oauthname-hint"
            class="flex items-center gap-1.5 rounded-md bg-surface-2 px-3 py-2 text-[12px] text-neutral-mid"
          >
            <KeyRound class="size-3.5 shrink-0 text-neutral-dim" />
            {{ t('settings.provider.oauthDialog.oauthNameHint', { name: displayName }) }}
          </p>
          <Button
            size="dense"
            data-testid="oauth-login"
            :disabled="busy"
            @click="emit('oauth-login')"
          >
            <Loader2 v-if="busy" class="size-4 animate-spin" />
            {{ authorized ? t('settings.provider.oauthDialog.reauthorize') : t('settings.provider.oauthDialog.login', { name: displayName }) }}
          </Button>
        </template>

        <!-- pending：device / callback / 通用等待三分支 -->
        <div v-else-if="status === 'pending'" data-testid="oauth-pending" class="flex flex-col gap-2.5">
          <!-- device flow：user_code 大字号 + 复制 + 打开浏览器 + 倒计时 -->
          <template v-if="deviceInfo">
            <p class="text-[12px] text-neutral-mid">{{ t('settings.provider.oauthDialog.deviceStep') }}</p>
            <div class="flex items-center gap-2">
              <span
                data-testid="oauth-user-code"
                class="rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-2xl font-semibold tracking-[0.2em] text-accent-fg"
              >{{ deviceInfo.userCode }}</span>
              <Button variant="secondary" size="dense" data-testid="oauth-copy-code" @click="onCopyCode">
                <Copy class="size-3.5" />
                {{ copied ? t('settings.provider.oauthDialog.copied') : t('settings.provider.oauthDialog.copyCode') }}
              </Button>
            </div>
            <p v-if="copyFailed" data-testid="oauth-copy-failed" class="text-[11px] text-danger">
              {{ t('settings.provider.oauthDialog.copyFailed') }}
            </p>
            <Button variant="secondary" size="dense" data-testid="oauth-open-browser" @click="onOpenBrowser">
              <ExternalLink class="size-3.5" />
              {{ t('settings.provider.oauthDialog.openBrowser') }}
            </Button>
            <div class="flex items-center gap-1.5 text-[12px] text-neutral-mid">
              <Loader2 class="size-3.5 animate-spin" />
              <span>{{ t('settings.provider.oauthDialog.waitingAuth') }}</span>
              <span v-if="countdown > 0" data-testid="oauth-countdown" class="tabular-nums">
                {{ t('settings.provider.oauthDialog.expiresIn', { n: String(countdown) }) }}
              </span>
            </div>
          </template>

          <!-- callback flow：打开浏览器授权 + 本地端口提示 -->
          <template v-else-if="authUrl">
            <p class="text-[12px] text-neutral-mid">{{ t('settings.provider.oauthDialog.callbackStep') }}</p>
            <Button size="dense" data-testid="oauth-open-browser" @click="onOpenBrowser">
              <ExternalLink class="size-3.5" />
              {{ t('settings.provider.oauthDialog.openBrowserAuthorize') }}
            </Button>
            <p
              v-if="callbackPort"
              data-testid="oauth-callback-port"
              class="rounded-md border border-info/30 bg-info-soft px-3 py-2 font-mono text-[11px] text-info"
            >
              {{ t('settings.provider.oauthDialog.callbackHint', { port: String(callbackPort) }) }}
            </p>
            <div class="flex items-center gap-1.5 text-[12px] text-neutral-mid">
              <Loader2 class="size-3.5 animate-spin" />
              <span>{{ t('settings.provider.oauthDialog.waitingAuth') }}</span>
            </div>
          </template>

          <!-- 未知中间态（父已置 pending 但事件未到）：通用等待 -->
          <div v-else class="flex items-center gap-1.5 text-[12px] text-neutral-mid">
            <Loader2 class="size-3.5 animate-spin" />
            <span>{{ t('settings.provider.oauthDialog.waitingAuth') }}</span>
          </div>
        </div>

        <!-- success：已授权（自动关闭由脚本内 watch 处理） -->
        <div
          v-else-if="status === 'success'"
          data-testid="oauth-success"
          class="flex flex-col items-center gap-2 rounded-md border border-success/30 bg-success-soft px-3 py-6 text-[12px]"
        >
          <span class="flex size-9 items-center justify-center rounded-full bg-success text-white">
            <Check class="size-5" />
          </span>
          <span class="font-medium text-success">{{ t('settings.provider.oauthDialog.success') }}</span>
          <span class="text-neutral-mid">{{ t('settings.provider.oauthDialog.successDesc') }}</span>
        </div>

        <!-- error：错误信息 + 重试/取消 -->
        <div
          v-else-if="status === 'error'"
          data-testid="oauth-error"
          class="flex items-start gap-1.5 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-[12px] text-danger"
        >
          <AlertCircle class="size-4 shrink-0" />
          <span>{{ errorMessage || t('settings.provider.oauthDialog.errorUnknown') }}</span>
        </div>
      </div>

      <!-- 底部操作区（按状态机切换） -->
      <div class="flex justify-end gap-2">
        <!-- error：重试（重启 flow）+ 取消（中止） -->
        <template v-if="status === 'error'">
          <Button variant="secondary" size="dense" data-testid="oauth-retry" :disabled="busy" @click="emit('oauth-login')">
            {{ t('settings.provider.oauthDialog.retry') }}
          </Button>
          <Button variant="ghost" size="dense" data-testid="oauth-cancel" :disabled="busy" @click="emit('oauth-cancel')">
            {{ t('settings.provider.oauthDialog.cancel') }}
          </Button>
        </template>
        <!-- idle / pending：取消（中止 flow） -->
        <Button
          v-else-if="status === 'idle' || status === 'pending'"
          variant="ghost"
          size="dense"
          data-testid="oauth-cancel"
          :disabled="busy"
          @click="emit('oauth-cancel')"
        >
          {{ t('settings.provider.oauthDialog.cancel') }}
        </Button>
        <!-- success：关闭 -->
        <Button v-else variant="ghost" size="dense" @click="emit('update:open', false)">
          {{ t('settings.provider.oauthDialog.close') }}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
