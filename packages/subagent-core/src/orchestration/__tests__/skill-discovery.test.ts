/**
 * skill-discovery — resolveSkillPath 结果缓存（IF8/#14）+ 搜索序测试。
 *
 * 现状该文件此前零测试，本文件为首个测试（design IF8 契约）：
 * - hit 不再 existsSync（计数 wrapper 观察，spyOn ESM namespace 不可配置的既有教训）
 * - 未命中 undefined 也缓存（不存在的名字二次调用零 stat）
 * - clearSkillPathCache 后重扫
 * - project 优先于 user/npm 的搜索序
 *
 * [merge 注] main 侧同名文件（mock-fs 版）的 5 用例语义均已覆盖：搜索序三用例
 * 同名等价；「npm 候选路径构造含 agentDir」= 本文件各用例断言 join(homeRoot,
 * ".pi/agent/npm/...") 完整路径 + npm 兜底用例的多包枚举；「全 miss undefined 含
 * readdirSync ENOENT 兜底」= 「未命中 undefined 也缓存」用例（homeRoot 无 npm 目录，
 * 真实 fs 下 ENOENT 由实现 catch）。mock 版被本集成版取代。
 *
 * 隔离：node:fs 的 existsSync 用 vi.mock 包一层计数（委托真实实现）；
 * skills 发现根经 HostServices.discoveryRoots 端口注入（u0-data-discovery 注入化后
 * 不再消费 pi SDK getAgentDir），每用例 resetCoreForTests + configureCore 假宿主，
 * 假宿主根清单按 pi-host.ts skillRoots 契约形状推导自 hoisted 临时 home；
 * process.cwd 用 spyOn。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureCore, resetCoreForTests } from "../../core/host-services.ts";

const { existsSyncCalls } = vi.hoisted(() => ({
  existsSyncCalls: { count: 0 },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const realExistsSync = actual.existsSync;
  // 计数 wrapper（委托真实实现）——vi.spyOn(fs, "existsSync") 在 ESM 模块
  // 命名空间不可配置（record-store-index.test.ts:419 同款教训），改用 mock 工厂。
  const countingExistsSync = ((p: string) => {
    existsSyncCalls.count++;
    return realExistsSync(p);
  }) as typeof actual.existsSync;
  return { ...actual, existsSync: countingExistsSync };
});

import { clearSkillPathCache, resolveSkillPath } from "../skill-discovery.ts";

// ── 临时目录工具 ──────────────────────────────────────────────

let projRoot: string;
let homeRoot: string;

beforeEach(() => {
  clearSkillPathCache();
  existsSyncCalls.count = 0;
  projRoot = mkdtempSync(join(tmpdir(), "skill-proj-"));
  homeRoot = mkdtempSync(join(tmpdir(), "skill-home-"));
  // 假宿主根清单 = pi-host.ts skillRoots() 契约形状（user-pi + npm 两根，
  // 每用例绑定当轮临时 home——discoveryRoots 每次调用现取，用例内改 homeRoot 即生效）
  const agentDir = join(homeRoot, ".pi", "agent");
  resetCoreForTests();
  configureCore({
    dataRoot: () => agentDir,
    log: () => {},
    discoveryRoots: () => ({
      skills: [
        { dir: join(agentDir, "skills"), source: "user-pi" },
        { dir: join(agentDir, "npm", "node_modules"), source: "npm" },
      ],
    }),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetCoreForTests();
  rmSync(projRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  rmSync(homeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** mkdir -p（目录存在即 resolveSkillPath 命中——检查的是目录而非 SKILL.md）。 */
function mkdirp(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

describe("resolveSkillPath — 搜索序（project > user > npm）", () => {
  it("project 优先：同名 skill 同时存在于 project/user/npm 时返回 project 路径", () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(projRoot);
    const name = "dup-skill";
    mkdirp(join(projRoot, ".agents/skills", name));
    mkdirp(join(homeRoot, ".pi/agent/skills", name));
    mkdirp(join(homeRoot, ".pi/agent/npm/node_modules/some-pkg/skills", name));

    const resolved = resolveSkillPath(name);

    expect(resolved).toBe(join(projRoot, ".agents/skills", name));
    expect(cwdSpy).toHaveBeenCalled();
  });

  it("user 次之：仅 user/npm 存在时返回 user 路径", () => {
    vi.spyOn(process, "cwd").mockReturnValue(projRoot);
    const name = "user-skill";
    mkdirp(join(homeRoot, ".pi/agent/skills", name));
    mkdirp(join(homeRoot, ".pi/agent/npm/node_modules/some-pkg/skills", name));

    expect(resolveSkillPath(name)).toBe(join(homeRoot, ".pi/agent/skills", name));
  });

  it("npm 兜底：仅 npm 包内存在时返回包内 skills 路径（readdirSync 枚举多包候选）", () => {
    vi.spyOn(process, "cwd").mockReturnValue(projRoot);
    const name = "npm-skill";
    // 两个包并存：断言实现枚举 npm/node_modules 下每个包（S-6 语义，防只查首个包的回退）
    mkdirp(join(homeRoot, ".pi/agent/npm/node_modules/pkg-a/other", "x"));
    mkdirp(join(homeRoot, ".pi/agent/npm/node_modules/some-pkg/skills", name));

    expect(resolveSkillPath(name)).toBe(
      join(homeRoot, ".pi/agent/npm/node_modules/some-pkg/skills", name),
    );
  });
});

describe("resolveSkillPath — 结果缓存（IF8/DM3）", () => {
  it("hit 不再 existsSync：二次调用零 stat", () => {
    vi.spyOn(process, "cwd").mockReturnValue(projRoot);
    const name = "cache-hit";
    const expected = join(projRoot, ".agents/skills", name);
    mkdirp(expected);

    const first = resolveSkillPath(name);
    const callsAfterFirst = existsSyncCalls.count;
    expect(first).toBe(expected);
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = resolveSkillPath(name);
    expect(second).toBe(expected);
    expect(existsSyncCalls.count).toBe(callsAfterFirst); // 零增量
  });

  it("未命中 undefined 也缓存：不存在的名字二次调用零 stat", () => {
    vi.spyOn(process, "cwd").mockReturnValue(projRoot);
    const name = "no-such-skill-foo";

    const first = resolveSkillPath(name);
    expect(first).toBeUndefined();
    const callsAfterFirst = existsSyncCalls.count;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = resolveSkillPath(name);
    expect(second).toBeUndefined();
    expect(existsSyncCalls.count).toBe(callsAfterFirst); // 零增量（未命中也缓存）
  });

  it("clearSkillPathCache 后重扫：计数恢复增长且结果一致", () => {
    vi.spyOn(process, "cwd").mockReturnValue(projRoot);
    const name = "cache-clear";
    const expected = join(projRoot, ".agents/skills", name);
    mkdirp(expected);

    expect(resolveSkillPath(name)).toBe(expected);
    const callsAfterFirst = existsSyncCalls.count;
    expect(callsAfterFirst).toBeGreaterThan(0);

    clearSkillPathCache();
    expect(resolveSkillPath(name)).toBe(expected);
    expect(existsSyncCalls.count).toBeGreaterThan(callsAfterFirst); // 重扫发生
  });
});

describe("resolveSkillPath — `..` 穿越守卫（三通道对称修复：skill 名是名字不是路径）", () => {
  it("project 源：含 .. 逃逸 skills 根的名字 → not found（即使逃逸目标真实存在）", () => {
    vi.spyOn(process, "cwd").mockReturnValue(projRoot);
    // 逃逸目标真实存在：projRoot/.agents/skills/../../escape-target = projRoot/escape-target。
    // 旧实现 path.resolve 吸收 .. 后 existsSync 命中 → 返回树外目录；守卫后必须 undefined。
    mkdirp(join(projRoot, "escape-target"));

    expect(resolveSkillPath("../../escape-target")).toBeUndefined();
  });

  it("user 源：含 .. 逃逸的名字 → not found（同样不受 existsSync 命中误导）", () => {
    vi.spyOn(process, "cwd").mockReturnValue(projRoot);
    // user skills 根 = homeRoot/.pi/agent/skills；../../escape-target → homeRoot/escape-target。
    mkdirp(join(homeRoot, "escape-target"));

    expect(resolveSkillPath("../../escape-target")).toBeUndefined();
  });

  it("npm 源：含 .. 逃逸包内 skills 根的名字 → not found", () => {
    vi.spyOn(process, "cwd").mockReturnValue(projRoot);
    // npm skills 根 = homeRoot/.pi/agent/npm/node_modules/pkg/skills；"../steal" 逃逸到 node_modules/<pkg>/steal。
    mkdirp(join(homeRoot, ".pi/agent/npm/node_modules/pkg-a/steal"));

    expect(resolveSkillPath("../steal")).toBeUndefined();
  });

  it("根内归一化不被误拒：sub/../real 解析后仍在 skills 根内，正常命中", () => {
    vi.spyOn(process, "cwd").mockReturnValue(projRoot);
    const real = join(projRoot, ".agents/skills", "real");
    mkdirp(real);

    // 守卫只拒逃逸，不拒归一化：root/sub/../real = root/real（根内）→ 命中。
    expect(resolveSkillPath("sub/../real")).toBe(real);
  });

  it("绝对路径形式的 skill 名 → not found（名字不具备绝对寻址能力）", () => {
    vi.spyOn(process, "cwd").mockReturnValue(projRoot);
    mkdirp(join(projRoot, "outside-abs"));

    // resolve(root, "/outside-abs") = /outside-abs —— 树外，拒。
    expect(resolveSkillPath(join(projRoot, "outside-abs"))).toBeUndefined();
  });
});
