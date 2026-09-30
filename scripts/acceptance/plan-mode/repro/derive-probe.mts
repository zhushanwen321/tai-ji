/**
 * 派生探针（F1/F3/F5 复现基线的「真跑」通道）：
 * session JSONL → **真实 runtime 派生函数** scanPlanStateEntries（plan-state-extractor）
 * → **真实 renderer 推导函数** derivePlanStage（plan-store）→ 输出 {view, stage}。
 *
 * 不重实现任何公式（零镜像面）——复现断言直接对着现版生产函数做。
 * cwd 需在 packages/renderer（plan-store 的 `@/` alias 靠 tsconfig paths 解析），
 * 本探针内部自行 chdir。
 *
 * 运行（由 repro-baseline.mjs 编排调用）：
 *   node_modules/.bin/tsx --tsconfig packages/renderer/tsconfig.json \
 *     scripts/acceptance/plan-mode/repro/derive-probe.mts <session.jsonl>
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..', '..', '..');

const sessionFile = process.argv[2];
if (!sessionFile) {
  console.error('usage: derive-probe.mts <session.jsonl>');
  process.exit(2);
}

const entries: unknown[] = readFileSync(sessionFile, 'utf-8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const extractor = await import(pathToFileURL(join(REPO_ROOT, 'packages/runtime/src/services/session/plan-state-extractor.ts')).href);
const view = extractor.scanPlanStateEntries(entries);

process.chdir(join(REPO_ROOT, 'packages/renderer'));
const planStore = await import(pathToFileURL(join(REPO_ROOT, 'packages/renderer/src/stores/plan-store.ts')).href);
const stage = planStore.derivePlanStage(view);

console.log(JSON.stringify({ view, stage }));
