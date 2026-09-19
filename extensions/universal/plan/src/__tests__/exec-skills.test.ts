import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock 共享 logger：降级规格的 warn 留痕可 spy（scheduler importer.test 同款形态）
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({
  getLogger: () => loggerMock,
  createLogger: () => loggerMock,
  setPiHandle: vi.fn(),
}));

// 对拍锚点直接用 node_modules 实装（pi 0.84.4 dist，AGENTS.md 语义断言约定）
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
  const root = fs.mkdtempSync(join(tmpdir(), "plan-exec-skills-"));
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
function writeSkill(dir: string, content = skillMd({ planExec: true })): { skillDir: string; skillPath: string } {
  fs.mkdirSync(dir, { recursive: true });
  const skillPath = join(dir, "SKILL.md");
  fs.writeFileSync(skillPath, content);
  return { skillDir: dir, skillPath };
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

describe("四根枚举与根序（pi 本体加载集对齐）", () => {
  it("enumerates all four roots in pi order: .pi/skills → 祖先链(近→远) → agentDir → ~/.agents/skills", () => {
    writeSkill(join(world.cwd, ".pi", "skills", "lib-skill"));
    writeSkill(join(world.root, "proj", "packages", ".agents", "skills", "mid-skill"));
    writeSkill(join(world.root, "proj", ".agents", "skills", "root-skill"));
    writeSkill(join(world.agentDir, "skills", "agent-skill"));
    writeSkill(join(world.homeDir, ".agents", "skills", "home-skill"));

    const skills = detect();
    expect(namesOf(skills)).toEqual(["lib-skill", "mid-skill", "root-skill", "agent-skill", "home-skill"]);
    // skillDir 数据通路：steer 指引的路径来源 = 入口文件路径（标准形态即 SKILL.md 路径）
    expect(skills[0].skillDir).toBe(join(world.cwd, ".pi", "skills", "lib-skill", "SKILL.md"));
    expect(skills[0].skillPath).toBe(join(world.cwd, ".pi", "skills", "lib-skill", "SKILL.md"));
  });

  it("ancestor chain stops at a .git FILE (worktree 双语义), skills beyond the root are not proposed", () => {
    // 独立世界：worktree 形态 .git 文件 + 链外根
    const root = fs.mkdtempSync(join(tmpdir(), "plan-exec-wt-"));
    try {
      fs.mkdirSync(join(root, "wt"), { recursive: true });
      fs.writeFileSync(join(root, "wt", ".git"), "gitdir: /elsewhere\n");
      const cwd = join(root, "wt", "work");
      writeSkill(join(cwd, ".agents", "skills", "inside-skill"));
      writeSkill(join(root, ".agents", "skills", "outside-skill"));
      const skills = detectExecSkills({ cwd, trusted: true, agentDir: join(root, "empty-agent"), homeDir: join(root, "empty-home") });
      expect(namesOf(skills)).toEqual(["inside-skill"]);
    } finally {
      rmWorld(root);
    }
  });

  it("HOME=tmp 注入：缺省 homeDir 经 process.env.HOME 推导（pi getHomeDir 同式）", () => {
    vi.stubEnv("HOME", world.homeDir);
    writeSkill(join(world.homeDir, ".agents", "skills", "home-skill"));
    const skills = detectExecSkills({ cwd: world.cwd, trusted: true, agentDir: world.agentDir });
    expect(namesOf(skills)).toEqual(["home-skill"]);
  });

  it("cwd 在 HOME 下时祖先链与 ~/.agents/skills 的同路径项被滤掉（pi :1979 同款，不重复）", () => {
    // 独立世界：home 即 git root，cwd 在其下——链会经过 home/.agents/skills（与第四根同路径）
    const root = fs.mkdtempSync(join(tmpdir(), "plan-exec-dedup-"));
    try {
      const homeDir = join(root, "home");
      fs.mkdirSync(join(homeDir, ".git"), { recursive: true });
      const cwd = join(homeDir, "proj");
      writeSkill(join(homeDir, ".agents", "skills", "home-skill"));
      const skills = detectExecSkills({ cwd, trusted: true, agentDir: join(root, "empty-agent"), homeDir });
      expect(namesOf(skills)).toEqual(["home-skill"]); // 恰一次
    } finally {
      rmWorld(root);
    }
  });
});

describe("对照表② overrides-disable 复刻", () => {
  it("project `!glob` excludes by skill dir name (parentName 匹配形态)", () => {
    writeSkill(join(world.cwd, ".pi", "skills", "dev-flow"));
    writeSkill(join(world.cwd, ".pi", "skills", "keep-me"));
    fs.writeFileSync(join(world.cwd, ".pi", "settings.json"), JSON.stringify({ skills: ["!dev-*"] }));
    expect(namesOf(detect())).toEqual(["keep-me"]);
  });

  it("project `-exact` excludes by relative path from the root's baseDir", () => {
    writeSkill(join(world.cwd, ".pi", "skills", "dev-flow"));
    // baseDir = <cwd>/.pi，SKILL.md 父目录 rel = skills/dev-flow
    fs.writeFileSync(join(world.cwd, ".pi", "settings.json"), JSON.stringify({ skills: ["-skills/dev-flow"] }));
    expect(namesOf(detect())).toEqual([]);
  });

  it("`+` force-include overrides a `!` exclusion, `-` overrides `+`（三级优先级 - > + > !）", () => {
    writeSkill(join(world.cwd, ".pi", "skills", "dev-flow"));
    fs.writeFileSync(join(world.cwd, ".pi", "settings.json"), JSON.stringify({ skills: ["!dev-*", "+skills/dev-flow"] }));
    expect(namesOf(detect())).toEqual(["dev-flow"]);

    fs.writeFileSync(join(world.cwd, ".pi", "settings.json"), JSON.stringify({ skills: ["!dev-*", "+skills/dev-flow", "-skills/dev-flow"] }));
    expect(namesOf(detect())).toEqual([]);
  });

  it("global settings (agentDir) disable user-scope roots; project overrides do not leak into them", () => {
    writeSkill(join(world.agentDir, "skills", "agent-skill"));
    writeSkill(join(world.homeDir, ".agents", "skills", "home-skill"));
    // 项目级 disable 名与 user 根 skill 同名——不作用于 user 根（baseDir 归属隔离）
    fs.writeFileSync(join(world.cwd, ".pi", "settings.json"), JSON.stringify({ skills: ["!agent-skill"] }));
    expect(namesOf(detect())).toEqual(["agent-skill", "home-skill"]);

    fs.writeFileSync(join(world.agentDir, "settings.json"), JSON.stringify({ skills: ["!agent-skill"] }));
    expect(namesOf(detect())).toEqual(["home-skill"]);
  });

  it("plain patterns without +/-/! prefix are ignored for auto resources（pi getOverridePatterns 同款）", () => {
    writeSkill(join(world.cwd, ".pi", "skills", "dev-flow"));
    fs.writeFileSync(join(world.cwd, ".pi", "settings.json"), JSON.stringify({ skills: ["dev-flow"] }));
    expect(namesOf(detect())).toEqual(["dev-flow"]);
  });

  it("isEnabledByOverrides 单元：glob 跨形态命中（rel/name/绝对路径/父目录）", () => {
    const baseDir = join(world.root, "base");
    const filePath = join(baseDir, "skills", "dev-flow", "SKILL.md");
    expect(isEnabledByOverrides(filePath, ["!dev-flow"], baseDir)).toBe(false); // parentName
    expect(isEnabledByOverrides(filePath, ["!skills/dev-flow/*"], baseDir)).toBe(false); // rel glob
    expect(isEnabledByOverrides(filePath, ["!**/SKILL.md"], baseDir)).toBe(false); // 跨目录 glob
    expect(isEnabledByOverrides(filePath, [], baseDir)).toBe(true); // 无 overrides 恒启用
    expect(isEnabledByOverrides(filePath, ["!other"], baseDir)).toBe(true);
  });
});

describe("对照表④ trusted 门", () => {
  it("untrusted skips .pi/skills + 祖先链两族，agentDir 与 ~ 两根不受限", () => {
    writeSkill(join(world.cwd, ".pi", "skills", "lib-skill"));
    writeSkill(join(world.root, "proj", ".agents", "skills", "root-skill"));
    writeSkill(join(world.agentDir, "skills", "agent-skill"));
    writeSkill(join(world.homeDir, ".agents", "skills", "home-skill"));

    expect(namesOf(detect({ trusted: false }))).toEqual(["agent-skill", "home-skill"]);
  });
});

describe("对照表⑤ 同名 first-writer-wins 去重", () => {
  it("same name across roots: earlier root wins (root 序)", () => {
    writeSkill(join(world.cwd, ".pi", "skills", "dup"));
    writeSkill(join(world.homeDir, ".agents", "skills", "dup"));
    const skills = detect();
    expect(namesOf(skills)).toEqual(["dup"]);
    expect(skills[0].skillDir).toBe(join(world.cwd, ".pi", "skills", "dup", "SKILL.md"));
  });

  it("non-marker skill still occupies its name（pi collision 语义：marker 不改变占名）", () => {
    writeSkill(join(world.cwd, ".pi", "skills", "dupe"), skillMd({ planExec: false }));
    writeSkill(join(world.homeDir, ".agents", "skills", "dupe"));
    expect(namesOf(detect())).toEqual([]);
  });

  it("symlinked duplicate resolves to a single entry（realPath 去重）", () => {
    const real = writeSkill(join(world.cwd, ".pi", "skills", "dup"));
    fs.mkdirSync(join(world.homeDir, ".agents", "skills"), { recursive: true });
    fs.symlinkSync(real.skillDir, join(world.homeDir, ".agents", "skills", "alias"));
    const skills = detect();
    expect(namesOf(skills)).toEqual(["dup"]);
    expect(skills[0].skillDir).toBe(real.skillPath); // 入口文件路径（realPath 去重后指向真身）
  });
});

describe("对照表①③⑥ 对拍（pi 实装锚点守卫；⑦散 .md 为已登记偏差不设对拍）", () => {
  /**
   * 单根 fixture（挂在 agentDir/skills，其余根不存在）：
   * - alpha：frontmatter name 覆盖目录名（⑥ name 派生）
   * - beta：无 frontmatter name → 目录名 fallback（⑥）
   * - no-desc：无 description → ③ 必填门排除
   * - nested/deep/gamma：递归遍历
   * - loose.md：根级散 .md（loadSkillsFromDir 收集，⑦登记面内）
   * - ignored/：.gitignore 排除（①）
   * - node_modules 与 .hidden：loader 内建排除
   */
  function makeAnchorRoot(): { root: string; agentDir: string } {
    const root = fs.mkdtempSync(join(tmpdir(), "plan-exec-anchor-"));
    const skillsRoot = join(root, "agent", "skills");
    fs.mkdirSync(skillsRoot, { recursive: true });
    writeSkill(join(skillsRoot, "alpha"), skillMd({ name: "custom-alpha", planExec: true }));
    writeSkill(join(skillsRoot, "beta"), skillMd({ planExec: true }));
    writeSkill(join(skillsRoot, "no-desc"), "---\nname: no-desc\n---\n\n# no description\n");
    writeSkill(join(skillsRoot, "nested", "deep", "gamma"), skillMd({ planExec: true }));
    // 根级散 .md（loadSkillsFromDir 收集形态；name 走 frontmatter——散文件 parentDir 名不可用）
    fs.writeFileSync(join(skillsRoot, "loose.md"), skillMd({ name: "loose", planExec: true }));
    writeSkill(join(skillsRoot, "ignored"), skillMd({ planExec: true }));
    writeSkill(join(skillsRoot, "node_modules", "pkg"), skillMd({ planExec: true }));
    writeSkill(join(skillsRoot, ".hidden"), skillMd({ planExec: true }));
    fs.writeFileSync(join(skillsRoot, ".gitignore"), "ignored/\n");
    return { root, agentDir: join(root, "agent") };
  }

  it("pi loadSkillsFromDir anchor：单根规则快照（①ignore/③description 门/⑥name 派生/递归/node_modules/隐藏文件）", () => {
    const { root, agentDir } = makeAnchorRoot();
    try {
      const piResult = loadSkillsFromDir({ dir: join(agentDir, "skills"), source: "anchor" });
      // pi 实装语义快照——pi bump 改单根规则时此处红灯（守卫边界 = 单根规则漂移）
      expect(piResult.skills.map((s) => s.name).sort()).toEqual(["beta", "custom-alpha", "gamma", "loose"]);
      expect(piResult.skills.some((s) => s.name === "no-desc")).toBe(false); // ③ description 必填门
      expect(piResult.skills.some((s) => s.filePath.includes("ignored"))).toBe(false); // ① gitignore
      expect(piResult.skills.some((s) => s.filePath.includes("node_modules"))).toBe(false);
      expect(piResult.skills.some((s) => s.filePath.includes(".hidden"))).toBe(false);
    } finally {
      rmWorld(root);
    }
  });

  it("detection per-root enumeration equals pi loadSkillsFromDir on the same fixture（对拍等价）", () => {
    const { root, agentDir } = makeAnchorRoot();
    try {
      const piNames = loadSkillsFromDir({ dir: join(agentDir, "skills"), source: "anchor" })
        .skills.map((s) => s.name).sort();
      const detected = detectExecSkills({
        cwd: join(root, "empty-cwd"),
        trusted: true,
        agentDir,
        homeDir: join(root, "empty-home"),
      });
      // marker 过滤前的 pi 加载集 = 检测的单根并集；marker 只减不增
      expect(piNames).toContain("custom-alpha"); // ⑥ frontmatter name
      expect(piNames).toContain("beta");
      expect(namesOf(detected).sort()).toEqual(["beta", "custom-alpha", "gamma", "loose"]);
      // ⑥：steer 指引名与 pi prompt 列表一致（frontmatter name 而非目录名）
      expect(detected.some((s) => s.name === "custom-alpha" && s.skillDir.endsWith(join("alpha", "SKILL.md")))).toBe(true);
      expect(detected.some((s) => s.name === "alpha")).toBe(false);
    } finally {
      rmWorld(root);
    }
  });

  it("散 .md 形态：skillDir = 文件路径本身（steer 指引路径不悬空，⑦登记面内）", () => {
    const { root, agentDir } = makeAnchorRoot();
    try {
      const detected = detectExecSkills({
        cwd: join(root, "empty-cwd"),
        trusted: true,
        agentDir,
        homeDir: join(root, "empty-home"),
      });
      const loose = detected.find((s) => s.name === "loose");
      // 入口路径 = loose.md 文件本身——不是 `<skills根>/SKILL.md`（散 .md 形态拼 SKILL.md 必然悬空）
      expect(loose?.skillDir).toBe(join(agentDir, "skills", "loose.md"));
    } finally {
      rmWorld(root);
    }
  });
});

describe("marker 过滤（plan-exec frontmatter）", () => {
  it("only plan-exec: true is proposed; absent / disable-model-invocation 并存不过滤", () => {
    writeSkill(join(world.cwd, ".pi", "skills", "marked"));
    writeSkill(join(world.cwd, ".pi", "skills", "unmarked"), skillMd({ planExec: false }));
    writeSkill(join(world.cwd, ".pi", "skills", "manual-only"), skillMd({ planExec: true, disableModelInvocation: true }));
    expect(namesOf(detect()).sort()).toEqual(["manual-only", "marked"]); // readdir 字母序，排序断言
  });

  it("hasPlanExecMarker strictness: string 'true' does not count as the marker", () => {
    const p = join(world.root, "str-true.md");
    fs.writeFileSync(p, "---\nplan-exec: \"true\"\ndescription: x\n---\n");
    expect(hasPlanExecMarker(p)).toBe(false);
    const q = join(world.root, "bool-true.md");
    fs.writeFileSync(q, "---\nplan-exec: true\ndescription: x\n---\n");
    expect(hasPlanExecMarker(q)).toBe(true);
  });

  it("hasPlanExecMarker read failure → false + warn（降级：跳过该项）", () => {
    const warns = loggerMock.warn.mock.calls.length;
    expect(hasPlanExecMarker(join(world.root, "missing.md"))).toBe(false);
    expect(loggerMock.warn.mock.calls.length).toBe(warns + 1);
  });
});

describe("降级规格（检测失败最坏 = 空集，不炸 complete）", () => {
  it("empty world → []（~/.agents/skills 不存在是常态主路径）", () => {
    expect(detect()).toEqual([]);
  });

  it("EACCES root is skipped without throwing, other roots still detected", () => {
    writeSkill(join(world.cwd, ".pi", "skills", "blocked-skill"));
    writeSkill(join(world.homeDir, ".agents", "skills", "home-skill"));
    fs.chmodSync(join(world.cwd, ".pi", "skills"), 0o000);
    try {
      // pi loadSkillsFromDirInternal 内部吞掉 readdir 错误返回空集（我们外层 try/catch
      // 是纵深防御）——降级语义：该根跳过、不炸、其余根照常
      expect(namesOf(detect())).toEqual(["home-skill"]);
    } finally {
      fs.chmodSync(join(world.cwd, ".pi", "skills"), 0o755);
    }
  });

  it("broken settings JSON → treated as no overrides（skills 照常检测）", () => {
    writeSkill(join(world.cwd, ".pi", "skills", "dev-flow"));
    fs.writeFileSync(join(world.cwd, ".pi", "settings.json"), "{broken");
    expect(namesOf(detect())).toEqual(["dev-flow"]);
    expect(loggerMock.warn).toHaveBeenCalled();
  });

  it("broken YAML frontmatter in SKILL.md → skill skipped (pi loader 侧已不加载，检测不炸)", () => {
    // 非法 YAML：pi loadSkillFromFile 解析失败 → 该 skill 不进加载集
    writeSkill(join(world.cwd, ".pi", "skills", "bad-yaml"), "---\nname: [unclosed\ndescription: x\n---\n# body\n");
    writeSkill(join(world.cwd, ".pi", "skills", "fine"));
    expect(namesOf(detect())).toEqual(["fine"]);
  });
});
