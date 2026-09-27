/**
 * CodeTaste ESLint 基础配置 — TypeScript / Node.js 项目
 *
 * 使用：在项目 eslint.config.mjs 中导入
 *   import tasteConfig from './taste-lint/base.mjs';
 *   export default tasteConfig;
 *
 * 依赖：typescript-eslint
 */
import tseslint from 'typescript-eslint';
import preferAllsettled from './rules/prefer-allsettled.mjs';
import noSilentCatch from './rules/no-silent-catch.mjs';
import noUnsafeObjectEntries from './rules/no-unsafe-object-entries.mjs';
import noHardcodedColors from './rules/no-hardcoded-colors.mjs';
import noMagicSpacing from './rules/no-magic-spacing.mjs';
import noNativeHtmlElements from './rules/no-native-html-elements.mjs';
import noSwitchSizeOverride from './rules/no-switch-size-override.mjs';
import noEmojiInTemplate from './rules/no-emoji-in-template.mjs';
import preferVModel from './rules/prefer-v-model.mjs';
import noMultiArgEmit from './rules/no-multi-arg-emit.mjs';
import noUnboundedWhileTrue from './rules/no-unbounded-while-true.mjs';
import noInlineImportType from './rules/no-inline-import-type.mjs';
import noEslintDisable from './rules/no-eslint-disable.mjs';
import noUnsafeCast from './rules/no-unsafe-cast.mjs';
import requireDataOwnerAnnotation from './rules/require-data-owner-annotation.mjs';
import noNonOwnerStoreMutation from './rules/no-non-owner-store-mutation.mjs';
import noInstanceLevelSessionState from './rules/no-instance-level-session-state.mjs';
import noChatOpsInComponents from './rules/no-chat-ops-in-components.mjs';

export const tastePlugin = {
  meta: { name: 'eslint-plugin-taste' },
  rules: {
    'prefer-allsettled': preferAllsettled,
    'no-silent-catch': noSilentCatch,
    'no-unsafe-object-entries': noUnsafeObjectEntries,
    'no-hardcoded-colors': noHardcodedColors,
    'no-magic-spacing': noMagicSpacing,
    'no-native-html-elements': noNativeHtmlElements,
    // Switch 几何护栏：禁止消费方 h-*/w-*/size-* 覆盖轨道尺寸（thumb 绝对 px 几何失配
    // → 圆点溢出；trace toolbar 事故回归防线）。error 级 = 渲染缺陷阻断（同治理护栏逻辑），
    // 规则 docstring 登记动态 ：class 盲区与 Checkbox 扩展位。
    'no-switch-size-override': noSwitchSizeOverride,
    'no-emoji-in-template': noEmojiInTemplate,
    'prefer-v-model': preferVModel,
    'no-multi-arg-emit': noMultiArgEmit,
    // 以下 4 条迁自 @zhushanwen/pi-taste-lint（TS 向，适用于 pi extensions）。
    // 注册到插件但不在默认 tasteRules 启用——由 eslint.config.mjs 的 extensions/
    // override 块按需开启，不影响 renderer/runtime 代码。
    'no-unbounded-while-true': noUnboundedWhileTrue,
    'no-inline-import-type': noInlineImportType,
    'no-eslint-disable': noEslintDisable,
    'no-unsafe-cast': noUnsafeCast,
    // 数据源治理护栏（data-source-governance P0，plan W4）：R3 缓存注解 + R2 store 写入口。
    // error 级（非品味类 warn）——治理护栏的语义是阻断（对齐 R1 pre-commit 检查退出非 0），
    // 误报豁免走登记表 + 行内豁免注释闭环，见各规则 docstring。
    'require-data-owner-annotation': requireDataOwnerAnnotation,
    'no-non-owner-store-mutation': noNonOwnerStoreMutation,
    // ADR-0049 范式盲区护栏（context-consistency-design D5/G1）：session 事件 handler
    // 直写组件实例级 ref = 生命周期错位，error 级阻断；豁免走行内登记注释（规则 docstring）。
    'no-instance-level-session-state': noInstanceLevelSessionState,
    // chat store facet 护栏（renderer-deepening D6③/A8）：组件只碰 ChatStoreReaders 面，
    // ops 面字段访问 error 级阻断。规则内自守卫（仅 src/components/** 的 .vue 生效）。
    'no-chat-ops-in-components': noChatOpsInComponents,
  },
};

/** 品味规则配置，可在 vue.mjs 等扩展配置中复用 */
export const tasteRules = {
  // 类型即契约
  '@typescript-eslint/no-explicit-any': 'error',

  // 未使用变量：`_` 前缀 = 显式标记「故意未使用」（参数/变量/catch 错误）
  // 行业标准约定，避免为 mock/占位参数被迫加 disable 注释
  '@typescript-eslint/no-unused-vars': ['error', {
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrorsIgnorePattern: '^_',
  }],

  // 缩进：仅允许 space
  'indent': ['warn', 2, { SwitchCase: 1 }],

  // 结构先于一切
  'max-lines': ['warn', { max: 500, skipBlankLines: true, skipComments: true }],
  'max-lines-per-function': ['warn', { max: 300, skipBlankLines: true, skipComments: true }],

  // 语义化命名
  'no-magic-numbers': ['warn', {
    ignore: [0, 1, -1],
    ignoreArrayIndexes: true,
  }],

  // 反馈不断裂
  'no-empty': 'error',

  // 安全无例外
  'no-eval': 'error',
  'no-implied-eval': 'error',

  // 品味自定义规则
  'taste/prefer-allsettled': 'warn',
  'taste/no-silent-catch': 'warn',
  'taste/no-unsafe-object-entries': 'warn',
  'taste/no-native-html-elements': 'warn',
  'taste/no-switch-size-override': 'error',
  'taste/no-emoji-in-template': 'warn',
  'taste/prefer-v-model': 'warn',
  'taste/no-multi-arg-emit': 'warn',

  // 数据源治理护栏（data-source-governance P0）：R3 模块级缓存 @data-owner 注解 +
  // R2 store mutation 许可文件直呼。error 级 = 阻断（规则内部自带范围/豁免裁定）。
  'taste/require-data-owner-annotation': 'error',
  'taste/no-non-owner-store-mutation': 'error',

  // ADR-0049 范式盲区护栏（context-consistency-design D5/G1）：session 事件 handler
  // 直写组件实例级 ref（切 session 丢值/串台）。仅 .vue 生效（规则内自守卫），error 级。
  'taste/no-instance-level-session-state': 'error',

  // chat store facet 护栏（renderer-deepening D6③/A8）：组件只碰 readers 面，ops 面字段
  // 访问拦截。仅 src/components/** 的 .vue 生效（规则内自守卫，composables/stores/
  // effects/tests 不受限），error 级 = 阻断。
  'taste/no-chat-ops-in-components': 'error',
};

export default [
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    plugins: { taste: tastePlugin },
    rules: tasteRules,
  },
  {
    // [HISTORICAL] `**/__tests__/**/*.ts`（2026-08-23 补）：__tests__ 下的非 *.test.ts
    // 文件（fixture/helper/setup/impl-token）与 *.test.ts 同属测试代码，测试数据中的
    // 领域数值（如 smart-context 阈值 200_000）对 no-magic-numbers 是误报——测试豁免
    // 按文件名维度漏掉了测试基建文件。.vue 测试壳组件（__tests__/**/*.vue）不豁免，
    // 仍受 no-native-html-elements 等渲染层规则约束。
    ignores: ['node_modules/**', 'dist/**', 'frontend-dist/**', 'frontend/dist/**', 'frontend/node_modules/**', 'frontend/.vite/**', '*.d.ts', '**/*.generated.*', '**/*.test.ts', '**/*.spec.ts', '**/__tests__/**/*.ts'],
  },
];
