<template>
  <!-- 安装确认卡的知情面字段块（S27）：标签 + 全量逐项列出；空声明显示显式占位 -->
  <div>
    <p class="text-[length:var(--text-2xs)] font-semibold text-neutral-fg">{{ label }}</p>
    <ul v-if="items.length" :data-testid="testId" class="mt-1 flex flex-col gap-0.5">
      <li
        v-for="item in items"
        :key="item"
        class="font-mono text-[length:var(--text-3xs)] text-neutral-mid"
      >{{ item }}</li>
    </ul>
    <p v-else :data-testid="testId" class="mt-1 text-[length:var(--text-3xs)] text-neutral-dim">{{ emptyLabel }}</p>
  </div>
</template>

<script setup lang="ts">
/** 确认卡字段块（纯受控展示）。 */
defineProps<{
  /** 字段标签（能力声明 / 读取路径 / 权限） */
  label: string
  /** 声明清单（全量逐项展示，不截断——S27 知情面） */
  items: string[]
  /** 空声明占位文案 */
  emptyLabel: string
  /** 测试锚（S27 断言用） */
  testId: string
}>()
</script>
