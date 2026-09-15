<template>
  <!--
    引擎 pi 单色 icon（U3 D8）。几何来自 assets/icons/engine/pi.svg（currentColor 单色化版），
    禁止手改 path d——改几何回源 SVG 文件同步。viewBox 0 0 800 800（像素几何块），
    视觉尺寸由调用方 class 控制（size-*）。
  -->
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" aria-hidden="true">
    <path fill="currentColor" fill-rule="evenodd" d="
      M165.29 165.29
      H517.36
      V400
      H400
      V517.36
      H282.65
      V634.72
      H165.29
      Z
      M282.65 282.65
      V400
      H400
      V282.65
      Z
    "/>
    <path fill="currentColor" d="M517.36 400 H634.72 V634.72 H517.36 Z"/>
  </svg>
</template>
