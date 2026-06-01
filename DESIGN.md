# Design System: Studio

## 1. Overview

Studio uses a cinema-noir product interface: dark warm surfaces, serif display moments, compact sans UI, amber and vermillion accents, and media previews as the main visual material. The system should feel like a practical generation console with enough craft to support high-end image and video work.

The current token source of truth is `src/themes.css` on `[data-theme="studio"]`.

## 2. Color

- Page ground: `--bg` and `--bg-2`, dark warm blacks. Avoid pure neutral black when adding new surfaces.
- Raised surfaces: `--bg-3` and existing `.surface` treatments.
- Primary text: `--fg`; secondary text: `--fg-2`; metadata: `--fg-3`.
- Primary accent: `--accent` (`#f0b042`) for active controls, focus, and key highlights.
- Secondary accent: `--accent-2` (`#d44d2a`) for destructive or hot states, not generic decoration.
- Borders: `--line`; keep them thin and quiet.

Rules:
- Do not introduce a new dominant hue family without updating the token system.
- Avoid thick colored edge borders on rounded cards. Use background shift, compact labels, or subtle hairlines instead.
- Accent color should guide state or action, not decorate every card.

## 3. Typography

- Display: `--font-display` (Newsreader). Use for app title moments and select section headings only.
- Body/UI: `--font-body` (IBM Plex Sans). Use for controls, cards, settings, and repeated operational text.
- Mono: `--font-mono` (IBM Plex Mono). Use for IDs, params, task metadata, and compact technical labels.

Rules:
- Keep button and compact-panel text small enough to scan quickly.
- Avoid viewport-scaled font sizing for tool UI.
- Tracked uppercase labels must be short.
- Long-form blog copy can breathe more, but must not leak editorial spacing into core tool surfaces.

## 4. Layout

- Core app: left nav, main tool surface, media cards, and compact configuration panels.
- Zouk embed on desktop: right-side chat rail or sidebar pattern.
- Zouk embed on phone: bottom sheet pattern, stable height, robust keyboard behavior, scroll locked behind the sheet.

Rules:
- Prefer full-width tool bands and direct grid layouts over cards inside cards.
- Use stable dimensions for media tiles, icon buttons, composers, and bottom sheets.
- Avoid animating `width`, `height`, `padding`, or `margin` in hot UI paths. Prefer transforms, opacity, or grid techniques.
- Safe-area handling is required on phone.

## 5. Components

Canonical classes are in `src/themes.css`.

- Buttons: `.btn`, `.btn-primary`, `.btn-ghost`, `.btn-icon`, `.btn-lg`.
- Inputs: `.input`, `.textarea`, `.seg`, `.seg-opt`.
- Surfaces: `.surface`, `.chip`, `.video-card`, `.img-tile`.
- Upload: `.drop`.
- Zouk embed: `.zouk-studio-*` for the compact Studio chat and `.zouk-*` for the blog demo.

Rules:
- Reuse these classes before inventing new ones.
- New repeated components should become reusable class patterns in `themes.css`.
- For message/chat UI, match Zouk interaction semantics before adding visual novelty.

## 6. Motion and States

- Motion should be quick, useful, and low-drama.
- Use transitions for sheet open/close, launcher affordance, focus, hover, and media preview feedback.
- Respect reduced-motion expectations when adding larger movement.
- Loading and generation states should show progress or clear waiting states. Do not leave static empty panels.

Quality checks:
- `npm run design:detect` runs Impeccable's deterministic anti-pattern detector against `src`.
- Current baseline findings are mostly in the embedded OpenViking blog experiment and should be handled separately from the core Studio app.
