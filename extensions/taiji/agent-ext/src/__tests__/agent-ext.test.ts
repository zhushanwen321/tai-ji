/**
 * index.ts wiring SDK 契约测试（round3 review：替换占位测试）。
 *
 * 复用 system-prompt-trace index-wiring.test.ts 的 Proxy 假体模式：
 * - pi 用 Proxy 假体：捕获 registerCommand 注册的命令定义 + appendEntry 落点
 * - ctx 只需 index.ts 实际消费的字段（getSystemPrompt / navigateTree），
 *   以 ExtensionCommandContext 最小形状驱动 handler（SDK 双参契约 (args, ctx)）
 * - index.ts 对 @earendil-works/pi-coding-agent 是 type-only import（运行时擦除），
 *   无需 vi.mock SDK 模块
 *
 * 锚定两命令注册面 + handler 行为：
 * - __taiji_get_system_prompt__（Trace 视图「现取当前值」通道）→ pi.appendEntry
 *   写 taiji:current-system-prompt custom entry（fullText/charCount/fetchedAt 形状）
 * - __taiji_nav__（消息撤回信令，ADR-0076 D1）→ handler 以显式 await 把
 *   ctx.navigateTree(entryId, {summarize:false, label:'taiji:revoked'}) 的 promise
 *   纳入自身返回链——写法契约判别断言（deferred sentinel 时序判别）：handler 返回
 *   promise（非 undefined）且其 settle 严格晚于 navigateTree 的 sentinel settle
 *   （fire-and-forget 花括号体：同步体返回 undefined / async 无 await 体先 settle，
 *   两违禁形态均在断言处红）
 *
 * [HISTORICAL] session tree 导航命令（旧品牌时期命名）及其测试随命令删除一并移除
 * （2026-08-31，桥接对端 runtime 消费端已在 monorepo 时代删除）；随消息撤回设计
 * （ADR-0076）以 __taiji_nav__ 形态回归，本文件同步锚定其注册面与写法契约。
 * [HISTORICAL] __taiji_reload__ 及其测试随 W5 skill 变更→pi reload 编排退役一并移除
 * （2026-09-25，消费端已 D7 切源 taiji SkillRegistry，pi 侧列表滞后归 ADR-0050 降级）。
 *
 * 运行：cd extensions/taiji/agent-ext && npx vitest run
 */
import { describe, it, expect, vi } from "vitest";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

interface RecordedCommand {
  description: string;
  handler: (
    args: string,
    ctx: ExtensionCommandContext,
  ) => Promise<unknown> | void;
}

interface RecordedEntry {
  customType: string;
  data: unknown;
}

interface WiringHarness {
  pi: ExtensionAPI;
  commands: Map<string, RecordedCommand>;
  entries: RecordedEntry[];
}

/** Proxy 假体 pi：捕获 registerCommand 注册面与 appendEntry 落点（其余成员 no-op）。 */
function createWiringHarness(): WiringHarness {
  const commands = new Map<string, RecordedCommand>();
  const entries: RecordedEntry[] = [];
  const pi = new Proxy<ExtensionAPI>({} as ExtensionAPI, {
    get(_target: unknown, prop: string | symbol): unknown {
      if (prop === "registerCommand") {
        return (name: string, def: RecordedCommand): void => {
          commands.set(name, def);
        };
      }
      if (prop === "appendEntry") {
        return (customType: string, data?: unknown): void => {
          entries.push({ customType, data });
        };
      }
      return (): void => undefined;
    },
  });
  return { pi, commands, entries };
}

/** ctx 假体（index.ts 实际消费：getSystemPrompt / navigateTree；vi.fn 捕获调用）。 */
function createCtx(prompt = "current system prompt"): {
  ctx: ExtensionCommandContext;
  getSystemPrompt: ReturnType<typeof vi.fn>;
  navigateTree: ReturnType<typeof vi.fn>;
} {
  const getSystemPrompt = vi.fn(() => prompt);
  const navigateTree = vi.fn(() => Promise.resolve({ cancelled: false }));
  const ctx = {
    cwd: "/home/user/project",
    getSystemPrompt,
    navigateTree,
  } as unknown as ExtensionCommandContext;
  return { ctx, getSystemPrompt, navigateTree };
}

/** 以 SDK 双参契约 (args, ctx) 驱动已注册命令 handler。 */
async function runCommand(
  h: WiringHarness,
  name: string,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const cmd = h.commands.get(name);
  if (cmd === undefined) throw new Error(`command "${name}" not registered`);
  await cmd.handler(args, ctx);
}

/** 加载默认导出工厂（wiring 入口）。 */
async function loadExtension(): Promise<(pi: ExtensionAPI) => void> {
  const mod = await import("../index.js");
  return mod.default;
}

describe("index.ts wiring SDK 契约", () => {
  it("注册恰好两个命令（__taiji_get_system_prompt__ / __taiji_nav__），各带非空 description", async () => {
    const ext = await loadExtension();
    const h = createWiringHarness();
    ext(h.pi);
    expect([...h.commands.keys()].sort()).toEqual([
      "__taiji_get_system_prompt__",
      "__taiji_nav__",
    ]);
    for (const def of h.commands.values()) {
      expect(typeof def.description).toBe("string");
      expect(def.description.length).toBeGreaterThan(0);
      expect(typeof def.handler).toBe("function");
    }
  });

  it("__taiji_get_system_prompt__ → appendEntry 写 taiji:current-system-prompt（fullText/charCount/fetchedAt 形状，不写其他 customType）", async () => {
    const ext = await loadExtension();
    const h = createWiringHarness();
    ext(h.pi);
    const prompt = "prompt body\nline-1";
    const { ctx, getSystemPrompt } = createCtx(prompt);
    await runCommand(h, "__taiji_get_system_prompt__", "", ctx);

    expect(getSystemPrompt).toHaveBeenCalledTimes(1);
    expect(h.entries).toHaveLength(1);
    expect(h.entries[0]?.customType).toBe("taiji:current-system-prompt");
    const data = h.entries[0]?.data as Record<string, unknown>;
    expect(data.fullText).toBe(prompt);
    expect(data.charCount).toBe(prompt.length);
    // fetchedAt = new Date().toISOString()（动态值，断言 ISO 可解析形状）
    expect(typeof data.fetchedAt).toBe("string");
    expect(Number.isNaN(Date.parse(String(data.fetchedAt)))).toBe(false);
  });

  it("__taiji_nav__ → 调 ctx.navigateTree 参数三件套逐字（entryId 直传 / summarize:false / label:'taiji:revoked'）", async () => {
    const ext = await loadExtension();
    const h = createWiringHarness();
    ext(h.pi);
    const { ctx, navigateTree } = createCtx();
    await runCommand(h, "__taiji_nav__", "msg-entry-1", ctx);

    expect(navigateTree).toHaveBeenCalledTimes(1);
    expect(navigateTree).toHaveBeenCalledWith("msg-entry-1", {
      summarize: false,
      label: "taiji:revoked",
    });
  });

  it("__taiji_nav__ handler 把 navigateTree 的 promise 纳入自身返回链（D1 写法契约判别：返回 promise 非 undefined 且 settle 严格晚于 navigateTree——非 fire-and-forget）", async () => {
    const ext = await loadExtension();
    const h = createWiringHarness();
    ext(h.pi);
    // deferred sentinel：可控 resolve 时点。写法契约（D1）：pi `await command.handler(...)`
    // 接住的 promise 必须等待 navigateTree 完成——「revokeMessage reply 前树变更+落盘
    // 完成」的保证链。判别两违禁形态：①同步花括号体 fire-and-forget 返回 undefined；
    // ②async 无 await 体返回的 promise 先于 sentinel settle。
    // 注：SDK 0.84.4 RegisteredCommand.handler 钉死 Promise<void>，「直接 return
    // navigateTree promise」形态编译不过（TS2322），故 D1 许可形态为显式 await，判别
    // 断言用 settle 时序而非 promise 引用全等。
    let resolveNav!: (value: { cancelled: boolean }) => void;
    const sentinel = new Promise<{ cancelled: boolean }>((resolve) => {
      resolveNav = resolve;
    });
    const { ctx, navigateTree } = createCtx();
    navigateTree.mockReturnValue(sentinel);

    const cmd = h.commands.get("__taiji_nav__");
    if (cmd === undefined) throw new Error('command "__taiji_nav__" not registered');

    const returned = cmd.handler("msg-entry-2", ctx);
    // 违禁形态 ①：fire-and-forget 同步花括号体返回 undefined
    expect(returned).toBeInstanceOf(Promise);
    const returnedPromise = returned as Promise<unknown>;
    let handlerSettled = false;
    void returnedPromise.then(() => {
      handlerSettled = true;
    });
    // 泵微任务：给违禁形态 ②（async 无 await 体）让它的 promise 先 settle 的机会
    await Promise.resolve();
    await Promise.resolve();
    // sentinel 未 resolve 前，handler 的 promise 不得 settle——fire-and-forget 在此红
    expect(handlerSettled).toBe(false);

    resolveNav({ cancelled: false });
    await returnedPromise;
    expect(handlerSettled).toBe(true);
    expect(navigateTree).toHaveBeenCalledTimes(1);
    expect(navigateTree).toHaveBeenCalledWith("msg-entry-2", {
      summarize: false,
      label: "taiji:revoked",
    });
  });
});
