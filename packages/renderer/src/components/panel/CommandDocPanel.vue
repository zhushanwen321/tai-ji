<template>
  <!--
    展示组件 · 命令/skill 文档（drawer Doc tab 内容）。
    数据源：
    - SessionCommand（commandStore，按 sessionId + selectedCommandName 查）：name/source/icon/description
    - SKILL.md content（file.read RPC 读 sourceInfo.path，W2 透传）：skill 命令渲染完整文档
    skill 路径优先用 command.sourceInfo.path（W2 透传，含项目级 skill）；
    /skill:xxx 格式无 sourceInfo 时兜底从 settings.skills 查 sourcePath。
    非 skill 命令（extension/builtin）：仅有 description，退化为信息卡。
    selectedCommandName 由 useSideDrawer 单例持有（用户气泡 slash chip 点击时设置）。
  -->
  <section v-if="command" class="flex h-full flex-col">
    <!-- 元信息头：icon + 命令名 + source 标签 + skill 命令的 sourcePath -->
    <header class="flex items-center gap-2 border-b border-border px-3 py-2.5">
      <component :is="iconComponent" class="size-4 shrink-0 text-reasoning" />
      <span class="font-mono text-[length:var(--text-sm)] font-medium text-neutral-fg">{{ command.name }}</span>
      <span class="ml-auto rounded-sm bg-surface-hover px-1.5 py-0.5 text-[length:var(--text-3xs)] text-neutral-mid">{{ sourceLabel }}</span>
    </header>
    <!-- 文档体：skill 命令渲染完整 SKILL.md；非 skill 渲染 description 信息卡 -->
    <div class="min-h-0 flex-1 overflow-auto p-3">
      <template v-if="skill">
        <!-- 元信息卡片：frontmatter 结构化展示（名称/路径/描述）+ 分块复制 + 复制完整 frontmatter。
             content MR 在 fragment 顶层 v-if，加 key 防 null→有值切换时 diff 错位 -->
        <div class="mb-4 overflow-hidden rounded-md border border-border bg-surface">
          <!-- 卡片头：标题 + 复制 frontmatter -->
          <div class="flex items-center border-b border-border bg-surface-hover px-3 py-1.5">
            <span class="text-[length:var(--text-3xs)] font-medium uppercase tracking-wider text-neutral-dim">{{ t('panel.command.meta') }}</span>
            <Button
              v-if="skill.frontmatter"
              variant="ghost"
              class="ml-auto h-6 gap-1 px-1.5 text-[length:var(--text-2xs)] text-neutral-mid"
              :title="t('panel.command.copyFrontmatter')"
              @click="copy(skill.frontmatter, 'frontmatter')"
            >
              <Check v-if="copied === 'frontmatter'" class="size-3 text-accent" />
              <Copy v-else class="size-3" />
              {{ copied === 'frontmatter' ? t('panel.command.copied') : t('panel.command.copyFrontmatter') }}
            </Button>
          </div>
          <!-- 名称 -->
          <div v-if="skill.name" class="group flex items-start gap-2.5 border-b border-border px-3 py-1.5">
            <span class="w-7 shrink-0 pt-0.5 text-[length:var(--text-2xs)] text-neutral-dim">{{ t('panel.command.metaName') }}</span>
            <span class="min-w-0 flex-1 break-all font-mono text-[length:var(--text-xs)] text-neutral-fg">{{ skill.name }}</span>
            <Button
              variant="ghost"
              class="size-6 shrink-0 p-0 opacity-0 group-hover:opacity-100"
              :class="{ '!opacity-100': copied === 'name' }"
              :title="t('panel.command.metaName')"
              @click="copy(skill.name, 'name')"
            >
              <Check v-if="copied === 'name'" class="size-3.5 text-accent" />
              <Copy v-else class="size-3.5 text-neutral-dim" />
            </Button>
          </div>
          <!-- 路径 -->
          <div v-if="skill.sourcePath" class="group flex items-start gap-2.5 border-b border-border px-3 py-1.5">
            <span class="w-7 shrink-0 pt-0.5 text-[length:var(--text-2xs)] text-neutral-dim">{{ t('panel.command.path') }}</span>
            <span class="min-w-0 flex-1 break-all font-mono text-[11.5px] text-neutral-mid">{{ skill.sourcePath }}</span>
            <Button
              variant="ghost"
              class="size-6 shrink-0 p-0 opacity-0 group-hover:opacity-100"
              :class="{ '!opacity-100': copied === 'path' }"
              :title="t('panel.command.path')"
              @click="copy(skill.sourcePath, 'path')"
            >
              <Check v-if="copied === 'path'" class="size-3.5 text-accent" />
              <Copy v-else class="size-3.5 text-neutral-dim" />
            </Button>
          </div>
          <!-- 描述（长描述折叠/展开） -->
          <div v-if="skill.description" class="group flex items-start gap-2.5 px-3 py-1.5">
            <span class="w-7 shrink-0 pt-0.5 text-[length:var(--text-2xs)] text-neutral-dim">{{ t('panel.command.metaDesc') }}</span>
            <div class="min-w-0 flex-1">
              <p class="break-words text-[length:var(--text-xs)] leading-[1.55] text-neutral-mid" :class="{ 'line-clamp-2': !descExpanded }">{{ skill.description }}</p>
              <Button
                v-if="descNeedsClamp"
                variant="ghost"
                class="h-5 px-0 text-[length:var(--text-2xs)] text-neutral-mid"
                @click="descExpanded = !descExpanded"
              >{{ descExpanded ? t('panel.command.collapse') : t('panel.command.expand') }}</Button>
            </div>
            <Button
              variant="ghost"
              class="size-6 shrink-0 p-0 opacity-0 group-hover:opacity-100"
              :class="{ '!opacity-100': copied === 'desc' }"
              :title="t('panel.command.metaDesc')"
              @click="copy(skill.description, 'desc')"
            >
              <Check v-if="copied === 'desc'" class="size-3.5 text-accent" />
              <Copy v-else class="size-3.5 text-neutral-dim" />
            </Button>
          </div>
        </div>
        <!-- 正文：剥掉 frontmatter 后的 SKILL.md，正常 markdown 渲染。
             [RD-2#3/#4] 四态拆分：content→markdown / loading→加载行（切换命令即清正文，
             请求期间不残留上一文档内容——头部已新条目而正文旧内容 = 串内容误读）/
             failed→显式失败（含绝对路径，区别于「无文档正文」空态；绝对路径可打开所在目录，
             复用 reveal-in-folder IPC）/ loaded 空 body→「无文档正文」 -->
        <MarkdownRenderer v-if="skill.content" key="skill-content" :content="skill.content" :session-id="sessionId ?? undefined" />
        <div
          v-else-if="skillLoadState === 'loading'"
          data-testid="command-doc-loading"
          class="flex items-center justify-center gap-1.5 py-6 text-[length:var(--text-xs)] text-neutral-dim"
        >
          <Loader2 class="size-3 animate-spin" aria-hidden="true" />
          {{ t('panel.command.loading') }}
        </div>
        <div
          v-else-if="skillLoadState === 'failed'"
          data-testid="command-doc-load-failed"
          role="alert"
          class="mb-2 flex flex-wrap items-center gap-2 rounded-sm border border-hairline bg-bg-input px-2.5 py-2"
        >
          <span class="min-w-0 flex-1 break-all text-[length:var(--text-2xs)] leading-relaxed text-neutral-faint">
            {{ t('panel.command.loadFailed') }}<span class="font-mono">{{ skill.sourcePath }}</span>
          </span>
          <Button
            v-if="revealableSkillPath"
            variant="ghost"
            size="sm"
            class="h-5 shrink-0 gap-1 px-1.5 text-[length:var(--text-2xs)] text-neutral-dim"
            data-testid="command-doc-open-dir"
            @click="onRevealSkillDir"
          >
            <FolderOpen class="size-3" aria-hidden="true" />
            {{ t('panel.command.openDir') }}
          </Button>
        </div>
        <div v-else class="py-6 text-center text-[length:var(--text-xs)] text-neutral-dim">{{ t('panel.command.noDocBody') }}</div>
      </template>
      <!-- 非 skill 命令：信息卡 -->
      <div v-else class="flex h-full flex-col items-start gap-2 py-2">
        <p v-if="command.description" class="text-[length:var(--text-sm)] leading-[1.6] text-neutral-fg">{{ command.description }}</p>
        <p v-else class="text-[length:var(--text-xs)] text-neutral-dim">{{ t('panel.command.noDescription') }}</p>
        <p class="mt-1 text-[length:var(--text-2xs)] text-neutral-dim">
          {{ command.kind === 'extension' ? t('panel.command.commandType') : command.kind === 'builtin' ? t('panel.command.builtinCommand') : t('panel.command.title') }}，
          {{ t('panel.command.noFullDoc') }}。
        </p>
      </div>
    </div>
  </section>
  <!-- 无选中命令 → 空态（SideDrawer v-else 兜底，此处理论上不达，但防御性保留） -->
  <div v-else class="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
    <p class="text-[length:var(--text-xs)] text-neutral-dim">{{ t('panel.sideDrawer.noDoc') }}</p>
    <p class="text-[length:var(--text-2xs)] text-neutral-dim opacity-50">{{ t('panel.sideDrawer.docHint') }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, provide, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Wrench, Copy, Check, FolderOpen, Loader2 } from '@lucide/vue'
import type { Component } from 'vue'
import { useCommandStore } from '@/composables/features/command/useCommandStore'
import { getSettingsStore } from '@taiji/core'
import { useSideDrawer } from '@/composables/features/drawer/useSideDrawer'
import { SLASH_ICON_COMPONENTS } from '@/composables/slashIcons'
import * as fileApi from '@taiji/core/transport/api/domains/file'
import { useChatViewDeps } from '@/composables/panel/useChatViewDeps'
import { useCopy } from '@/composables/panel/useCopy'
import { useToast } from '@/composables/useToast'
import { isAbsolutePath } from '@/lib/path-utils'
import { revealInFolder } from '@/lib/ipc'
// [w6 chat-ui-and-shell T7] MarkdownRenderer 迁 ui 包（经 ChatViewDeps inject 消费 renderMarkdown）
import { MarkdownRenderer, ChatViewDepsKey } from '@taiji/ui'
import { Button } from '@/components/ui/button'

const { t } = useI18n()
const { error: toastError } = useToast()

const props = defineProps<{
  /** drawer 所属 panel 的 session（查 commandStore + file.read cwd 守门用） */
  sessionId: string | null
}>()

// [w6 T6] ui MarkdownRenderer 经 ChatViewDeps inject 消费壳层依赖。CommandDocPanel 不在 MessageStream
// provide 作用域内（走 DrawerPanel，与 DetailPane 同级），须自行 provide——否则子 MarkdownRenderer
// setup 调 useChatViewDeps() inject 缺失抛错（description + content 两个 MR 都会崩）。与 DetailPane:283 同范式。
// sessionId 可为 null，coalesce '' 后 renderMarkdown 无路径链接降级（安全）。
provide(ChatViewDepsKey, useChatViewDeps(computed(() => props.sessionId ?? '')))

const commandStore = useCommandStore()
const settings = getSettingsStore()
const { selectedCommandName } = useSideDrawer()

/** 当前选中的 SessionCommand（从 commandStore 查） */
const command = computed(() => {
  const name = selectedCommandName.value
  const sid = props.sessionId
  if (!name || !sid) return null
  // 如果是 /skill:xxx 格式，构造虚拟命令对象（无 sourceInfo，走 settings.skills 兜底）
  if (name.startsWith('/skill:')) {
    const skillName = name.replace('/skill:', '')
    return {
      name: `/${skillName}`,
      kind: 'skill' as const,
      icon: 'star',
      description: undefined,
      sourceInfo: undefined,
    }
  }
  return commandStore.findCommandByName(sid, name) ?? null
})

/**
 * skill 命令判定 + SKILL.md 路径来源：
 * - source=skill 且 command.sourceInfo.path 存在 → 直接用（W2 透传，主路径）
 * - /skill:xxx 格式无 sourceInfo → 兜底从 settings.skills 查 sourcePath（向后兼容）
 * 非 skill 命令返回 null → 走信息卡分支。
 */
const skillPath = computed<string | null>(() => {
  const cmd = command.value
  if (!cmd || cmd.kind !== 'skill') return null
  // 优先用 pi 透传的 sourceInfo.path（含项目级 skill，解决 cwd 错位扫不到的问题）
  if (cmd.sourceInfo?.path) return cmd.sourceInfo.path
  // /skill:xxx 兜底：从 settings.skills 查（旧路径，sourceInfo 不可用时降级）
  const name = selectedCommandName.value
  if (name?.startsWith('/skill:')) {
    const skillName = name.replace('/skill:', '')
    return settings.skills.value.find((s) => s.name === skillName)?.sourcePath ?? null
  }
  const bareName = cmd.name.replace(/^\//, '')
  return settings.skills.value.find((s) => s.name === bareName)?.sourcePath ?? null
})

/** skill 描述：/skill:xxx 从 settings.skills 查，其余用 command.description */
const skillDescription = computed<string | undefined>(() => {
  const name = selectedCommandName.value
  if (name?.startsWith('/skill:')) {
    const skillName = name.replace('/skill:', '')
    return settings.skills.value.find((s) => s.name === skillName)?.description
  }
  return command.value?.description
})

/** skill content（异步从 SKILL.md 加载，已剥 frontmatter）。null = 未加载/加载失败。 */
const skillContent = ref<string | null>(null)
/** SKILL.md 完整 frontmatter 块（---...---），元信息卡片「复制 frontmatter」用。null = 无 frontmatter 或未加载。 */
const skillFrontmatter = ref<string | null>(null)
/**
 * [RD-2#3/#4] SKILL.md 加载态四态：loading（请求在途，切换命令即进入——正文清空防串内容）/
 * loaded（读完，content 仍可能为空串 = 无文档正文）/ failed（两路守门均拒绝或读取异常，
 * 显式失败文案区别于「无文档正文」空态）/ idle（无 skill 路径）。
 */
const skillLoadState = ref<'idle' | 'loading' | 'loaded' | 'failed'>('idle')
/** 防重入标记：避免 watch 多次触发时并发发请求（竞态导致旧请求覆盖新结果） */
let loadingPath: string | null = null

/** 元信息卡片复制 + 反馈态（name/路径/description/frontmatter 各一个 key，copied===key 时切 Check 图标） */
const { copied, copy } = useCopy()
/** description 折叠阈值：超过此字符数显示展开/收起按钮（line-clamp-2 截断） */
const DESC_CLAMP_THRESHOLD = 80
/** description 折叠态：长描述（超过 DESC_CLAMP_THRESHOLD）默认折叠 2 行，点击展开/收起。切换 skill 重置为折叠 */
const descExpanded = ref(false)
const descNeedsClamp = computed(() => (skillDescription.value?.length ?? 0) > DESC_CLAMP_THRESHOLD)

/**
 * 解析 SKILL.md 开头的 YAML frontmatter 块（--- ... ---）。
 * 返回 { frontmatter: 完整 ---...--- 块（元信息卡片「复制 frontmatter」用）， body: 剥掉后的正文 }。
 * frontmatter 是元数据（name/description/triggers），若不剥会被 MarkdownRenderer 当正文渲染：
 * ---→分割线、key:value→段落，整块元数据泄漏成正文。正则锚定 ^---，正文里的 --- 不会误伤；无 frontmatter 原样返回。
 */
function parseFrontmatter(content: string): { frontmatter: string | null; body: string } {
  const m = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return m ? { frontmatter: m[0], body: content.slice(m[0].length) } : { frontmatter: null, body: content }
}

/**
 * 读 SKILL.md：先带 sessionId 走 cwd 守门（项目级 skill 在 cwd 下），
 * 失败（out_of_cwd）再不带 sessionId 走白名单（全局 skill 如 ~/.agents/skills）。
 * 两条守门都不绕过，任一通过即读到。
 */
async function loadSkillContent(path: string): Promise<void> {
  if (!path || loadingPath === path) {
    if (!path) {
      skillContent.value = null
      skillFrontmatter.value = null
      skillLoadState.value = 'idle'
    }
    return
  }
  loadingPath = path
  skillLoadState.value = 'loading'
  try {
    const sid = props.sessionId ?? undefined
    const result = sid
      ? await fileApi.read(path, sid).catch(() => fileApi.read(path))
      : await fileApi.read(path)
    // 防竞态：异步期间用户已切到别的命令，丢弃本次结果。解析 frontmatter：body 给正文渲染，frontmatter 给元信息卡片复制
    if (loadingPath === path) {
      const { frontmatter, body } = parseFrontmatter(result.content)
      skillContent.value = body
      skillFrontmatter.value = frontmatter
      skillLoadState.value = 'loaded'
    }
  } catch (e) {
    // [RD-2#3] 两路守门均拒绝（路径既不在 cwd 下也不在白名单）或读取异常：留日志（带 path）
    // + 显式失败态——不再并入「无文档正文」空态（用户无法区分「文档坏了」与「没写文档」）
    console.warn(`[command-doc-panel] SKILL.md 读取失败（${path}）:`, e)
    if (loadingPath === path) {
      skillContent.value = null
      skillFrontmatter.value = null
      skillLoadState.value = 'failed'
    }
  } finally {
    if (loadingPath === path) loadingPath = null
  }
}

// skillPath 变化（切换命令）重新加载 SKILL.md；[RD-2#4] 切换即同步清正文 + 进 loading 态
// （请求期间头部已是新条目，残留上一文档正文 = 串内容误读）
watch(
  skillPath,
  (path) => {
    descExpanded.value = false
    if (path) {
      skillContent.value = null
      skillFrontmatter.value = null
      skillLoadState.value = 'loading'
      void loadSkillContent(path)
    } else {
      skillContent.value = null
      skillFrontmatter.value = null
      skillLoadState.value = 'idle'
    }
  },
  { immediate: true },
)

/** skill 渲染对象（合并 name/sourcePath/content/description/frontmatter 供模板用） */
const skill = computed(() => {
  if (!skillPath.value) return null
  return {
    name: command.value?.name.replace(/^\//, '') ?? '',
    sourcePath: skillPath.value,
    content: skillContent.value,
    description: skillDescription.value,
    frontmatter: skillFrontmatter.value,
  }
})

/** source 标签：skill→「Skill」、extension→「Extension」、builtin→「内置」 */
const sourceLabel = computed(() => {
  const kind = command.value?.kind
  if (kind === 'skill') return 'Skill'
  if (kind === 'extension') return 'Extension'
  if (kind === 'builtin') return t('panel.command.builtin')
  return kind ?? ''
})

/** chip/命令 icon → lucide 组件（复用 SLASH_ICON_COMPONENTS，与选择框/chip 同源） */
const iconComponent = computed<Component>(() => {
  const iconKey = command.value?.icon
  return (
    (iconKey ? SLASH_ICON_COMPONENTS[iconKey as keyof typeof SLASH_ICON_COMPONENTS] : undefined) ??
    Wrench
  )
})

// ── [RD-2#3] 失败态「打开所在目录」动作（复用既有 reveal-in-folder IPC 机制，与
//    TraceInspector 损坏行恢复指引同款；~ 前缀路径 renderer 无 homedir 不展开，不给出动作）──
const revealableSkillPath = computed(() => {
  const p = skillPath.value
  return p !== null && isAbsolutePath(p) && !p.startsWith('~')
})

function onRevealSkillDir(): void {
  const p = skillPath.value
  if (p === null) return
  void revealInFolder(p).catch((e: unknown) => {
    toastError(t('panel.command.revealFailed'))
    console.error('[command-doc-panel] reveal-in-folder failed:', e)
  })
}
</script>
