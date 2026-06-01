# Studio

AI video generation studio powered by ByteDance Ark / Seedance 2.0 Pro. Cinema-noir themed single-page React app with localStorage persistence.

## Quick start

```bash
npm install
npm run dev        # Vite dev server, usually :5173
npm run build      # Production build → dist/
```

## Stack

- **Vite + React 19** — no router library, uses hash-based routing (`useHashRoute` in `store.jsx`)
- **No component library** — all UI is hand-rolled with CSS custom properties
- **No state library** — React Context (`StoreProvider`) with localStorage sync
- **Single theme** — "Studio" (cinema noir): Newsreader serif + IBM Plex Sans/Mono, amber/vermillion accents, film-grain overlay

## File map

```
src/
  main.jsx          — App root, mounts StoreProvider, keyboard shortcuts (1/2/3), hash router
  store.jsx         — StoreProvider/useStore context, useHashRoute, seed data, localStorage (key: vgs.state.v3)
  components.jsx    — Icon (SVG icon set), DropZone, VideoPlayer, GenerationProgress, useToast
  pages.jsx         — Nav, HomePage, CreatePage, PreviewPage, LibraryPage
  themes.css        — Studio theme tokens (CSS vars on [data-theme="studio"]), all component styles
index.html          — Google Fonts links, data-theme="studio" on <body>
```

## Pages

| Page | Hash route | Purpose |
|------|-----------|---------|
| Home | `#/` | Hero section + video gallery grid. "Use as template" on each card → prefills Create |
| Create | `#/create` | Scene first-frame dropzone (optional, auto-derives I→V vs T→V) + prompt + Seedance params. Fake generation progress overlay |
| Preview | `#/preview?id=...` | Custom video player + params sidebar. Download, delete, remix actions |
| Library | `#/library` | Two tabs: Images (upload, drag-to-reuse, delete) and Videos (grid with delete) |

## Key conventions

- **Mode is implicit**: if a scene first-frame image is present → I→V, if only `reference_image_url(s)` is present → reference-guided video, otherwise → T→V. `last_frame_image_url` can be paired with `image_url`; do not combine first/last-frame inputs with reference-media inputs in one Ark task. Character sheets, info graphs, turnarounds, and reference boards are reference inputs, not first-frame inputs; for best shot control generate an actual scene/storyboard frame with imagegen first
- **Ark API key**: held by the server (`ARK_API_KEY` env). The frontend never sees it
- **Image hosting**: Studio image uploads go to Cloud (`CLOUD_REPO_BASE_URL`, `CLOUD_REPO_UPLOAD_KEY`; legacy `IMAGE_REPO_*` still works) with `IMAGE_REPO_TAG=studio`; new images are not hosted from `/media/inputs`
- **Web access gate**: if `MCP_TOKEN` is set on the server, the SPA shows a login screen on first load; the token (same one used for `/mcp` bearer auth) is stored in `localStorage["vgs.accessToken"]` and sent as `Authorization: Bearer ...` (or `?access_token=...`) on every `/api/*` and `/state/tasks.json` call. `/healthz`, `/media/*`, and static assets stay open. Leaving the env unset disables the gate (dev mode)
- **Template flow**: any video can prefill Create via `?from=<videoId>` query param
- **Seed data**: 6 sample videos + 3 images ship by default (Google public sample videos + Unsplash thumbnails)
- **No backend yet**: generation is faked with `setInterval` progress + random sample video assignment

## CSS architecture

All styles in `themes.css`. Theme tokens are CSS custom properties on `[data-theme="studio"]`:
- `--bg`, `--bg-2`, `--bg-3` — background tiers
- `--fg`, `--fg-2`, `--fg-3` — foreground tiers
- `--accent` (#f0b042 amber), `--accent-2` (#d44d2a vermillion)
- `--font-display` (Newsreader), `--font-body` (IBM Plex Sans), `--font-mono` (IBM Plex Mono)

Component classes: `.btn`, `.btn-primary`, `.btn-ghost`, `.btn-lg`, `.btn-icon`, `.surface`, `.input`, `.textarea`, `.seg`/`.seg-opt`, `.chip`, `.video-card`, `.drop`, `.img-tile`, `.toast`

## Impeccable pilot

This repo has a lightweight Impeccable integration for design review:

```bash
npm run design:detect       # deterministic design anti-pattern scan
npm run design:detect:json  # same scan, JSON output
```

`PRODUCT.md` captures Studio's product/register context and `DESIGN.md` captures the current Studio design system. Use those files as the persistent context for Impeccable-driven design work. Do not commit the generated `.agents` / `.claude` skill bundle unless the project explicitly decides to vendor agent skills; the current pilot uses `npx impeccable@2.3.2` directly.

The detector is a review aid, not a mechanical source of truth. The current baseline has findings in the embedded OpenViking blog experiment, especially thick side borders and rounded-card accent borders; treat those separately from the core Studio tool UI.

## Seedance params (Create page)

| Param | Options | Default |
|-------|---------|---------|
| Model | seedance-pro, seedance-lite | seedance-pro |
| Resolution | 720p, 1080p, 2K | 1080p |
| Aspect | 16:9, 9:16, 1:1 | 16:9 |
| Duration | 3–15s slider | 5 |
| Camera | fixed, dynamic | dynamic |
| Seed | random integer | random |

## Next steps (from design handoff)

1. **Server skeleton** — Bun/Node + Hono, env validation (`ARK_API_KEY`, `MCP_TOKEN`), `/api/generate` and `/api/task/:id` proxy endpoints
2. **Ark client** — wrap Volcengine Seedance API (`POST /api/v3/contents/generations/tasks`), inline flags format (`--rs --rt --dur --cf --seed`)
3. **MCP server** — `@modelcontextprotocol/sdk`, HTTP+SSE on `/mcp`, bearer auth, tools: `create_video_task`, `get_video_task`
4. **Persistence** — SQLite for video/image records, object storage for blobs
5. **Frontend cutover** — replace localStorage with `/api/*` calls, remove client-side API key input

## Design reference

Original prototype files extracted to `/tmp/video/project/`. Key docs:
- `docs/00-HANDOFF.md` — full architecture, env vars, REST + MCP specs
- `docs/03-ARK-API.md` — Seedance API contract, request/response mapping
- `docs/04-DATA-MODEL.md` — localStorage schema, migration policy
