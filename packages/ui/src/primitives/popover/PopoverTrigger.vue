<script setup lang="ts">
import { PopoverTrigger } from 'reka-ui'
</script>

<template>
  <!-- as-child：让触发器（通常是 Button）成为 trigger，不加额外 DOM 包裹 -->
  <PopoverTrigger as-child>
    <slot />
  </PopoverTrigger>
</template>
