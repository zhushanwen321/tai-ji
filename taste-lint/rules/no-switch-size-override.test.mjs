/**
 * no-switch-size-override 规则用例（trace toolbar Switch 圆点溢出事故回归防线，修前红/修后绿）。
 *
 * 覆盖面：报错主路径（rem 类 h-3.5 w-6 / 绝对 px h-[20px] / w-full / size-4 / 事故原始
 * 形态 `h-3.5 w-6 scale-90` 每个 token 各报一条）、合法形态放行（等比 scale-90、
 * shrink-0 / mt-0.5 / 定位类、无 class、min-w-* / max-h-* 负向后行不误报、跨行标签、
 * 自闭合标签、:class 字面量内 token 同样捕获）、范围守卫（components/ui 豁免、
 * 非 .vue 文件不扫、<SwitchRoot> 等 PascalCase 后缀不误命中、模板外 script 不扫）、
 * 同 token 去重（多处 h-3.5 只报一次避免刷屏）。
 * vitest + eslint Linter 直挂规则（no-unbounded-while-true.test.mjs 同款跑法），
 * parser 与 taste-lint/vue.mjs 同构：vue-eslint-parser 外层 + typescript-eslint 内层
 * （no-chat-ops-in-components.test.mjs 同款；纯 ts 内层解析不了 vue 模板）。
 * 运行：npx vitest run taste-lint（仓库根，与 CI ci.yml 同命令）
 */
import { test, expect } from 'vitest';
import { Linter } from 'eslint';
import vueParser from 'vue-eslint-parser';
import tseslint from 'typescript-eslint';
import rule from './no-switch-size-override.mjs';

const RULE_ID = 'taste/no-switch-size-override';
const PROBE_FILE = 'packages/renderer/src/components/panel/trace/TraceToolbar.vue';

/** 与仓库 taste-lint/vue.mjs 的 .vue 块同构的最小配置 */
function lintVue(templateBody, filename = PROBE_FILE) {
  const linter = new Linter();
  return linter.verify(
    `<template>\n${templateBody}\n</template>\n\n<script setup lang="ts">\nconst x = 1\n</` + `script>\n`,
    {
      files: ['**/*.vue'],
      languageOptions: {
        parser: vueParser,
        parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.vue'] },
      },
      plugins: { taste: { rules: { 'no-switch-size-override': rule } } },
      rules: { [RULE_ID]: 'error' },
    },
    { filename },
  );
}

function tokensOf(messages) {
  return messages.map((m) => m.message.match(/禁止用 (\S+) 覆盖/)?.[1]);
}

const lines = (...xs) => xs.join('\n');

// —— 报错主路径 ——

test('事故原始形态：h-3.5 与 w-6 各报一条，scale-90 不报', () => {
  const messages = lintVue('  <Switch :model-value="v" class="h-3.5 w-6 scale-90" />');
  expect(messages).toHaveLength(2);
  expect(tokensOf(messages).sort()).toEqual(['h-3.5', 'w-6']);
});

test('rem 类 h-5/w-9/size-4 全部报错', () => {
  const messages = lintVue('  <Switch class="h-5 w-9 size-4" />');
  expect(tokensOf(messages).sort()).toEqual(['h-5', 'size-4', 'w-9']);
});

test('绝对 px 任意值 h-[20px] 同样报错（覆盖轨道即失配，与单位无关）', () => {
  const messages = lintVue('  <Switch class="h-[20px] w-[36px]" />');
  expect(tokensOf(messages).sort()).toEqual(['h-[20px]', 'w-[36px]']);
});

test('w-full 报错', () => {
  const messages = lintVue('  <Switch class="w-full" />');
  expect(tokensOf(messages)).toEqual(['w-full']);
});

test(':class 字面量内的尺寸 token 同样捕获', () => {
  const messages = lintVue(`  <Switch :class="compact ? 'h-3.5 w-6' : ''" />`);
  expect(tokensOf(messages).sort()).toEqual(['h-3.5', 'w-6']);
});

test('跨行标签内 class 报错，行号锚定到 class 行', () => {
  const messages = lintVue(
    lines(
      '  <Switch',
      '    :model-value="v"',
      '    class="h-4"',
      '  />',
    ),
  );
  expect(messages).toHaveLength(1);
  // templateBody 从文件第 2 行开始：class 在 templateBody 第 3 行 → 文件第 4 行
  expect(messages[0].line).toBe(4);
});

test('嵌套 <template v-if> 之后的 Switch 不漏扫（TraceToolbar 事故回归锚）', () => {
  const messages = lintVue(
    lines(
      '  <template v-if="ok">',
      '    <span>a</span>',
      '  </template>',
      '  <template v-else>',
      '    <span>b</span>',
      '  </template>',
      '  <Switch :model-value="v" class="h-3.5 w-6" />',
    ),
  );
  expect(tokensOf(messages).sort()).toEqual(['h-3.5', 'w-6']);
});

// —— 合法形态放行 ——

test('等比 scale-* 放行（推荐的缩小方式）', () => {
  expect(lintVue('  <Switch class="scale-90" />')).toHaveLength(0);
  expect(lintVue('  <Switch class="scale-75 shrink-0" />')).toHaveLength(0);
});

test('无关布局类放行', () => {
  expect(lintVue('  <Switch class="mt-0.5 shrink-0 translate-x-2" />')).toHaveLength(0);
});

test('无 class 的 Switch 放行', () => {
  expect(lintVue('  <Switch :model-value="v" />')).toHaveLength(0);
});

test('min-w-*/max-h-* 不误报（负向后行排除）', () => {
  expect(lintVue('  <Switch class="max-w-full min-h-0" />')).toHaveLength(0);
});

test('同 token 多处只报一次（去重防刷屏）', () => {
  const messages = lintVue(
    lines('  <Switch class="h-3.5" />', '  <Switch class="h-3.5" />'),
  );
  expect(messages).toHaveLength(1);
});

// —— 范围守卫 ——

test('components/ui/ 内部实现豁免', () => {
  expect(lintVue('  <Switch class="h-3.5 w-6" />', 'packages/renderer/src/components/ui/switch/Switch.vue')).toHaveLength(0);
});

test('非 .vue 文件不扫', () => {
  // .ts 文件名下 vue parser 可能产生 ruleId=null 的解析提示，只看本规则的报错
  const messages = lintVue('  <Switch class="h-3.5" />', 'packages/renderer/src/lib/utils.ts');
  expect(messages.filter((m) => m.ruleId === RULE_ID)).toHaveLength(0);
});

test('PascalCase 后缀组件名不误命中（<SwitchRoot> 非 <Switch>）', () => {
  expect(lintVue('  <SwitchRoot class="h-3.5" />')).toHaveLength(0);
});

test('模板外 script 中的字符串不扫', () => {
  const messages = lintVue('  <div :class="cls" />\n  <!-- cls = \'h-3.5 w-6\' 在 script 里 -->');
  expect(messages).toHaveLength(0);
});
