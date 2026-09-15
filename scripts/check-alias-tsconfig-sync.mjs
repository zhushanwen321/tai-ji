#!/usr/bin/env node
/**
 * vitest alias ↔ tsconfig paths 一致性守卫（2026-09-16 护栏，PR #198 事故产物）。
 *
 * 背景：subagent-workflow 测试用 `@zhushanwen/subagent-core/<深路径>.ts` 深路径
 * import，运行时由 vitest.config.ts 的 alias（string + regex 两形态）重写到 core
 * src 物理路径——这是 u-2c 删 exports `./*` 通配后的已裁决设计（2026-09-03）。
 * 静态分析工具（fallow 等）不读 vitest alias，深路径全部判「无法解析的 import」
 * （曾一次 138 条假阳性）。解法 = extensions/tsconfig.json 的 paths 镜像同构映射。
 * 本守卫保证两侧不漂移：新增/修改 vitest alias 而忘同步 tsconfig paths（或反之）
 * 时 CI 拦截。
 *
 * 契约（当前两条，增改 alias 时同步维护 EXPECTED）：
 * - vitest regex  ^@zhushanwen/subagent-core\/(.+\.ts)$  → src/$1
 *   ⇔ paths "@zhushanwen/subagent-core/*.ts" → ../packages/subagent-core/src/*.ts
 * - vitest string "@zhushanwen/subagent-core/testing" → src（虚拟前缀）
 *   ⇔ paths "@zhushanwen/subagent-core/testing/*.ts" → ../packages/subagent-core/src/*.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const vitestConfig = readFileSync(
  join(repoRoot, 'extensions/universal/subagent-workflow/vitest.config.ts'),
  'utf8',
);
const tsconfig = JSON.parse(readFileSync(join(repoRoot, 'extensions/tsconfig.json'), 'utf8'));
const paths = tsconfig.compilerOptions?.paths ?? {};

const problems = [];

function expectPathsKey(key, targetSuffix) {
  const target = paths[key];
  if (!target || !Array.isArray(target) || target.length !== 1) {
    problems.push(`extensions/tsconfig.json 缺 paths 条目 "${key}"（应有且仅 1 条目标）。`);
    return;
  }
  if (!target[0].endsWith(targetSuffix)) {
    problems.push(
      `paths "${key}" 目标 ${target[0]} 不以 ${targetSuffix} 结尾——vitest alias 重写目标已漂移。`,
    );
  }
}

// ① regex 深路径形态：vitest 配置里必须存在该正则（源码文本子串匹配），且 tsconfig 有等价通配
const REGEX_ALIAS_SIG = String.raw`@zhushanwen\/subagent-core\/(.+\.ts)$`;
const hasRegexAlias = vitestConfig.includes(REGEX_ALIAS_SIG);
if (!hasRegexAlias) {
  problems.push(
    `vitest.config.ts 中未找到 subagent-core 深路径正则 alias（源码应含 "${REGEX_ALIAS_SIG}"）。` +
      '若形态已改，请同步更新本守卫的 EXPECTED 契约与 tsconfig paths。',
  );
}
expectPathsKey('@zhushanwen/subagent-core/*.ts', 'packages/subagent-core/src/*.ts');

// ② testing/ 虚拟前缀形态：string alias 存在 ⇔ paths 有对应条目
const hasTestingAlias = vitestConfig.includes('"@zhushanwen/subagent-core/testing"');
const hasTestingPaths = '@zhushanwen/subagent-core/testing/*.ts' in paths;
if (hasTestingAlias !== hasTestingPaths) {
  problems.push(
    `vitest alias 与 tsconfig paths 的 testing/ 虚拟前缀不对齐（vitest 有 string alias = ${hasTestingAlias}，` +
      'tsconfig 有 paths = ' + hasTestingPaths + '）。两侧必须同时存在或同时移除。',
  );
}
if (hasTestingPaths) {
  expectPathsKey('@zhushanwen/subagent-core/testing/*.ts', 'packages/subagent-core/src/*.ts');
}

// ③ 反向：tsconfig 里 subagent-core 的 paths 条目不得多于 vitest alias 面（防孤儿映射）
for (const key of Object.keys(paths)) {
  if (!key.startsWith('@zhushanwen/subagent-core')) continue;
  if (key !== '@zhushanwen/subagent-core/*.ts' && key !== '@zhushanwen/subagent-core/testing/*.ts') {
    problems.push(
      `tsconfig paths 存在守卫契约外的 subagent-core 条目 "${key}"——请确认是否需同步 vitest alias 并更新本守卫 EXPECTED。`,
    );
  }
}

if (problems.length > 0) {
  console.error('[check-alias-tsconfig-sync] FAIL：vitest alias ↔ tsconfig paths 漂移：');
  for (const p of problems) console.error('  - ' + p);
  console.error('恢复：对齐 extensions/universal/subagent-workflow/vitest.config.ts 与 extensions/tsconfig.json 的 paths，');
  console.error('并同步更新 scripts/check-alias-tsconfig-sync.mjs 顶部契约注释。');
  process.exit(1);
}
console.log('[check-alias-tsconfig-sync] OK：subagent-core 深路径 alias ↔ tsconfig paths 一致（regex + testing 两形态）。');
