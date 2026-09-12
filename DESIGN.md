---
name: xyz-agent
description: AI Agent 桌面工作台 · Warm & Soft 设计系统
colors:
  bg: "oklch(97% 0.018 70)"
  surface: "oklch(99% 0.008 70)"
  fg: "oklch(22% 0.02 50)"
  muted: "oklch(50% 0.018 50)"
  border: "oklch(90% 0.014 70)"
  accent: "oklch(64% 0.13 28)"
  accent-light: "oklch(92% 0.04 28)"
  success: "oklch(70% 0.18 145)"
  success-light: "oklch(95% 0.06 145)"
  warning: "oklch(78% 0.15 85)"
  warning-light: "oklch(95% 0.06 85)"
  danger: "oklch(62% 0.2 25)"
  danger-light: "oklch(93% 0.06 25)"
typography:
  display:
    fontFamily: "'Tiempos Headline', 'Newsreader', 'Iowan Old Style', Georgia, serif"
    fontSize: "16px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "normal"
  mono:
    fontFamily: "'JetBrains Mono', 'IBM Plex Mono', ui-monospace, Menlo, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  overline:
    fontFamily: "-apple-system, BlinkMacSystemFont, system-ui, sans-serif"
    fontSize: "10px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "0.04em"
rounded:
  xs: "4px"
  sm: "8px"
  md: "12px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "white"
    rounded: "{rounded.xs}"
    padding: "6px 12px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.sm}"
    padding: "5px 12px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    rounded: "{rounded.sm}"
    padding: "10px 14px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    rounded: "{rounded.md}"
    padding: "10px 14px"
  chip:
    backgroundColor: "{colors.accent-light}"
    textColor: "{colors.accent}"
    rounded: "100px"
    padding: "2px 8px"
---

> ⚠️ **DEPRECATED by [ADR-0019](docs/adr/0019-visual-direction.md)** (2026-06-18).
> Warm & Soft 设计系统已被推翻。真身见 [docs/page-design/v6-tokens.css](docs/page-design/v6-tokens.css)（原子值 SSOT）+ [docs/page-design/v6-master-spec.md](docs/page-design/v6-master-spec.md)（范式 SSOT；原 design-tokens.md / design-system.md 已删除，git 可追溯）。
> 本文件保留作历史参考，不再作为当前规范。

# Design System: xyz-agent (DEPRECATED · Warm & Soft)

## 1. Overview

**Creative North Star: "The Warm Workbench"**

A desk you sit at for six hours. Not a dashboard you glance at for thirty seconds. Every decision serves stamina: low contrast, warm neutrals, generous whitespace, and transitions so gentle you barely notice them. The visual system is restrained to the point of austerity, except for one warm terracotta accent that appears only where action is required.

The interface rejects the cold precision of traditional developer tools and the sterile minimalism of chat-first AI products. It borrows warmth from editorial print design, structure from desktop publishing software, and feedback clarity from observability dashboards, without becoming any of those things.

**Key Characteristics:**
- One accent color (terracotta), used on less than 10% of any screen
- OKLch color space for perceptually uniform warmth across light and dark themes
- Serif display font for brand identity only; everything else is system sans-serif
- No gradients, no glassmorphism, no decorative shadows
- All surfaces tinted toward the brand hue; never pure black or white

## 2. Colors

The palette is built on a single warm hue family (approx. 70° in OKLch, a warm orange-brown) with one saturated accent and semantic status colors. Every neutral is tinted toward this hue so the interface never feels gray or cold.

### Primary
- **Terracotta** (`oklch(64% 0.13 28)`): The one accent. Used for send buttons, active tab underlines, links, session list active borders, and the "-agent" suffix in the logo. Never exceeds 2 instances per screen.
- **Terracotta Light** (`oklch(92% 0.04 28)`): Hover backgrounds for interactive elements, user message bubbles, selected states. Low chroma to avoid visual noise.

### Semantic Colors
- **Success Green** (`oklch(70% 0.18 145)`): Running states, completed SubAgent marks, connection status. Same value in light and dark themes for guaranteed contrast.
- **Warning Amber** (`oklch(78% 0.15 85)`): Paused states, simple question notifications.
- **Danger Red** (`oklch(62% 0.2 25)`): Termination hover, request-response notifications, inline alert messages.

Each semantic color has a matching "-light" variant for background tints (success-light, warning-light, danger-light).

### Neutral
- **Background** (`oklch(97% 0.018 70)`): Warm cream. The canvas everything sits on.
- **Surface** (`oklch(99% 0.008 70)`): Near-white with a whisper of warmth. Cards, panels, headers, input backgrounds.
- **Foreground** (`oklch(22% 0.02 50)`): Deep warm brown-black. All body text.
- **Muted** (`oklch(50% 0.018 50)`): Mid warm gray. Timestamps, descriptions, secondary labels.
- **Border** (`oklch(90% 0.014 70)`): Warm light gray. Dividers, card borders, input borders at rest.

### Dark Theme
Dark is not an inversion. It is a re-tinted palette with the same hue family:
- Background: `oklch(20% 0.015 50)` — deep warm brown-black
- Surface: `oklch(25% 0.015 50)` — slightly lifted panel
- Foreground: `oklch(92% 0.008 70)` — warm near-white
- Accent: `oklch(68% 0.13 28)` — slightly brighter terracotta for dark contrast

### Named Rules
**The One Voice Rule.** The primary accent is used on less than 10% of any given screen. Its rarity is the point. If a screen has more than 2 accent-colored elements, something is wrong.

**The Tinted Neutral Rule.** Never use `#000` or `#fff`. Every neutral carries a trace of the brand hue (chroma 0.005–0.01 is enough). This is what makes the interface feel warm rather than clinical.

## 3. Typography

**Display Font:** Tiempos Headline, Newsreader, Iowan Old Style, Georgia, serif
**Body Font:** -apple-system, BlinkMacSystemFont, system-ui, sans-serif
**Mono Font:** JetBrains Mono, IBM Plex Mono, ui-monospace, Menlo, monospace

**Character:** The pairing is "editorial warmth meets system clarity." Display font appears only for brand identity and page titles (no more than 3 instances per screen). Everything functional uses the system sans-serif for maximum readability at small sizes. Mono is strictly for code, paths, IDs, and metadata.

### Hierarchy
- **Display** (700, 16px, line-height 1.2): Logo, settings page titles, drawer titles, Overview title. Letter-spacing -0.01em.
- **Headline** (600, 15px, line-height 1.3): Drawer subtitles, settings section headers.
- **Title** (600, 13–14px, line-height 1.4): Session card titles, done/alert item names.
- **Body** (400, 14px, line-height 1.6): Message content, descriptions. Max line length 65–75ch.
- **Small** (400, 12–13px, line-height 1.5): Session list items, tabs, anchors, button text.
- **Caption** (400–600, 10–11px, line-height 1.4): Timestamps, status metadata, role labels, header buttons.
- **Overline** (600, 10–11px, line-height 1.4): Group headers, section labels. Uppercase with letter-spacing 0.04–0.06em.
- **Mono body** (400, 11–12px, line-height 1.5): Tool call content, tree node metadata.

### Named Rules
**The Display Rarity Rule.** The serif display font appears no more than 3 times per screen. It is a brand flourish, not a workhorse.

**The Mono Containment Rule.** Monospace is never used for body paragraphs. It is exclusively for code, file paths, model names, token counts, and IDs.

## 4. Elevation

This system is flat by default. Depth is conveyed through tonal layering (background → surface → elevated surface) rather than shadows. Shadows are used sparingly and only as state responses.

### Shadow Vocabulary
- **Micro** (`0 1px 6px rgba(0,0,0,0.04)`): Input container at rest.
- **Lift** (`0 2px 12px rgba(0,0,0,0.08)`): Input container on focus.
- **Menu** (`0 4px 16px rgba(0,0,0,0.08)`): Anchor dropdowns, model selector.
- **Toast** (`0 4px 20px rgba(0,0,0,0.1)`): Toast notifications.
- **Card hover** (`0 8px 30px rgba(0,0,0,0.15)`): Overview cards on hover only.

### Backdrop
- **Overview overlay** (`oklch(15% 0.02 50/0.65)` + `backdrop-filter: blur(20px)`): Mission Control background.
- **Drawer overlay** (`rgba(0,0,0,0.15)`): Subtle dimming behind drawers.

### Named Rules
**The Flat-By-Default Rule.** Surfaces are flat at rest. Shadows appear only as a response to state: hover elevation, focus lift, menu popup, toast arrival. If a card has a shadow while at rest, it is wrong.

## 5. Components

### Buttons
- **Shape:** 8px radius for icon buttons, 4px for text buttons, 100px for pill-shaped notification buttons.
- **Primary:** Accent background, white text, 4px radius. Hover: opacity 0.88. Used only for send actions and primary CTAs.
- **Ghost:** Transparent background, muted text, 8px radius, 1px border. Hover: accent-light background, accent text, accent border. The default button style.
- **Icon buttons:** 34×34px square, 8px radius. Used in header for view mode toggles.

### Chips
- **Style:** Pill-shaped (100px radius), background tinted with semantic color, matching text color.
- **Done chip:** success-light background, success text.
- **Alert chip:** danger-light background, danger text. Number badge inside is solid danger with white text.
- **Hover:** Border color shifts to match the semantic color.

### Cards / Containers
- **Corner Style:** 12px radius for message bubbles and input containers; 8px for tool call cards and system messages.
- **Background:** Surface color.
- **Shadow Strategy:** None at rest. See Elevation section for state-based shadows.
- **Border:** 1px border color for assistant messages, tool calls, and system messages.
- **User message:** No border; accent-light background with asymmetric radius (bottom-right 4px).

### Inputs / Fields
- **Style:** Textarea has no border, transparent background, sits inside a rounded container (12px radius) with 1px border.
- **Focus:** Container border shifts to accent, shadow lifts to "Lift" level.
- **Placeholder:** Muted color. Text: "输入消息… (Enter 发送, Shift+Enter 换行, / 命令)"

### Navigation (Header)
- **Height:** 48px, surface background, 1px bottom border.
- **Logo:** Display font, 16px, bold. "xyz" in fg, "-agent" in accent.
- **Notification buttons:** Pill-shaped with absolute-positioned dot badges.
- **View buttons:** 34×34px icon buttons. Active state: accent-light background, accent text, accent border.

### Sidebar (Session List)
- **Width:** 240px fixed.
- **Group headers:** 11px, uppercase, letter-spacing 0.04em, muted color, with chevron toggle.
- **Session items:** 24px left indent, 3px left border (accent when active), 13px title text.
- **Status dots:** 7×7px. Running: green with 2s pulse. Paused: amber. Idle: border color.

### Task Tree (Drawer)
- **Root node:** Bold, no left border.
- **Child nodes:** 16px indent, 1px vertical line, 7px status dot.
- **Hover:** Kill button appears on the right (hidden by default).
- **Toggle:** 14×14px chevron, rotated -90deg when collapsed.

### Model Selector (Toolbar)
- **Format:** `model @ provider` in mono font, 11px.
- **Dropdown:** Bottom-pop, z-index 200, grouped by "常用" + provider sections.

## 6. Do's and Don'ts

### Do:
- **Do** use OKLch for all colors. The perceptual uniformity matters for warmth.
- **Do** keep the accent terracotta to less than 10% of any screen surface.
- **Do** use the display serif font for the logo, drawer titles, and Overview heading only.
- **Do** animate with `cubic-bezier(0.4, 0, 0.2, 1)` (Material standard easing) for all transitions.
- **Do** use 8px base grid for spacing. Vary padding for rhythm — same padding everywhere is monotony.
- **Do** cap body text line length at 65–75ch.
- **Do** use tonal layering (bg → surface) to convey depth instead of default shadows.
- **Do** respect `prefers-reduced-motion` by disabling pulse animations and simplifying transitions.

### Don't:
- **Don't** use `#000` or `#fff`. Tint every neutral toward the brand hue.
- **Don't** use gradient text (`background-clip: text` with gradients). Use a single solid color.
- **Don't** use side-stripe borders (border-left > 1px as a colored accent on cards or alerts). Use full borders, background tints, or leading icons instead.
- **Don't** use glassmorphism as a default. Blurs are rare and purposeful, or nothing.
- **Don't** use the hero-metric template (big number + small label + gradient accent).
- **Don't** use identical card grids (same icon + heading + text repeated endlessly).
- **Don't** use modals as a first choice for new information. Exhaust inline and progressive alternatives first.
- **Don't** use bounce, elastic, or spring animations. Ease-out with exponential curves only.
- **Don't** animate CSS layout properties (width, height, top, left). Use transform and opacity.
- **Don't** use em dashes in copy. Use commas, colons, semicolons, periods, or parentheses.

## 7. 设计参考文档

- [UI/UX 设计原则与参考](docs/page-design/ui-design-principles.md) — 认知负荷/格式塔/渐进披露等设计方法论 + 竞品案例 + 行动清单
