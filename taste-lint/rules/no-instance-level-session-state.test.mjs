/**
 * no-instance-level-session-state 规则用例（context-consistency-design D5 / 护栏 G1）。
 *
 * T1-T8 用例定义见 context-consistency-lint-rule §4 表格；另补两个规则
 * 边界用例（非 script setup 不报 / X.value.field 深层写报错）。vitest + eslint Linter
 * 直挂规则（require-data-owner-annotation.test.mjs 同款跑法），parser 与 taste-lint/vue.mjs
 * 同构：vue-eslint-parser 外层 + typescript-eslint 内层（真实组件 defineProps<T>() 形态）。
 * 运行：npx vitest run taste-lint（仓库根）
 */
import { test, expect } from 'vitest';
import { Linter } from 'eslint';
import vueParser from 'vue-eslint-parser';
import tseslint from 'typescript-eslint';
import rule from './no-instance-level-session-state.mjs';

const RULE_ID = 'taste/no-instance-level-session-state';
const VUE_FILE = 'packages/renderer/src/components/panel/probe.vue';

/** 与仓库 taste-lint/vue.mjs 的 .vue 块同构的最小配置 */
function lintVue(code, filename = VUE_FILE) {
  const linter = new Linter();
  return linter.verify(
    code,
    {
      files: ['**/*.vue'],
      languageOptions: {
        parser: vueParser,
        parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.vue'] },
      },
      plugins: { taste: { rules: { 'no-instance-level-session-state': rule } } },
      rules: { [RULE_ID]: 'error' },
    },
    { filename },
  );
}

/** 普通 .ts 文件（规则仅 .vue 生效，T8） */
function lintTs(code) {
  const linter = new Linter();
  return linter.verify(
    code,
    {
      files: ['**/*.ts'],
      languageOptions: { parser: tseslint.parser },
      plugins: { taste: { rules: { 'no-instance-level-session-state': rule } } },
      rules: { [RULE_ID]: 'error' },
    },
    { filename: 'packages/renderer/src/composables/probe.ts' },
  );
}

const sfc = (scriptBody) =>
  `<script setup lang="ts">\n${scriptBody}\n</script>\n<template><div /></template>\n`;

/** T1 三信号齐备的最小违规形态（ContextCapacityPopover 重构前同构） */
const T1_CODE = sfc(
  [
    "import { ref } from 'vue'",
    'const stats = ref({ used: 0 })',
    "defineProps<{ sessionId: string }>()",
    'const onMessage = useSessionEvents(sessionId)',
    "onMessage('context.update', (msg) => {",
    '  stats.value = { used: msg.payload.used }',
    '})',
  ].join('\n'),
);

test('T1: 三信号齐备（sessionId prop + useSessionEvents + handler 直写本地 ref）→ 报错，消息含 refName 与迁移指引', () => {
  const messages = lintVue(T1_CODE);
  expect(messages).toHaveLength(1);
  expect(messages[0].severity).toBe(2);
  expect(messages[0].message).toContain('stats');
  expect(messages[0].message).toMatch(/useSessionScopedState/);
  expect(messages[0].message).toMatch(/updateFor/);
  expect(messages[0].message).toMatch(/taste:allow-instance-level-session-state/);
});

test('T2: 缺 S1（无 sessionId prop）→ 不报', () => {
  const messages = lintVue(
    sfc(
      [
        "import { ref } from 'vue'",
        'const stats = ref({ used: 0 })',
        "defineProps<{ modelId: string }>()",
        'const onMessage = useSessionEvents(modelId)',
        "onMessage('context.update', (msg) => {",
        '  stats.value = { used: msg.payload.used }',
        '})',
      ].join('\n'),
    ),
  );
  expect(messages).toHaveLength(0);
});

test('T3: 缺 S3（handler 只调 store action / 只读不写）→ 不报', () => {
  const messages = lintVue(
    sfc(
      [
        "import { ref } from 'vue'",
        "defineProps<{ sessionId: string }>()",
        'const onMessage = useSessionEvents(sessionId)',
        "onMessage('context.update', (msg) => {",
        '  quotaStore.apply(msg.payload)',
        '  console.log(msg.payload.used)',
        '})',
      ].join('\n'),
    ),
  );
  expect(messages).toHaveLength(0);
});

test('T4: handler 内写 updateFor(sid, ...)（分区范式）→ 不报', () => {
  const messages = lintVue(
    sfc(
      [
        "defineProps<{ sessionId: string }>()",
        'const onMessage = useSessionEvents(sessionId)',
        "onMessage('context.update', (msg, sid) => {",
        '  updateFor(sid, { used: msg.payload.used })',
        '})',
      ].join('\n'),
    ),
  );
  expect(messages).toHaveLength(0);
});

test('T5: 写入目标 ref 来自 toRefs(props)（非本组件声明，生命周期归父组件管）→ 不报', () => {
  const messages = lintVue(
    sfc(
      [
        "import { toRefs } from 'vue'",
        'const props = defineProps<{ sessionId: string }>()',
        'const { sessionId } = toRefs(props)',
        'const onMessage = useSessionEvents(sessionId)',
        "onMessage('context.update', (msg) => {",
        '  sessionId.value = msg.payload.sid',
        '})',
      ].join('\n'),
    ),
  );
  expect(messages).toHaveLength(0);
});

test('T6: 违规赋值处带豁免登记注释 → 不报', () => {
  const messages = lintVue(
    sfc(
      [
        "import { ref } from 'vue'",
        'const stats = ref({ used: 0 })',
        "defineProps<{ sessionId: string }>()",
        'const onMessage = useSessionEvents(sessionId)',
        "onMessage('context.update', (msg) => {",
        '  // taste:allow-instance-level-session-state Phase 2 重构迁移中',
        '  stats.value = { used: msg.payload.used }',
        '})',
      ].join('\n'),
    ),
  );
  expect(messages).toHaveLength(0);
});

test('T7: 多个 onMessage 注册，仅其一违规 → 只精确报违规处', () => {
  const messages = lintVue(
    sfc(
      [
        "import { ref } from 'vue'",
        'const stats = ref({ used: 0 })',
        "defineProps<{ sessionId: string }>()",
        'const onMessage = useSessionEvents(sessionId)',
        "onMessage('context.update', (msg) => {",
        '  stats.value = { used: msg.payload.used }',
        '})',
        "onMessage('session.state_changed', (msg) => {",
        '  quotaStore.apply(msg)',
        '})',
      ].join('\n'),
    ),
  );
  expect(messages).toHaveLength(1);
  expect(messages[0].line).toBe(7); // 报在违规赋值行（stats.value = ...），非干净注册处
  expect(messages[0].message).toContain('stats');
});

test('T8: 非 .vue 文件（普通 ts）→ 不报（规则仅 vue 文件生效）', () => {
  const messages = lintTs(
    [
      "import { ref } from 'vue'",
      'const stats = ref({ used: 0 })',
      'export const onMessage = useSessionEvents(() => {})',
      'export const handle = (msg: any) => {',
      '  stats.value = { used: msg.used }',
      '}',
    ].join('\n'),
  );
  expect(messages).toHaveLength(0);
});

// ── 规则边界补充用例 ──────────────────────────────────────────────────────

test('边界: X.value.field 深层字段写 → 报错（子文档 S3 明确列出的第二形态）', () => {
  const messages = lintVue(
    sfc(
      [
        "import { ref } from 'vue'",
        'const stats = ref({ used: 0 })',
        "defineProps<{ sessionId: string }>()",
        'const onMessage = useSessionEvents(sessionId)',
        "onMessage('context.update', (msg) => {",
        '  stats.value.used = msg.payload.used',
        '})',
      ].join('\n'),
    ),
  );
  expect(messages).toHaveLength(1);
  expect(messages[0].message).toContain('stats');
});

test('边界: 普通 <script>（非 setup，选项式组件）→ 不报', () => {
  const messages = lintVue(
    [
      '<script lang="ts">',
      "import { ref } from 'vue'",
      'const stats = ref({ used: 0 })',
      'export default {',
      "  props: ['sessionId'],",
      '  setup(sessionId: string) {',
      '    const onMessage = useSessionEvents(sessionId)',
      "    onMessage('context.update', (msg) => {",
      '      stats.value = { used: msg.payload.used }',
      '    })',
      '    return { stats }',
      '  },',
      '}',
      '</script>',
      '<template><div /></template>',
    ].join('\n'),
  );
  expect(messages).toHaveLength(0);
});

test('边界: 对象字面量 defineProps({ sessionId })（运行时 props 声明形态）→ 报错', () => {
  const messages = lintVue(
    sfc(
      [
        "import { ref } from 'vue'",
        'const stats = ref({ used: 0 })',
        "defineProps({ sessionId: String })",
        'const onMessage = useSessionEvents(sessionId)',
        "onMessage('context.update', (msg) => {",
        '  stats.value = { used: msg.payload.used }',
        '})',
      ].join('\n'),
    ),
  );
  expect(messages).toHaveLength(1);
});
