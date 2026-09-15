/**
 * 品味规则：emit 只传单个 payload 对象
 *
 * emit('event', arg1, arg2) 中 handler 极易混淆参数顺序。
 * 必须改为 emit('event', { arg1, arg2 })。
 *
 * 参考：CLAUDE.md 关键规则 #1
 */
export default {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Disallow emit/$emit with multiple payload arguments — use a single payload object',
    },
    messages: {
      multiArgEmit:
        'emit 应只传单个 payload 对象，避免 handler 混淆参数顺序。改为 emit(\'{{eventName}}\', { arg1, arg2 })',
    },
  },

  create(context) {
    return {
      CallExpression(node) {
        const { callee, arguments: args } = node;

        // 匹配 emit(...) 或 $emit(...)
        const isEmit =
          (callee.type === 'Identifier' && callee.name === 'emit') ||
          (callee.type === 'MemberExpression' &&
            callee.property.type === 'Identifier' &&
            callee.property.name === '$emit');

        if (!isEmit) return;

        // 2 个参数以内是合法的：emit('name') 或 emit('name', payload)
        if (args.length <= 2) return;

        const eventName =
          args[0].type === 'Literal' && typeof args[0].value === 'string'
            ? args[0].value
            : '<event>';

        context.report({
          node,
          messageId: 'multiArgEmit',
          data: { eventName },
        });
      },
    };
  },
};
