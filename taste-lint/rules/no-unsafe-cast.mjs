/**
 * 品味规则：检测不安全的类型断言（type-erasing casts）
 *
 * 背景：`as never` / `as any` / `as unknown as T` 会绕过 TypeScript 类型检查，
 * 是「规范说禁止 any，实现用 as 断言偷偷绕过」的主要规避手段。
 * 曾导致 subagents 的 session_start handler 参数签名 bug（从错误对象读 modelRegistry）。
 *
 * 本规则为 warn 级（不阻断 commit），但在 review 时可见，提醒：
 * - 新增此类断言时，必须有配套的运行时 guard 或 SDK 契约测试
 * - 优先用类型守卫函数（isXxx）或精确类型替代
 *
 * 检测模式：
 *   1. `x as never`          — 抹除所有类型信息（最危险）
 *   2. `x as any`            — 退化为 any
 *   3. `x as unknown as T`   — 双重断言绕过结构兼容性检查
 *   4. `x as { ... }`        — 结构断言（如 `ctx as { modelRegistry?: unknown }`），
 *      当目标类型全是可选属性时，任何对象都能通过——需运行时校验
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Detect type-erasing casts (as never / as any / as unknown as) that bypass type safety',
    },
    messages: {
      castNever:
        '`as never` 抹除了所有类型信息，TypeScript 无法校验。' +
        '若不可避免（如跨 tsconfig 泛型冲突），必须加运行时 guard 或 SDK 契约测试。',
      castAny:
        '`as any` 退化为 any，违反「禁止 any」规范。用 unknown + 类型守卫，或精确类型替代。',
      doubleCast:
        '`as unknown as T` 双重断言绕过结构兼容性检查。' +
        '确认源类型与目标类型确实不兼容，否则用直接断言或类型守卫。',
      structuralCast:
        '结构断言到全可选属性类型（`as { x?: ... }`）——任何对象都能通过，等于无校验。' +
        '改用类型守卫函数，或确保目标类型有必填字段。',
    },
  },
  create(context) {
    function isAllOptionalProperties(typeAnnotation) {
      // 检测 `as { a?: ...; b?: ... }` —— TSAsExpression 的 typeAnnotation 是 TSTypeAnnotation
      // 其中的类型是 TSTypeLiteral，包含 members
      const literal = typeAnnotation?.type === 'TSTypeLiteral' ? typeAnnotation : null;
      if (!literal?.members?.length) return false;
      // 所有成员必须是可选属性且是 PropertySignature。
      // Round 1 MF#3: typescript-eslint ESTree 用 `optional: boolean` 标记可选属性
      // （非 ts 原生 questionToken token）；此前用 m.questionToken 永远 undefined，
      // 导致 structuralCast 从不触发——测试覆盖暴露此 bug。
      return literal.members.every(
        (m) => m.type === 'TSPropertySignature' && (m.optional || m.questionToken),
      );
    }

    return {
      TSAsExpression(node) {
        const type = node.typeAnnotation;
        const typeName = type?.type;

        // x as never
        if (typeName === 'TSNeverKeyword') {
          context.report({ node, messageId: 'castNever' });
          return;
        }
        // x as any
        if (typeName === 'TSAnyKeyword') {
          context.report({ node, messageId: 'castAny' });
          return;
        }
        // x as unknown as T —— 检测链式：外层 as 的 expression 是另一个 TSAsExpression 且内层是 unknown
        if (
          typeName !== 'TSUnknownKeyword' &&
          node.expression?.type === 'TSAsExpression' &&
          node.expression.typeAnnotation?.type === 'TSUnknownKeyword'
        ) {
          context.report({ node, messageId: 'doubleCast' });
          return;
        }
        // x as { allOptional?: ... } —— 结构断言到全可选类型
        if (isAllOptionalProperties(type)) {
          context.report({ node, messageId: 'structuralCast' });
        }
      },
    };
  },
};
