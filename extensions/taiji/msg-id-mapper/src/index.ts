/**
 * Client UUID ↔ user entry ID mapping extension for Pi.
 *
 * Establishes clientUuid ↔ userEntryId mapping for taiji session metadata
 * preservation across sessions.
 *
 * Mechanism (no pi source modification, pure extension hooks):
 *  1. taiji appends HTML comment marker `<!--taiji:msg:<uuid>-->` to prompt text
 *     (uuid is the full user message id from appendUser, formatted as `u-<36hex>`).
 *  2. `input` hook intercepts prompts with source==='rpc', strips the marker
 *     (LLM doesn't see the transformed content beyond the transform), and stores
 *     the uuid in pendingClientUuid.
 *  3. After user `message_end`, the next triggered hook (message_start/turn_end/agent_end)
 *     reads `ctx.sessionManager.getLeafId()` which now returns the persisted userEntryId.
 *  4. `pi.appendEntry("taiji.client-msg-id", {clientUuid, userEntryId})` writes the mapping
 *     into pi JSONL (CustomEntry, not in LLM context).
 *
 * Mapping is automatically preserved with fork/clone (in the same JSONL).
 * When taiji reopens a session, it scans customType==="taiji.client-msg-id" entries
 * to rebuild the mapping table.
 *
 * Degradation strategy: any hook error → pi runner's try/catch swallows it,
 * mapping is missing, and taiji degrades to textToSegments (split by plain text).
 * Missing mapping doesn't affect the agent main flow.
 *
 * Same package shape as @zhushanwen/pi-system-prompt (extensions/taiji/system-prompt/):
 * TypeScript source with no build step, bundled as a builtin extension by
 * scripts/bundle-extensions.mjs. Runtime dependency: @zhushanwen/pi-extension-logger
 * (inlined into the builtin bundle at bundle time; pi remains a peer dep).
 */

import type { ExtensionAPI, ExtensionContext, InputEvent, MessageEndEvent, MessageStartEvent, TurnEndEvent, AgentEndEvent } from '@earendil-works/pi-coding-agent'
import { getLogger } from '@zhushanwen/pi-extension-logger'

const logger = getLogger('taiji-client-msg-id-mapper')

// uuid = appendUser 生成的 user message id（`u-` + 36 字符 hex uuid，共 38 字符）。
// 与 shared SegmentsMetadataEntry.clientUuid 严格一致（同 appendUser 返回值）：
// extension 写入 custom entry 的 clientUuid = segments.json 的 clientUuid key，
// entry-tree-builder 据此精确回填 segments（无前缀转换、无双 source of truth）。
//
// m1 修复：拆两个正则。TAG_MATCH 非全局，用于 .match 提取第一个 uuid 捕获组（input hook
// 只需首个 pending uuid）；TAG_STRIP 全局，用于 .replace 剥离所有残留标记（防并发/重试
// 场景多个标记拼接在同一 prompt 末尾时只剥掉第一个）。两正则分离避免 g 标志的 lastIndex
// 状态污染（String.match 与全局 exec 混用易踩坑）。
// [双侧同构字面量] 标记格式 SSOT = 本文件（marker 由 taiji 发送侧注入、本扩展剥离）：
// runtime 侧 clientUuid 提取正则（原 message-dispatcher.publishSkillNotices，A2 后随
// 编排提取迁至 skill-notice-publisher.ts 的 MSG_ID_TAG_RE）与本文件同构字面量，
// 两侧禁单侧修改（收敛 shared 不可行——extension 独立发布体系不依赖 @taiji/shared）。
const TAG_MATCH = /<!--taiji:msg:(u-[0-9a-fA-F-]{36})-->/
const TAG_STRIP = /<!--taiji:msg:u-[0-9a-fA-F-]{36}-->/g
const ENTRY_TYPE = 'taiji.client-msg-id'

/** 提取 prompt 里首个标记的 client uuid；无标记 → undefined。 */
function extractClientUuid(text: string): string | undefined {
  return text.match(TAG_MATCH)?.[1]
}

export default function (pi: ExtensionAPI): void {
  // 待处理的 client uuid（input hook 抓到标记后写入，flush 后清空）。
  let pendingClientUuid: string | undefined = undefined
  // user message 已 message_end、等待 flush（拿到 leafId 后写映射）。
  let awaitingUserPersist = false

  // input hook：拦截 taiji 发来的 prompt（source === 'rpc'），剥离标记。
  // 非 rpc（interactive/extension）输入不含标记，直接 continue。
  pi.on('input', (event: InputEvent) => {
    try {
      if (event.source !== 'rpc') return { action: 'continue' as const }
      const clientUuid = extractClientUuid(event.text)
      if (!clientUuid) return { action: 'continue' as const }
      pendingClientUuid = clientUuid
      // transform 后 LLM 看到的是剥离了标记的纯文本。
      // TAG_STRIP 全局替换：防多个标记残留时只剥掉第一个（m1 修复）。
      return { action: 'transform' as const, text: event.text.replace(TAG_STRIP, '').trimEnd() }
    } catch (err) {
      // 吞错，不阻断主流程（pi runner 也会 try/catch，但显式兜底避免意外 return）。
      logger.error('input hook error', { detail: String(err) })
      return undefined
    }
  })

  // message_end：user message 持久化前触发。此时 getLeafId() 还指向上一条 entry
  // （user message 尚未落盘），所以只置 flag，真正 flush 在下一个 hook。
  pi.on('message_end', (event: MessageEndEvent) => {
    try {
      if (event.message.role === 'user' && pendingClientUuid) {
        awaitingUserPersist = true
      }
    } catch (err) {
      // best-effort：置 flag 失败不阻断消息流——仅丢失该条 clientUuid↔entryId 映射，对话不受影响。
      logger.error('message_end hook error', { detail: String(err) })
    }
    return undefined
  })

  /** 写映射并清空 pending 状态。leafId 未就绪时静默返回，等下一个 hook 重试。 */
  const writeMapping = (ctx: ExtensionContext): void => {
    if (!pendingClientUuid) return
    // 类型已保证 sessionManager.getLeafId 必有（pi 0.84.4 ReadonlySessionManager，
    // 返回 string | null）；运行时异常由 flush 的 catch 兜底。
    const userEntryId = ctx.sessionManager.getLeafId()
    if (!userEntryId) return // leafId 还没更新，等下一个 hook
    pi.appendEntry(ENTRY_TYPE, {
      clientUuid: pendingClientUuid,
      userEntryId,
    })
    pendingClientUuid = undefined
    awaitingUserPersist = false
  }

  // flush：读 getLeafId()（= userEntryId，user message 已持久化）+ appendEntry 写映射。
  // 幂等：写完即清空 pendingClientUuid / awaitingUserPersist，重复触发无副作用。
  const flush = (ctx: ExtensionContext): void => {
    if (!awaitingUserPersist) return
    try {
      writeMapping(ctx)
    } catch (err) {
      // best-effort：映射写入失败不阻断消息流——丢的是本条映射，下次 hook 会因 flag 未清而幂等重试。
      logger.error('flush error', { detail: String(err) })
    }
  }

  // 三重安全网：user message_end 后第一个触发的 hook 拿到的 leafId 才是 userEntryId。
  // message_start（assistant 开始，此时 user message 已落盘）—— 主路径。
  pi.on('message_start', (_event: MessageStartEvent, ctx: ExtensionContext) => flush(ctx))
  // turn_end / agent_end 兜底（abort 等场景 message_start 可能不来）。
  pi.on('turn_end', (_event: TurnEndEvent, ctx: ExtensionContext) => flush(ctx))
  pi.on('agent_end', (_event: AgentEndEvent, ctx: ExtensionContext) => flush(ctx))
}