/**
 * taiji extension for Pi — internal commands for the host.
 *
 * Registers `/__taiji_get_system_prompt__` (Trace view fetch-current button)
 * and `/__taiji_nav__` (session tree rewind for message revoke).
 *
 * [HISTORICAL] The session tree navigation command was removed 2026-08-31:
 * its bridge consumer on the runtime side had been deleted, leaving the
 * command with no reachable caller (ADR-0008). It returns as `__taiji_nav__`
 * under the message-revoke design (ADR-0076, decision D1) — the runtime
 * revoke orchestration is the new consumer.
 * [HISTORICAL] `/__taiji_reload__` was removed (2026-09-25): the W5
 * skill-change→pi-reload orchestration was retired — slash menu and composer
 * injection resolve skills from the taiji SkillRegistry (D7 source switch),
 * so a full pi reload (extension ctx invalidate + clearExtensionCache, which
 * broke background-task completion notifications in the stale module world)
 * bought nothing but stale-pi-side lists, accepted per ADR-0050 degradation.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  // [fetch-current-system-prompt] Trace 视图「现取当前值」通道（session-trace design §3.1
  // 失败路径 / D2）：pi RPC 无 get_system_prompt 命令、getSystemPrompt() 只在 extension
  // API，且现取不能依赖可禁的留痕包（system-prompt-trace 是 feature tier）——挂本
  // infrastructure 包（builtin 不可禁）。host 经 client.prompt 发 /__taiji_get_system_prompt__
  // （双下划线 = 内部命令，前端过滤 /__ 前缀不显示），handler 取当前 system prompt 写
  // taiji:current-system-prompt custom entry（不进 LLM context，零模型侧影响——pi
  // sessionEntryToContextMessages 对 type=custom 落入末尾 return []，session-manager.ts:383-413），
  // runtime 轮询 get_entries(since) 拉到后返回前端（同条 entry 也会作为 DATA 行出现在 trace
  // 台账里，留下取值痕迹）。
  pi.registerCommand("__taiji_get_system_prompt__", {
    description:
      "Internal: append a custom entry with the current system prompt (host-initiated for the Trace view fetch-current button)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const fullText = ctx.getSystemPrompt();
      pi.appendEntry("taiji:current-system-prompt", {
        fullText,
        charCount: fullText.length,
        fetchedAt: new Date().toISOString(),
      });
    },
  });

  // [message-revoke D1] 已消费层（消息已注入模型上下文）撤回信令：runtime 撤回编排经
  // 系统信令入口直达 client.prompt('/__taiji_nav__ <entryId>')——command 同步执行、
  // 不进模型、无 turn（pi agent-session _tryExecuteExtensionCommand）。entryId 从命令
  // args 取（pi 切首个空格后的原样余串，单空格形态下精确等于 entryId）。
  // 双下划线前缀 = 内部命令（前端 internal-command-filter 过滤 `/__` 前缀不显示）。
  // summarize:false = 不触发 tree summary；label:'taiji:revoked' = pi 追加 LabelEntry
  // 落盘（树重放规则 leaf=文件尾，重启/空闲回收后回退不复活——pi-semantics PS-60 实锚：
  // dist/core/session-manager.js:673 _buildIndex 文件序循环置 leafId=entry.id、:616
  // _setSessionFile 加载路径重放；navigateTree 回退 = branch() 移指针 + appendLabelChange
  // 落锚文件尾两步，dist/core/agent-session.js:2464）。
  // 写法契约（D1 硬要求）：handler 必须把 navigateTree 的 promise 纳入自身返回链——
  // pi `await command.handler(...)` 接住返回值是「revokeMessage reply 前树变更+落盘
  // 完成」的保证链。取 D1 许可形态「显式 await」而非「直接 return」：SDK 0.84.4
  // RegisteredCommand.handler 钉死 `(args, ctx) => Promise<void>`，直接 return
  // navigateTree 的 `Promise<{cancelled}>` 编译不过（TS2322，as 断言亦被拒/禁）。
  // fire-and-forget（去掉 await）会使 reply 先于树变更，产生偶发假阴性 nav-failed——
  // 禁止。
  pi.registerCommand('__taiji_nav__', {
    description:
      'Internal: rewind the session tree to before the target entry (host-triggered for message revoke)',
    handler: async (entryId: string, ctx: ExtensionCommandContext) => {
      await ctx.navigateTree(entryId, { summarize: false, label: 'taiji:revoked' });
    },
  });
}
