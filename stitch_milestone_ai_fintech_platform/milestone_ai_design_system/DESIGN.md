---
name: Milestone AI Design System
colors:
  surface: '#f9f9ff'
  surface-dim: '#cadaff'
  surface-bright: '#f9f9ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f1f3ff'
  surface-container: '#e8edff'
  surface-container-high: '#e0e8ff'
  surface-container-highest: '#d7e2ff'
  on-surface: '#041b3c'
  on-surface-variant: '#414753'
  inverse-surface: '#1d3052'
  inverse-on-surface: '#edf0ff'
  outline: '#717785'
  outline-variant: '#c1c6d6'
  surface-tint: '#005cba'
  primary: '#0058b2'
  on-primary: '#ffffff'
  primary-container: '#0070e0'
  on-primary-container: '#f9f9ff'
  inverse-primary: '#abc7ff'
  secondary: '#505f76'
  on-secondary: '#ffffff'
  secondary-container: '#d0e1fb'
  on-secondary-container: '#54647a'
  tertiary: '#525970'
  on-tertiary: '#ffffff'
  tertiary-container: '#6a7289'
  on-tertiary-container: '#f9f8ff'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#d7e3ff'
  primary-fixed-dim: '#abc7ff'
  on-primary-fixed: '#001b3f'
  on-primary-fixed-variant: '#00458f'
  secondary-fixed: '#d3e4fe'
  secondary-fixed-dim: '#b7c8e1'
  on-secondary-fixed: '#0b1c30'
  on-secondary-fixed-variant: '#38485d'
  tertiary-fixed: '#dae2fd'
  tertiary-fixed-dim: '#bec6e0'
  on-tertiary-fixed: '#131b2e'
  on-tertiary-fixed-variant: '#3f465c'
  background: '#f9f9ff'
  on-background: '#041b3c'
  surface-variant: '#d7e2ff'
typography:
  display-lg:
    fontFamily: Inter
    fontSize: 48px
    fontWeight: '600'
    lineHeight: 56px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: '600'
    lineHeight: 40px
    letterSpacing: -0.015em
  headline-lg-mobile:
    fontFamily: Inter
    fontSize: 26px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.01em
  headline-md:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.01em
  headline-sm:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
    letterSpacing: -0.005em
  title-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '600'
    lineHeight: 24px
    letterSpacing: 0em
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
    letterSpacing: 0em
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
    letterSpacing: 0em
  body-sm:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
    letterSpacing: 0em
  label-md:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '600'
    lineHeight: 16px
    letterSpacing: 0.02em
  label-sm:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: '500'
    lineHeight: 14px
    letterSpacing: 0.03em
  metric-display:
    fontFamily: Inter
    fontSize: 28px
    fontWeight: '600'
    lineHeight: 34px
    letterSpacing: -0.02em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  gutter: 1.5rem
  gutter-sm: 1rem
  gutter-lg: 2rem
  margin: 2rem
  margin-mobile: 1rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 1rem
  space-lg: 1.5rem
  space-xl: 2rem
---

## Brand & Style

This design system embodies high-trust, institutional clarity combined with the streamlined ergonomics of modern developer and financial tools. Crafted for financial analysts, founders, and finance operators, the interface evokes poise, structural rigor, and total predictability. 

The aesthetic is anchored in an elevated, precision-driven **Corporate Modern** style—drawing direct lineage from clean fintech benchmarks like Stripe, Linear, and modern institutional banking. Visual clutter, ornamental gradients, and synthetic high-tech flourishes (such as glowing neon or pseudo-cryptographic elements) are strictly avoided. Instead, the design relies on razor-sharp information hierarchy, crisp structural borders, subtle neutral surfaces, and intentional typography that prioritizes fast financial scanning and confident decision-making.

## Colors

The palette is engineered for prolonged data-dense workflows, balancing extreme contrast ratios with a soft, glare-free working background.

- **Background Canvas (`#F7F9FC`)**: The master canvas tint, providing a clean separation from pure white elevated containers.
- **Surface / Card (`#FFFFFF`)**: The foundational surface for data grids, analytics widgets, balance summaries, and modals.
- **Primary Brand Blue (`#0070E0`)**: A vivid, confident corporate blue reserved strictly for primary interactive states, key transaction actions, focus halos, and core progress indicators.
- **Text Primary (`#172B4D`)**: Deep navy-slate providing maximum legibility without the jarring starkness of pure black.
- **Text Secondary / Muted (`#64748B`)**: Balanced slate used for supporting labels, column metadata, chart legends, and non-active timestamps.
- **Subtle Border (`#E2E8F0`)**: Hairline dividers and bounding boxes for cards, table rows, and inputs.
- **Functional Semantics**:
  - Success: `#059669` (Dark emerald for positive inflows and settled states)
  - Warning: `#D97706` (Amber for pending verifications)
  - Critical: `#DC2626` (Red for failed transactions or clawbacks)

## Typography

The design system utilizes **Inter** exclusively across all scales to maintain consistent vertical rhythm and high tabular legibility.

- **Tabular Numerals**: In all financial tables, metric cards, ledgers, and account lists, apply OpenType features `tnum` (tabular figures) and `cv05` to guarantee monotonic alignment of values and periods across multiple rows.
- **Weight Restraint**: Restrict weights strictly to `400` (Regular), `500` (Medium), and `600` (Semi-Bold). Avoid `700` and `800` weights to prevent visual blockiness in data-dense interfaces.
- **Letter Spacing**: Maintain negative tracking (`-0.01em` to `-0.02em`) on display sizes for a cohesive editorial headline feel. Use slight positive tracking (`0.02em` to `0.03em`) on micro labels (`11px` - `12px`) for optimal scannability.

## Layout & Spacing

The layout is grounded in a flexible, 12-column fluid grid tailored for wide-screen financial data consoles while folding gracefully into 4 columns on mobile viewports.

- **Desktop (>= 1280px)**: 12-column grid, max-width `1440px`, centered with `2rem` margins and `1.5rem` gutters. Sidebars maintain fixed structural widths (e.g., `240px` or `280px`), allowing the content stage to flex dynamically.
- **Tablet (768px - 1279px)**: 8-column grid with `1.5rem` outer margins. Multi-column metric rows compress into 2x2 formations.
- **Mobile (< 768px)**: 4-column layout with `1rem` margins and `1rem` gutters. Data cards stack into single columns; complex tables convert into scrollable horizontal viewports or segmented detail cards.
- **Vertical Rhythm**: Layout components adhere to an 8px base rhythm (`space-xs` = 4px, `space-sm` = 8px, `space-md` = 16px, `space-lg` = 24px, `space-xl` = 32px).

## Elevation & Depth

Visual hierarchy uses a refined pairing of low-contrast hairline outlines and extra-diffused, ambient micro-shadows. Surfaces feel physically anchored to the background without excessive float.

- **Tier 0 (Canvas Base)**: `#F7F9FC` — Flat background, zero elevation.
- **Tier 1 (Surface Cards & Structural Containers)**: `#FFFFFF` surface bounded by a solid `1px` border of `#E2E8F0`. Shadow: `0 1px 3px 0 rgba(15, 23, 42, 0.04), 0 1px 2px -1px rgba(15, 23, 42, 0.02)`.
- **Tier 2 (Interactive Hover & Dropdown Menus)**: `#FFFFFF` surface with `1px` `#E2E8F0` border. Shadow: `0 4px 6px -1px rgba(15, 23, 42, 0.06), 0 2px 4px -2px rgba(15, 23, 42, 0.04)`.
- **Tier 3 (Modals & Overlays)**: `#FFFFFF` surface with `1px` `#CBD5E1` border. Shadow: `0 20px 25px -5px rgba(15, 23, 42, 0.08), 0 8px 10px -6px rgba(15, 23, 42, 0.04)`. Overlay backdrop is `rgba(15, 23, 42, 0.4)` with an ambient blur of `4px`.

## Shapes

The design uses a clean `8px` to `12px` corner radius spectrum to reinforce modern balance without veering into overly round or playful territory.

- **Standard Elements (8px / `0.5rem`)**: Applied to standard interactive controls, including text inputs, dropdown triggers, compact buttons, select menus, and table badges.
- **Cards & Data Panels (12px / `0.75rem`)**: Applied to all primary surface cards, analytics panels, and dashboard containers (`rounded-lg` token variant).
- **Modals & Drawers (16px / `1rem`)**: Applied to full-scale transactional dialogs, confirmation modals, and flyout sheets (`rounded-xl` token variant).
- **Pill Shapes (`9999px`)**: Reserved exclusively for dynamic status chips (e.g., `Active`, `Settled`, `Under Review`) and pagination dots.

## Components

### Buttons
- **Primary**: Background `#0070E0`, text `#FFFFFF`, border `none`, corner radius `8px`. Hover: `#005BB8`. Active: `#004C99`. Focus: `0 0 0 3px rgba(0, 112, 224, 0.25)`.
- **Secondary / Outline**: Background `#FFFFFF`, text `#172B4D`, border `1px solid #E2E8F0`, corner radius `8px`. Hover: `#F8FAFC` and border `#CBD5E1`.
- **Ghost**: Background `transparent`, text `#64748B`, corner radius `8px`. Hover: `#F1F5F9` and text `#172B4D`.
- **Destructive**: Background `#FFFFFF`, text `#DC2626`, border `1px solid #FCA5A5`. Hover: `#FEF2F2`.

### Input Fields
- Height `40px` (or `36px` in dense ledgers), corner radius `8px`, border `1px solid #E2E8F0`, background `#FFFFFF`, text `#172B4D`, placeholder `#94A3B8`.
- Focus state: border `#0070E0`, box-shadow `0 0 0 3px rgba(0, 112, 224, 0.15)`.
- Prefix/Suffix: Integrated inline currency signs (`$`, `€`) or ticker badges tinted `#64748B` with a solid vertical divider line.

### Cards & Metrics Containers
- Background `#FFFFFF`, border `1px solid #E2E8F0`, border radius `12px`, padding `24px` (`16px` on mobile).
- Header contains an upper `12px` uppercase title in `#64748B`, followed by a `28px` metric display in `#172B4D` using tabular figures, flanked by a status badge indicating percentage change.

### Badges & Status Chips
- Height `24px`, padding `0 10px`, pill-shaped (`rounded-full`), font size `12px`, font weight `500`.
- Success: Background `#ECFDF5`, text `#065F46`, border `1px solid #A7F3D0`.
- In Progress / Pending: Background `#EFF6FF`, text `#1E40AF`, border `1px solid #BFDBFE`.
- Warning: Background `#FFFBEB`, text `#92400E`, border `1px solid #FDE68A`.
- Neutral: Background `#F1F5F9`, text `#475569`, border `1px solid #E2E8F0`.

### Data Tables
- Header row height `40px`, background `#F8FAFC`, bottom border `1px solid #E2E8F0`, text `#64748B`, text style `label-md`.
- Body row height `48px`, background `#FFFFFF`, bottom border `1px solid #F1F5F9`, text `#172B4D`, hover background `#F8FAFC`.
- All monetary amounts right-aligned with font variation `tnum`.

### Checkboxes & Radios
- Size `16px` x `16px`, corner radius `4px` (checkbox) or `50%` (radio), border `1px solid #CBD5E1`.
- Checked state: Background `#0070E0`, border `#0070E0`, white iconography.