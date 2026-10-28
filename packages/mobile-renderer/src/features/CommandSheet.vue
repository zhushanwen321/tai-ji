<script setup lang="ts">
// CommandSheet —— 命令面板 Sheet（remote-use-mobile-v2 §7.2 命令面板行 / spec §6.13）。
//
// 语义 = 「命令插入输入框（不直接执行）」：列表项点击 → 命令文本经 composer injection
// store 一次性通道（requestInjection text）插入输入框光标处（Composer 消费侧通路），
// 关闭 Sheet 由用户继续补参数或直接发送——M-11 替换（v1 SlashBarStub 隐藏占位的
// 能力承接）。清单 = session.getCommands 主动拉（broadcast 与订阅时序竞争规则的主动拉取
// 模式，AGENTS.md「Runtime broadcast 时序竞争」行）。
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button, Sheet } from '@taiji/ui'
import { composerInjectionStore, fetchSessionCommands } from '../shell/app-runtime'

const props = defineProps<{
  /** 槽位开合（sheet-manager activeSheet === 'command'） */
  open: boolean
  /** 目标会话（命令清单按会话拉取；null = 无活跃会话，空态） */
  sessionId: string | null
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

const { t } = useI18n()

interface CommandItem {
  name: string
  description?: string
  source: string
}

const commands = ref<CommandItem[]>([])
const loaded = ref(false)

// 打开即拉（每次打开刷新——命令清单随扩展/技能状态变化；关闭保留上次数据避免闪空）
watch(
  () => [props.open, props.sessionId] as const,
  ([open, sid]) => {
    if (!open || !sid) return
    fetchSessionCommands(sid)
      .then((list) => {
        commands.value = list
        loaded.value = true
      })
      .catch((e: unknown) => {
        // 清单拉取失败降级：空态 + 留痕（辅助流不拖垮核心，§7.4）
        console.warn('[CommandSheet] getCommands failed:', e)
        commands.value = []
        loaded.value = true
      })
  },
  { immediate: true },
)

/** 命令插入输入框（§6.13 spec：不直接执行——文本注入 composer，用户确认发送） */
function onPick(cmd: CommandItem): void {
  if (!props.sessionId) return
  composerInjectionStore.requestInjection({
    target: 'current',
    sessionId: props.sessionId,
    text: `/${cmd.name} `,
  })
  emit('close')
}

function onClose(): void {
  emit('close')
}
</script>

<template>
  <Sheet
    :open="open"
    :title="t('mobile.command.title')"
    @update:open="!$event && onClose()"
  >
    <div class="flex flex-col gap-1" data-testid="command-sheet-list">
      <Button
        v-for="cmd in commands"
        :key="`${cmd.source}/${cmd.name}`"
        variant="ghost"
        :data-testid="`command-sheet-item-${cmd.name}`"
        class="min-h-[var(--m-tap)] flex-col items-start gap-0.5 rounded px-2.5 py-2 text-left"
        @click="onPick(cmd)"
      >
        <span class="font-mono text-[length:var(--m-text-sub)] text-neutral-fg">/{{ cmd.name }}</span>
        <span v-if="cmd.description" class="line-clamp-2 text-[length:var(--m-text-sub)] text-neutral-mid">{{ cmd.description }}</span>
      </Button>
      <p
        v-if="loaded && commands.length === 0"
        class="py-2 text-center text-[length:var(--m-text-sub)] text-neutral-mid"
        data-testid="command-sheet-empty"
      >
        {{ t('mobile.command.empty') }}
      </p>
    </div>
  </Sheet>
</template>
