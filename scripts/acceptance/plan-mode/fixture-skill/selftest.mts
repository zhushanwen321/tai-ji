/**
 * fixture 技能自测入口（U0 验收条款①②）——全零 token、零外部依赖、约 5s。
 * 测试框架 = 纯 node assert（脚本自测入口形态，非 vitest 域；AGENTS.md vitest 红线约束包内测试）。
 *
 * 覆盖：
 *   create                 独立测试项目目录生成（SKILL.md + 清理标记）
 *   frontmatter            pi parseFrontmatter 解析：plan-exec 严格 === true + description 必填门
 *   detect-positive        真实 detectExecSkills（extensions/universal/plan/src/exec-skills.ts）命中 fixture 技能
 *   detect-negative-untrusted   untrusted 项目跳过项目级根（④）→ 不命中
 *   detect-negative-no-marker   无 plan-exec 标记的兄弟技能 → 不命中
 *   dry-run-create         生成 dry-run 零落盘 + 动作清单
 *   dry-run-clean          清理 dry-run 不落盘（skill 目录仍在）+ 动作清单
 *   clean                  真实清理（skill 目录消失 + --all 空目录回收）
 *   clean-guard            无清理标记的目录拒绝 clean（防误删安全网）
 *
 * 运行：node_modules/.bin/tsx scripts/acceptance/plan-mode/fixture-skill/selftest.mts
 * 退出码：0 = 全绿；1 = 任一用例红。
 */
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFrontmatter } from '@earendil-works/pi-coding-agent';

import { detectExecSkills, hasPlanExecMarker } from '../../../../extensions/universal/plan/src/exec-skills.ts';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_TOOL = join(SCRIPT_DIR, 'fixture-skill.mjs');
const SKILL_NAME = 'fixture-exec-skill';

let failed = 0;
const results: Array<{ name: string; ok: boolean; evidence: string }> = [];

function check(name: string, fn: () => string): void {
  try {
    const evidence = fn();
    results.push({ name, ok: true, evidence });
    console.log(`PASS  ${name}  —  ${evidence}`);
  } catch (e) {
    results.push({ name, ok: false, evidence: String(e) });
    console.log(`FAIL  ${name}  —  ${e}`);
    failed += 1;
  }
}

function runTool(args: string[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [FIXTURE_TOOL, ...args], { encoding: 'utf-8' });
  return { status: r.status ?? -1, stdout: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const work = mkdtempSync(join(tmpdir(), 'fixture-skill-selftest-'));
const homeDir = join(work, 'home');
const agentDir = join(work, 'agent-dir');
mkdirSync(homeDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });
const logs: string[] = [];
const log = (msg: string): void => { logs.push(msg); };

try {
  const projectDir = join(work, 'project');

  check('create', () => {
    const r = runTool(['create', '--dir', projectDir, '--name', SKILL_NAME]);
    assert.equal(r.status, 0, r.stdout);
    const skillMd = join(projectDir, '.agents', 'skills', SKILL_NAME, 'SKILL.md');
    assert.ok(existsSync(skillMd), 'SKILL.md exists');
    assert.ok(existsSync(join(projectDir, '.taiji-plan-mode-fixture')), 'clean 标记存在');
    return `SKILL.md 生成于 <测试项目>/.agents/skills/${SKILL_NAME}/`;
  });

  check('frontmatter', () => {
    const skillMd = join(projectDir, '.agents', 'skills', SKILL_NAME, 'SKILL.md');
    const { frontmatter } = parseFrontmatter(readFileSync(skillMd, 'utf-8'));
    assert.equal(frontmatter['plan-exec'], true, `plan-exec 严格布尔 true（实得 ${JSON.stringify(frontmatter['plan-exec'])}）`);
    assert.ok(typeof frontmatter.description === 'string' && frontmatter.description.length > 0, 'description 必填门');
    assert.ok(hasPlanExecMarker(skillMd), 'hasPlanExecMarker 命中');
    return 'plan-exec === true（严格布尔）+ description 非空';
  });

  check('detect-positive', () => {
    const skills = detectExecSkills({ cwd: projectDir, trusted: true, homeDir, agentDir, log });
    const hit = skills.find((s) => s.name === SKILL_NAME);
    assert.ok(hit, `detectExecSkills 命中（实得 ${JSON.stringify(skills.map((s) => s.name))}）`);
    assert.ok(String(hit.skillEntryPath).endsWith(join('.agents', 'skills', SKILL_NAME, 'SKILL.md')),
      `skillEntryPath 应指向 SKILL.md（实得 ${hit.skillEntryPath}）`);
    return `命中 skillEntryPath=${hit.skillEntryPath}`;
  });

  // 兄弟技能（无 plan-exec 标记）——S5 反向断言素材
  const noMarkerDir = join(projectDir, '.agents', 'skills', 'no-marker-skill');
  mkdirSync(noMarkerDir, { recursive: true });
  writeFileSync(join(noMarkerDir, 'SKILL.md'), '---\nname: no-marker-skill\ndescription: 无标记兄弟技能\n---\n\nbody\n');

  check('detect-negative-untrusted', () => {
    const skills = detectExecSkills({ cwd: projectDir, trusted: false, homeDir, agentDir, log });
    assert.ok(!skills.some((s) => s.name === SKILL_NAME), `untrusted 不命中项目级根（实得 ${JSON.stringify(skills.map((s) => s.name))}）`);
    return 'untrusted 项目跳过项目级 .agents/skills（④）';
  });

  check('detect-negative-no-marker', () => {
    const skills = detectExecSkills({ cwd: projectDir, trusted: true, homeDir, agentDir, log });
    assert.ok(!skills.some((s) => s.name === 'no-marker-skill'), '无 plan-exec 标记不进选项集');
    return '无标记兄弟技能不命中';
  });

  check('dry-run-create', () => {
    const freshDir = join(work, 'fresh-project');
    const r = runTool(['create', '--dir', freshDir, '--name', SKILL_NAME, '--dry-run']);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /\[dry-run\] write .*SKILL\.md/);
    assert.ok(!existsSync(freshDir), 'dry-run 零落盘（目录未创建）');
    return '动作清单打印且零落盘';
  });

  check('dry-run-clean', () => {
    const r = runTool(['clean', '--dir', projectDir, '--name', SKILL_NAME, '--dry-run']);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /\[dry-run\] rm -rf/);
    assert.ok(existsSync(join(projectDir, '.agents', 'skills', SKILL_NAME, 'SKILL.md')), 'dry-run 不删');
    return '动作清单打印且 skill 目录仍在';
  });

  check('clean', () => {
    rmSync(noMarkerDir, { recursive: true, force: true }); // 兄弟技能先行移除，--all 断言空目录回收
    const r = runTool(['clean', '--dir', projectDir, '--name', SKILL_NAME, '--all']);
    assert.equal(r.status, 0, r.stdout);
    assert.ok(!existsSync(join(projectDir, '.agents', 'skills', SKILL_NAME)), 'skill 目录已清');
    assert.ok(!existsSync(join(projectDir, '.taiji-plan-mode-fixture')), '标记已清');
    assert.ok(!existsSync(projectDir), '--all 回收空项目目录（S12 无残留）');
    return '清理完成，S12 残留断言基线（目录消失）';
  });

  check('clean-guard', () => {
    const foreign = join(work, 'foreign');
    mkdirSync(foreign, { recursive: true });
    const r = runTool(['clean', '--dir', foreign, '--name', SKILL_NAME]);
    assert.notEqual(r.status, 0, '无标记目录 clean 必须拒绝');
    assert.match(r.stdout, /clean 拒绝/);
    return '无清理标记的目录拒绝 clean（防误删）';
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\nfixture-skill selftest: ${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
