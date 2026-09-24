/**
 * taiji extension for Pi — internal commands for the host.
 *
 * Registers `/__taiji_get_system_prompt__` for the Trace
 * view fetch-current button.
 *
 * [HISTORICAL] The former session tree navigation command was removed
 * (2026-08-31): its bridge consumer on the runtime side was deleted in the
 * monorepo era, so the command had no reachable caller. See the ADR-0008
 * note in the retired-decisions genealogy of docs/adr/decisions.md for the
 * original design.
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
}
