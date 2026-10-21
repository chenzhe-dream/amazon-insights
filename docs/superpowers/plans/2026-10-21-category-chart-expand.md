# Category chart expansion implementation plan

**Goal:** Let users enlarge both BSR category charts to read labels, trends and exact hover values clearly.

**Design:** Each chart gets a labelled “放大查看” button. Open a native modal dialog containing the same selected-node data rendered as a larger SVG, with larger labels and legends. Close using the close button, Escape or the backdrop, then restore focus to the opener. Preserve the compact two-chart overview. Use an internally scrollable chart on narrow screens. Static snapshots omit interactive expansion controls.

**Architecture:** Add a small presentation-only dialog component; give the two existing chart renderers an expanded-size flag. Keep existing data calculations and hover behavior; opening a chart must not fetch supplier data.

**Tech Stack:** React, TypeScript, native dialog and SVG, existing CSS.

**Scope:** User requested both charts' expansion in this side chat and previously authorized publishing to 31900 and committing changes. Work in the formal worktree; leave the main candidate and other ports untouched. Use existing tests and actual browser checks for this reversible UI change.

- [x] Add dialog, per-chart buttons and enlarged geometry/typography.
- [x] Run typecheck and relevant existing regression tests; inspect diff and commit.
- [x] Record runtime identities, publish using the managed idle-gated release command.
- [x] Verify both charts, hover values, close/Escape/focus restoration and retained node selection in the browser; save evidence and commit the verification record.

## Verification, 2026-10-21

- Code commit: `1dac83bd3366bb23592c0d08941fb40cda76e947`.
- Typecheck, 8 existing overview/snapshot regression checks, whitespace check and managed production build passed.
- Web 31900 PID 328628 and Agent 31901 PID 333972 report the code commit above and source hash `ea36f6110f69e3d542b924bbeef3f80012b432ce7c0e9a186f1fe2709411e34e`.
- Web artifact: `3ad8c09b291e619578208ac7576b9c29797523c5db974cc3aeb32abd6db9d48d`. Ports 32900/32901 and 33900/33901 retained their prior PIDs and source hashes.
- On the live DE project, both expansion buttons opened separate native dialogs for Slacklines (844438031). The sales dialog measured 1400px wide with a 590.5px rendered chart, SVG viewBox 960x420 and 12px SVG axis labels.
- Sales hover showed October 2025: 973 units and $79,124, retaining the existing category source currency. Monopoly hover showed April 2025: Listing 26.26%, brand 57.87%, seller 62.49%.
- Close button and Escape both returned to the original page and restored focus to the appropriate expansion button. The selected node remained Slacklines (844438031).
- Runtime identity evidence: `C:/Users/EDY/.codex/visualizations/2026/10/21/01a15d00-9eb3-7a20-9692-40fb46183339/formal-de-release/chart-expand-before.json` and `chart-expand-after.json`.
- Screenshot capture repeatedly timed out in the browser adapter, including an alternate temporary tab; no new screenshot was saved. The temporary tab was closed and the original project tab was retained. Interaction and layout dimensions were verified through live accessibility/DOM observations.
