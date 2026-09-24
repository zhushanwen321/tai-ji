#!/usr/bin/env node
/**
 * S5 fixture 技能生成/清理器（plan-exec: true frontmatter 模板 → 独立测试项目目录）。
 *
 * 设计锚点（plan-mode-state-machine §3.3 D7③）：fixture 技能落在**独立测试项目目录**的
 * 项目级 `.agents/skills/`（exec-skills 四根扫描含祖先链 `.agents/skills`，trusted 项目生效），
 * 不污染 `~/.agents/skills/`；`plan-exec: true` 是 frontmatter 严格布尔（字符串 "true" 不命中）；
 * 验收窗结束随测试目录一并清理（S12 断言无残留）。
 *
 * 用法：
 *   node scripts/acceptance/plan-mode/fixture-skill/fixture-skill.mjs create \
 *     --dir <测试项目目录> [--name fixture-exec-skill] [--description "..."] [--dry-run]
 *   node scripts/acceptance/plan-mode/fixture-skill/fixture-skill.mjs clean \
 *     --dir <测试项目目录> [--name fixture-exec-skill] [--all] [--dry-run]
 *
 * 安全网：clean 只在目录内存在标记文件 `.taiji-plan-mode-fixture` 时执行（create 时写入），
 * `--all` 额外清理空的 `.agents` 与项目目录本身；dry-run 打印动作清单零落盘。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(SCRIPT_DIR, 'templates', 'SKILL.md.template');
const MARKER_FILE = '.taiji-plan-mode-fixture';
const DEFAULT_NAME = 'fixture-exec-skill';
const DEFAULT_DESCRIPTION = 'plan 模式验收 fixture 执行技能（plan-exec 标记携带者，仅验收用）';

function parseArgs(argv) {
  const out = { action: argv[0], dryRun: false, all: false, name: DEFAULT_NAME };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dir') out.dir = resolve(argv[++i]);
    else if (a === '--name') out.name = argv[++i];
    else if (a === '--description') out.description = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--all') out.all = true;
    else throw new Error(`fixture-skill: unknown arg: ${a}`);
  }
  return out;
}

function act(dryRun, msg) {
  console.log(`[${dryRun ? 'dry-run' : 'do'}] ${msg}`);
}

function skillDirOf(args) {
  return join(args.dir, '.agents', 'skills', args.name);
}

function create(args) {
  const skillDir = skillDirOf(args);
  const skillMd = join(skillDir, 'SKILL.md');
  const template = readFileSync(TEMPLATE_PATH, 'utf-8')
    .replaceAll('{{SKILL_NAME}}', args.name)
    .replaceAll('{{DESCRIPTION}}', args.description ?? DEFAULT_DESCRIPTION);
  act(args.dryRun, `mkdir -p ${skillDir}`);
  act(args.dryRun, `write ${skillMd}（frontmatter: name/description/plan-exec: true）`);
  act(args.dryRun, `write ${join(args.dir, MARKER_FILE)}（clean 安全网标记）`);
  if (args.dryRun) return;
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(skillMd, template);
  writeFileSync(join(args.dir, MARKER_FILE), `${args.name}\n`);
  console.log(`fixture-skill: created ${skillMd}`);
}

function clean(args) {
  const marker = join(args.dir, MARKER_FILE);
  if (!existsSync(marker)) {
    throw new Error(`fixture-skill: clean 拒绝——${marker} 不存在（非本工具创建的目录，防误删）`);
  }
  const skillDir = skillDirOf(args);
  act(args.dryRun, `rm -rf ${skillDir}`);
  act(args.dryRun, `rm ${marker}`);
  if (args.all) {
    act(args.dryRun, `rmdir ${join(args.dir, '.agents', 'skills')} ${join(args.dir, '.agents')}（空则删）`);
    act(args.dryRun, `rmdir ${args.dir}（空则删）`);
  }
  if (args.dryRun) return;
  rmSync(skillDir, { recursive: true, force: true });
  rmSync(marker, { force: true });
  if (args.all) {
    for (const p of [join(args.dir, '.agents', 'skills'), join(args.dir, '.agents'), args.dir]) {
      try {
        // 仅空目录可删（rmdir 语义），非空不强制——S12 残留断言仍以 skill 目录消失为准
        rmdirSync(p);
      } catch { /* non-empty: keep */ }
    }
  }
  console.log(`fixture-skill: cleaned ${skillDir}`);
}

const args = parseArgs(process.argv.slice(2));
if (!args.dir) throw new Error('fixture-skill: --dir <测试项目目录> 必填');
if (args.action === 'create') create(args);
else if (args.action === 'clean') clean(args);
else throw new Error(`fixture-skill: unknown action: ${args.action}（create | clean）`);
