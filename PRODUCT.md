# Product Context: Studio

## Register

Product surface by default.

Studio is a working tool for AI image and video generation. The primary UI must optimize for repeated operation, prompt editing, asset inspection, task status, and handoff into Zouk chat. It can contain one-off brand/editorial surfaces, such as the embedded OpenViking blog experiment, but those surfaces must not set the defaults for the core app.

## Audience

- Zayn and collaborators running image, character, storyboard, and Seedance video workflows.
- Agents using the app as an operational surface for media generation and review.
- External readers when the Zouk embed demo is mounted into a blog-like page.

## Core Job

Move from prompt, reference asset, or character design request to a inspectable generated media result with minimal friction. The UI should make state, provenance, and next actions obvious.

## Personality

Quiet, technical, cinematic, and production-minded. Studio should feel like a control room, not a marketing landing page. It can be visually distinctive, but the interface must stay dense enough for real work.

## Design Principles

- Utility first: controls, status, media previews, and chat surfaces should be immediately usable.
- Asset-led: real generated media should carry the visual weight. Do not decorate with generic gradients, orbs, glass panels, or stock-like abstraction.
- Dense but calm: prefer compact tool surfaces, steady spacing, and clear groupings over oversized hero layouts.
- Direct manipulation: uploads, selected text, chat invocation, and task continuation should feel local to the object the user is touching.
- Mobile is operational: phone view is not a reduced marketing view. Composer, bottom sheets, safe areas, and scroll locks must be robust.
- Zouk embed should inherit host context but keep the chat mechanics recognizable and consistent with Zouk.

## References

- Film editing and color-grading tools for dark, media-first control surfaces.
- Linear-style operational clarity for task state and small controls.
- OpenViking blog pages only for the experimental article surface, not for the Studio app shell.

## Anti-References

- AI SaaS neon purple-blue gradients.
- Glassmorphism, bokeh blobs, decorative orbs, and nested cards.
- Landing-page hero patterns inside tool views.
- Thick accent side borders on rounded cards unless there is a strong product reason.
- Full-sentence uppercase tracking and repeated numbered section markers.

## Implementation Constraints

- Vite + React, no component library.
- CSS tokens live in `src/themes.css` under `[data-theme="studio"]`.
- Prefer local component classes already present in `themes.css`.
- Run `npm run design:detect` before substantial visual work. Treat findings as review prompts, not automatic truth.
