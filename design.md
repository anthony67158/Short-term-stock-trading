# Design — 短线操盘台

这是本应用锁定的设计系统。后续所有页面和组件修改必须先读取本文件，
不得为单页重新发明色彩、字体、圆角或动效。

## Product intent

- Audience: 个人专业短线操盘者。
- Primary job: 打开页面后迅速判断“今天怎么做”，再进入持仓执行与研究。
- Tone: 专业、精密、克制、稳定。
- Information principle: 结论先于证据，执行先于解释，风险与失效条件始终可见。
- Containment principle: 每个区域只允许一个主容器；内部用排版、留白和分隔线区分，禁止卡片套卡片。

## Genre

`modern-minimal`

## Macrostructure family

- App views: `Workbench`。主结论置顶，数据与工具按任务顺序展开。
- Dialogs and drawers: 单一工作面板，不叠加装饰容器。
- Content and reports: `Long Document` 的连续阅读节奏，但沿用本系统主题。

## Navigation

- Desktop: `N13` 工作台变体。四个固定主入口 + 可见的“问军师”命令入口。
- Keyboard: `1–4` 切页，`⌘K / Ctrl+K / /` 打开军师，`Esc` 关闭最上层。
- Mobile: 顶部仅保留状态与工具，四个主入口进入固定底部导航。
- Clickable labels never wrap.

## Theme — Precision Cobalt

### Dark default

- `--color-paper` `oklch(14.5% 0.012 255)`
- `--color-paper-2` `oklch(18% 0.014 255)`
- `--color-paper-3` `oklch(21.5% 0.016 255)`
- `--color-ink` `oklch(94% 0.008 255)`
- `--color-ink-2` `oklch(78% 0.012 255)`
- `--color-rule` `oklch(29% 0.014 255)`
- `--color-accent` `oklch(68% 0.17 255)`
- `--color-focus` `oklch(75% 0.19 255)`

### Light variant

- `--color-paper` `oklch(97.5% 0.006 255)`
- `--color-paper-2` `oklch(99.2% 0.004 255)`
- `--color-paper-3` `oklch(95% 0.008 255)`
- `--color-ink` `oklch(22% 0.018 255)`
- `--color-ink-2` `oklch(35% 0.016 255)`
- `--color-rule` `oklch(84% 0.012 255)`
- `--color-accent` `oklch(56% 0.2 255)`
- `--color-focus` `oklch(52% 0.22 255)`

### Trading semantics

- A 股上涨/盈利: red, `--color-up`.
- A 股下跌/亏损: green, `--color-down`.
- Cobalt is interaction state only. It never replaces market semantics.
- Red and green are always paired with text, icon, sign or direction; colour is not the only signal.
- Accent occupies less than 5% of a viewport.

## Typography

- Display and wordmark: Space Grotesk Variable, weight 600–700, roman.
- Body and UI: Space Grotesk Variable with PingFang SC / Microsoft YaHei CJK fallback, weight 400.
- Numeric and machine labels: JetBrains Mono Variable, weight 500–650.
- Tabular figures on prices, money, percentages, times and model scores.
- No italic headings. No gradient text. No body copy below 12px; primary reading copy targets 14–15px.
- Chinese UI copy is compact and specific. Buttons use action verbs.

## Spacing

4-point named scale defined in `tokens.css`.

- Controls: 40px desktop, minimum 44px on coarse pointers.
- Primary page gap: `--space-lg`.
- Panel header: `--space-md` inline, `--space-sm` block.
- Inner data groups: `--space-xs` or hairline separators, not nested card padding.

## Radius and depth

- Primary surface: 10px.
- Input: 7px.
- Compact control: 6px.
- Pill: status and count only.
- Shadows are reserved for overlays. Normal content surfaces use lightness and rules.
- No coloured glow, glass cards, gradient CTA or universal hover lift.

## Motion

- Easings: `--ease-out`, `--ease-in`, `--ease-in-out`.
- Button press: 110ms, transform only.
- Tab indicator: 180ms.
- Modal/drawer: 280ms opacity + subtle transform.
- No page-wide repeated reveal and no card hover lift.
- Reduced motion: opacity only, at most 150ms.

## Microinteractions stance

- Silent success when the result is already visible.
- Errors state what failed and how to retry.
- Focus rings appear instantly.
- Hover effects only under `(hover: hover) and (pointer: fine)`.
- Inputs keep constant border thickness across all states.
- Reversible actions prefer Undo; irreversible account actions retain confirmation.

## CTA voice

- Primary: compact solid cobalt, 6px radius, one-line action label.
- Secondary: quiet surface or transparent border.
- Destructive: semantic red, never cobalt.
- Buttons never use a purple-to-blue gradient.

## Per-page hierarchy

- 今日决策: market verdict → action plan → AI candidates → supporting market evidence.
- 持仓执行: portfolio risk → holdings → watchlist → detailed trade tools.
- 账户闭环: total assets and cash → alerts → executions → review.
- 盘面研究: market flow → sectors → stocks → events and macro.
- 个股详情: current price and position → military-advisor action → trigger/invalidation → evidence → full analysis.

## What every view MUST share

- Wordmark, cobalt accent placement, fonts and numeric treatment.
- Page heading rhythm and one-layer surface model.
- Button, input, tab, table, modal and focus states.
- Mobile safe-area handling and 320px no-overflow guarantee.
- A 股 red-up / green-down semantics.

## What views MAY differ on

- Density: research may be denser than account and today.
- Grid: today may use 8/4 priority columns; research may use 7/5.
- Table-to-card collapse based on the information task.
- A single dark or light emphasis band when the data requires it.

## Exports

`tokens.css` is the source of truth. The blocks below are portability references.

### tokens.css

```css
:root {
  --color-paper: oklch(14.5% 0.012 255);
  --color-paper-2: oklch(18% 0.014 255);
  --color-paper-3: oklch(21.5% 0.016 255);
  --color-ink: oklch(94% 0.008 255);
  --color-ink-2: oklch(78% 0.012 255);
  --color-rule: oklch(29% 0.014 255);
  --color-accent: oklch(68% 0.17 255);
  --color-accent-ink: oklch(15% 0.012 255);
  --color-focus: oklch(75% 0.19 255);
  --font-display: "Space Grotesk Variable", "PingFang SC", sans-serif;
  --font-body: "Space Grotesk Variable", "PingFang SC", sans-serif;
  --font-mono: "JetBrains Mono Variable", ui-monospace, monospace;
  --space-xs: 0.75rem;
  --space-sm: 1rem;
  --space-md: 1.25rem;
  --space-lg: 1.5rem;
  --radius-card: 10px;
  --radius-input: 7px;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --dur-short: 180ms;
}
```

### Tailwind v4 `@theme`

```css
@theme {
  --color-paper: oklch(14.5% 0.012 255);
  --color-paper-2: oklch(18% 0.014 255);
  --color-paper-3: oklch(21.5% 0.016 255);
  --color-ink: oklch(94% 0.008 255);
  --color-ink-2: oklch(78% 0.012 255);
  --color-rule: oklch(29% 0.014 255);
  --color-accent: oklch(68% 0.17 255);
  --font-display: "Space Grotesk Variable", sans-serif;
  --font-body: "Space Grotesk Variable", sans-serif;
  --font-mono: "JetBrains Mono Variable", monospace;
  --spacing-xs: 0.75rem;
  --spacing-sm: 1rem;
  --spacing-md: 1.25rem;
  --spacing-lg: 1.5rem;
  --radius-card: 10px;
  --radius-input: 7px;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
}
```

### DTCG `tokens.json`

```json
{
  "$schema": "https://design-tokens.github.io/community-group/format/",
  "color": {
    "paper": { "$value": "oklch(14.5% 0.012 255)", "$type": "color" },
    "paper-2": { "$value": "oklch(18% 0.014 255)", "$type": "color" },
    "ink": { "$value": "oklch(94% 0.008 255)", "$type": "color" },
    "ink-2": { "$value": "oklch(78% 0.012 255)", "$type": "color" },
    "rule": { "$value": "oklch(29% 0.014 255)", "$type": "color" },
    "accent": { "$value": "oklch(68% 0.17 255)", "$type": "color" },
    "focus": { "$value": "oklch(75% 0.19 255)", "$type": "color" }
  },
  "font": {
    "display": { "$value": "Space Grotesk Variable, PingFang SC, sans-serif", "$type": "fontFamily" },
    "body": { "$value": "Space Grotesk Variable, PingFang SC, sans-serif", "$type": "fontFamily" },
    "mono": { "$value": "JetBrains Mono Variable, monospace", "$type": "fontFamily" }
  },
  "space": {
    "xs": { "$value": "0.75rem", "$type": "dimension" },
    "sm": { "$value": "1rem", "$type": "dimension" },
    "md": { "$value": "1.25rem", "$type": "dimension" },
    "lg": { "$value": "1.5rem", "$type": "dimension" }
  },
  "duration": {
    "micro": { "$value": "110ms", "$type": "duration" },
    "short": { "$value": "180ms", "$type": "duration" },
    "long": { "$value": "280ms", "$type": "duration" }
  }
}
```

### shadcn/ui CSS variables

```css
:root {
  --background: 14.5% 0.012 255;
  --foreground: 94% 0.008 255;
  --card: 18% 0.014 255;
  --card-foreground: 94% 0.008 255;
  --popover: 18% 0.014 255;
  --popover-foreground: 94% 0.008 255;
  --primary: 68% 0.17 255;
  --primary-foreground: 15% 0.012 255;
  --secondary: 21.5% 0.016 255;
  --secondary-foreground: 78% 0.012 255;
  --muted: 24% 0.014 255;
  --muted-foreground: 64% 0.012 255;
  --border: 29% 0.014 255;
  --input: 29% 0.014 255;
  --ring: 75% 0.19 255;
  --destructive: 62% 0.22 25;
  --destructive-foreground: 96% 0.008 255;
  --radius: 10px;
}
```
