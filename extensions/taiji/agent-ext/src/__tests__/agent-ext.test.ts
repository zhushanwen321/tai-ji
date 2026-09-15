/**
 * index.ts wiring SDK 契约测试（round3 review：替换占位测试）。
 *
 * 复用 system-prompt-trace index-wiring.test.ts 的 Proxy 假体模式：
 * - pi 用 Proxy 假体：捕获 registerCommand 注册的命令定义 + appendEntry 落点
 * - ctx 只需 index.ts 实际消费的字段（reload / getSystemPrompt），
 *   以 ExtensionCommandContext 最小形状驱动 handler（SDK 双参契约 (args, ctx)）
 * - index.ts 对 @earendil-works/pi-coding-agent 是 type-only import（运行时擦除），
 *   无需 vi.mock SDK 模块
 *
 * 锚定两命令注册面 + handler 行为：
 * - __taiji_reload__（host 触发的 skill/extension 重载内部命令）→ ctx.reload()
 * - __taiji_get_system_prompt__（Trace 视图「现取当前值」通道）→ pi.appendEntry
 *   写 taiji:current-system-prompt custom entry（fullText/charCount/fetchedAt 形状）
 *
 * [HISTORICAL] session tree 导航命令（旧品牌时期命名）及其测试随命令删除一并移除
 * （2026-08-31，桥接对端 runtime 消费端已在 monorepo 时代删除）。
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
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
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

/** ctx 假体（index.ts 实际消费：reload / getSystemPrompt；vi.fn 捕获调用）。 */
function createCtx(prompt = "current system prompt"): {
  ctx: ExtensionCommandContext;
  reload: ReturnType<typeof vi.fn>;
  getSystemPrompt: ReturnType<typeof vi.fn>;
} {
  const reload = vi.fn();
  const getSystemPrompt = vi.fn(() => prompt);
  const ctx = {
    cwd: "/home/user/project",
    reload,
    getSystemPrompt,
  } as unknown as ExtensionCommandContext;
  return { ctx, reload, getSystemPrompt };
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
  it("注册恰好两个命令（__taiji_reload__ / __taiji_get_system_prompt__），各带非空 description", async () => {
    const ext = await loadExtension();
    const h = createWiringHarness();
    ext(h.pi);
    expect([...h.commands.keys()].sort()).toEqual([
      "__taiji_get_system_prompt__",
      "__taiji_reload__",
    ]);
    for (const def of h.commands.values()) {
      expect(typeof def.description).toBe("string");
      expect(def.description.length).toBeGreaterThan(0);
      expect(typeof def.handler).toBe("function");
    }
  });

  it("__taiji_reload__ handler → 调 ctx.reload()（host 触发的 skill/extension 重载，无参）", async () => {
    const ext = await loadExtension();
    const h = createWiringHarness();
    ext(h.pi);
    const { ctx, reload } = createCtx();
    await runCommand(h, "__taiji_reload__", "", ctx);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledWith();
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
});
