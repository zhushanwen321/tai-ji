import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock 共享 logger：降级规格的 warn 留痕可 spy
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({
  getLogger: () => loggerMock,
  createLogger: () => loggerMock,
  setPiHandle: vi.fn(),
}));

// 对拍锚点直接用 node_modules 实装（pi 0.84.4 dist，AGENTS.md 语义断言约定）——
// 单根枚举的横切规则（frontmatter 门 / name 派生 / 递归）随 pi 实装走，本测试钉的是
// 跨根组装 / overrides / marker 过滤 / 降级四段共享包自身语义
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

import { detectExecSkills, hasPlanExecMarker, isEnabledByOverrides } from "../exec-skills.js";
import type { ExecSkill } from "../exec-skills.js";

/** SKILL.md 内容构造（frontmatter 字段按需） */
function skillMd(opts: {
  name?: string;
  description?: string;
  planExec?: boolean;
  disableModelInvocation?: boolean;
}): string {
  const lines = ["---"];
  if (opts.name !== undefined) lines.push(`name: ${opts.name}`);
  lines.push(`description: ${opts.description ?? "Execute development workflows."}`);
  if (opts.planExec) lines.push("plan-exec: true");
  if (opts.disableModelInvocation) lines.push("disable-model-invocation: true");
  lines.push("---", "", "# Skill body");
  return lines.join("\n");
}

/** 四根 fixture 世界：project（.git + 嵌套 cwd + .pi/skills）/ 祖先链 / agentDir / home */
function makeWorld(): { root: string; cwd: string; agentDir: string; homeDir: string } {
  const root = fs.mkdtempSync(join(tmpdir(), "exec-skills-"));
  const cwd = join(root, "proj", "packages", "lib");
  fs.mkdirSync(join(cwd, ".pi", "skills"), { recursive: true });
  fs.mkdirSync(join(root, "proj", ".git"), { recursive: true });
  fs.mkdirSync(join(root, "proj", "packages", ".agents", "skills"), { recursive: true });
  fs.mkdirSync(join(root, "proj", ".agents", "skills"), { recursive: true });
  const agentDir = join(root, "agent");
  fs.mkdirSync(join(agentDir, "skills"), { recursive: true });
  const homeDir = join(root, "home");
  fs.mkdirSync(join(homeDir, ".agents", "skills"), { recursive: true });
  return { root, cwd, agentDir, homeDir };
}

/** 在 dir 下建一个标准 SKILL.md 目录形态 skill（默认带 plan-exec marker） */
function writeSkill(dir: string, content = skillMd({ planExec: true })): string {
  fs.mkdirSync(dir, { recursive: true });
  const skillPath = join(dir, "SKILL.md");
  fs.writeFileSync(skillPath, content);
  return skillPath;
}

function rmWorld(root: string): void {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

let world: ReturnType<typeof makeWorld>;

beforeEach(() => {
  vi.clearAllMocks();
  world = makeWorld();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmWorld(world.root);
});

const detect = (overrides: Partial<Parameters<typeof detectExecSkills>[0]> = {}) =>
  detectExecSkills({
    cwd: world.cwd,
    trusted: true,
    agentDir: world.agentDir,
    homeDir: world.homeDir,
    ...overrides,
  });

const namesOf = (skills: ExecSkill[]) => skills.map((s) => s.name);

describe("detectExecSkills（发现：四根目录扫描，pi 本体加载集对齐）", () => {
  it("enumerates all four roots in pi order: .pi/skills → 祖先链(近→远) → agentDir → ~/.agents/skills", () => {
    writeSkill(join(world.cwd, ".pi", "skills", "lib-skill"));
    writeSkill(join(world.root, "proj", "packages", ".agents", "skills", "mid-skill"));
    writeSkill(join(world.root, "proj", ".agents", "skills", "root-skill"));
    writeSkill(join(world.agentDir, "skills", "agent-skill"));
    writeSkill(join(world.homeDir, ".agents", "skills", "home-skill"));

    const skills = detect();
    expect(namesOf(skills)).toEqual(["lib-skill", "mid-skill", "root-skill", "agent-skill", "home-skill"]);
    // skillEntryPath 数据通路：消费方指引的路径来源 = 入口文件路径（标准形态即 SKILL.md 路径）
    expect(skills[0].skillEntryPath).toBe(join(world.cwd, ".pi", "skills", "lib-skill", "SKILL.md"));
    expect(skills[0].description).toBe("Execute development workflows.");
  });

  it("untrusted skips the project family (.pi/skills + ancestor chain), still scans agentDir/home roots", () => {
    writeSkill(join(world.cwd, ".pi", "skills", "lib-skill"));
    writeSkill(join(world.root, "proj", ".agents", "skills", "root-skill"));
    writeSkill(join(world.agentDir, "skills", "agent-skill"));

    const skills = detect({ trusted: false });
    expect(namesOf(skills)).toEqual(["agent-skill"]);
  });

  it("first-writer-wins: an earlier root occupies the name even without the marker", () => {
    // pi 的 collision 语义以加载集为准——前根占名后根不让位（含 marker 缺席的占名）
    writeSkill(join(world.cwd, ".pi", "skills", "dup"), skillMd({ planExec: false }));
    writeSkill(join(world.agentDir, "skills", "dup"));

    expect(namesOf(detect())).toEqual([]);
  });

  it("user settings '-' disable removes the skill across roots; '+' force-include wins over '!'", () => {
    writeSkill(join(world.agentDir, "skills", "agent-skill"));
    writeSkill(join(world.homeDir, ".agents", "skills", "home-skill"));
    fs.writeFileSync(
      join(world.agentDir, "settings.json"),
      JSON.stringify({ skills: ["!agent-skill", "home-skill", "+home-skill"] }),
    );

    // '-' 强排除最优先：agent-skill 被禁；home-skill 经 '!' 禁止后又被 '+' 强制包含
    expect(namesOf(detect())).toEqual(["home-skill"]);
  });

  it("project settings overrides apply only when trusted (untrusted project settings 恒不参与)", () => {
    writeSkill(join(world.cwd, ".pi", "skills", "lib-skill"));
    fs.writeFileSync(
      join(world.cwd, ".pi", "settings.json"),
      // '!' glob 前缀 pattern：靠 SKILL.md 父目录名命中
      JSON.stringify({ skills: ["!lib-skill"] }),
    );

    expect(namesOf(detect({ trusted: true }))).toEqual([]);
    expect(namesOf(detect({ trusted: false }))).toEqual([]);
  });

  it("glob disable pattern matches by parent dir name for SKILL.md entries", () => {
    writeSkill(join(world.agentDir, "skills", "dev-flow"));
    fs.writeFileSync(
      join(world.agentDir, "settings.json"),
      JSON.stringify({ skills: ["!dev-*"] }),
    );

    expect(namesOf(detect())).toEqual([]);
  });

  it("degrades per-item: broken YAML frontmatter skips that skill without throwing, siblings survive", () => {
    // 非法 YAML：pi loadSkillFromFile 解析失败 → 该 skill 不进加载集（检测侧只见空位）
    writeSkill(join(world.agentDir, "skills", "bad"), "---\nname: [unclosed\ndescription: x\n---\n# body\n");
    writeSkill(join(world.agentDir, "skills", "good"));

    expect(namesOf(detect())).toEqual(["good"]);
  });

  it("degrades per-root: EACCES root is skipped without throwing, other roots still detected", () => {
    writeSkill(join(world.cwd, ".pi", "skills", "blocked-skill"));
    writeSkill(join(world.homeDir, ".agents", "skills", "home-skill"));
    fs.chmodSync(join(world.cwd, ".pi", "skills"), 0o000);
    try {
      // pi loadSkillsFromDirInternal 内部吞掉 readdir 错误返回空集（外层 try/catch 是纵深防御）
      expect(namesOf(detect())).toEqual(["home-skill"]);
    } finally {
      fs.chmodSync(join(world.cwd, ".pi", "skills"), 0o755);
    }
  });

  it("degrades per-root: settings parse failure is treated as no overrides with a warn", () => {
    writeSkill(join(world.agentDir, "skills", "agent-skill"));
    fs.writeFileSync(join(world.agentDir, "settings.json"), "{ not json");

    const skills = detect();
    expect(namesOf(skills)).toEqual(["agent-skill"]);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      "exec-skills: settings parse failed (treated as no overrides)",
      expect.objectContaining({ path: join(world.agentDir, "settings.json") }),
    );
  });

  it("never throws: a cwd that vanishes mid-detection degrades to the empty set", () => {
    // 整体降级规格：任何 fs 错 → 空集 + warn，绝不向消费方抛
    const missingDir = join(world.root, "removed", "cwd");
    const skills = detect({ cwd: missingDir });
    expect(skills).toEqual([]);
  });

  it("missing roots are a legal default (no warn): fresh machines scan cleanly", () => {
    // 空世界（各根目录存在但无 skill；agentDir/settings 缺失是常态主路径）
    expect(detect()).toEqual([]);
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it("HOME env injection: default homeDir derives from process.env.HOME (pi getHomeDir 同式)", () => {
    vi.stubEnv("HOME", world.homeDir);
    writeSkill(join(world.homeDir, ".agents", "skills", "home-skill"));

    const skills = detectExecSkills({ cwd: world.cwd, trusted: true, agentDir: world.agentDir });
    expect(namesOf(skills)).toEqual(["home-skill"]);
  });
});

describe("detectExecSkills（marker 过滤：plan-exec frontmatter 标记）", () => {
  it("filters to skills carrying the plan-exec marker", () => {
    writeSkill(join(world.agentDir, "skills", "marked"), skillMd({ planExec: true }));
    writeSkill(join(world.agentDir, "skills", "plain"), skillMd({ planExec: false }));

    expect(namesOf(detect())).toEqual(["marked"]);
  });

  it("disable-model-invocation coexists with the marker without filtering (user explicit choice is another channel)", () => {
    writeSkill(
      join(world.agentDir, "skills", "manual-only"),
      skillMd({ planExec: true, disableModelInvocation: true }),
    );

    expect(namesOf(detect())).toEqual(["manual-only"]);
  });
});

describe("hasPlanExecMarker（二次读 frontmatter）", () => {
  it("accepts only the strict boolean true", () => {
    const strictTrue = join(world.root, "strict.md");
    const stringTrue = join(world.root, "string.md");
    const absent = join(world.root, "absent.md");
    fs.writeFileSync(strictTrue, "---\nplan-exec: true\n---\nbody");
    fs.writeFileSync(stringTrue, "---\nplan-exec: \"true\"\n---\nbody");
    fs.writeFileSync(absent, "---\ndescription: x\n---\nbody");

    expect(hasPlanExecMarker(strictTrue)).toBe(true);
    expect(hasPlanExecMarker(stringTrue)).toBe(false);
    expect(hasPlanExecMarker(absent)).toBe(false);
  });

  it("read failure degrades to false with a warn (skill skipped)", () => {
    const missing = join(world.root, "missing.md");
    expect(hasPlanExecMarker(missing)).toBe(false);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      "exec-skills: frontmatter read failed (skill skipped)",
      expect.objectContaining({ path: missing }),
    );
  });
});

describe("isEnabledByOverrides（overrides 三级优先级，pi 同构）", () => {
  const file = "/base/skills/demo/SKILL.md";

  it("default enabled when no override matches", () => {
    expect(isEnabledByOverrides(file, [], "/base")).toBe(true);
    expect(isEnabledByOverrides(file, ["other-*"], "/base")).toBe(true);
  });

  it("'!' glob exclude disables, '+' exact force-include re-enables over '!'", () => {
    expect(isEnabledByOverrides(file, ["!demo"], "/base")).toBe(false);
    expect(isEnabledByOverrides(file, ["!demo", "+skills/demo/SKILL.md"], "/base")).toBe(true);
  });

  it("'-' exact force-exclude has the final say over '+' and '!'", () => {
    expect(isEnabledByOverrides(file, ["!demo", "+demo", "-demo"], "/base")).toBe(false);
  });

  it("relative-path form hits SKILL.md excludes via the rel candidate", () => {
    expect(isEnabledByOverrides(file, ["!skills/demo/SKILL.md"], "/base")).toBe(false);
  });
});

// 单根枚举横切规则的 pi 实装对拍冒烟：同 fixture 下共享包跨根结果 ⊆ pi 单根加载集
describe("pi 实装对拍（loadSkillsFromDir 语义锚）", () => {
  it("loadSkillsFromDir derives the skill name from frontmatter over dir name", () => {
    writeSkill(join(world.agentDir, "skills", "dir-name"), skillMd({ name: "front-name", planExec: true }));

    const loaded = loadSkillsFromDir({ dir: join(world.agentDir, "skills"), source: "detect" }).skills;
    expect(loaded.map((s) => s.name)).toEqual(["front-name"]);
    expect(namesOf(detect())).toEqual(["front-name"]);
  });
});
