# Category chart expansion implementation plan

**Goal:** Let users enlarge both BSR category charts to read labels, trends and exact hover values clearly.

**Design:** Each chart gets a labelled “放大查看” button. Open a native modal dialog containing the same selected-node data rendered as a larger SVG, with larger labels and legends. Close using the close button, Escape or the backdrop, then restore focus to the opener. Preserve the compact two-chart overview. Use an internally scrollable chart on narrow screens. Static snapshots omit interactive expansion controls.

**Architecture:** Add a small presentation-only dialog component; give the two existing chart renderers an expanded-size flag. Keep existing data calculations and hover behavior; opening a chart must not fetch supplier data.

**Tech Stack:** React, TypeScript, native dialog and SVG, existing CSS.

**Scope:** User requested both charts' expansion in this side chat and previously authorized publishing to 31900 and committing changes. Work in the formal worktree; leave the main candidate and other ports untouched. Use existing tests and actual browser checks for this reversible UI change.

- [x] Add dialog, per-chart buttons and enlarged geometry/typography.
- [x] Run typecheck and relevant existing regression tests; inspect diff and commit.
- [ ] Record runtime identities, publish using the managed idle-gated release command.
- [ ] Verify both charts, hover values, close/Escape/focus restoration and retained node selection in the browser; save evidence and commit the verification record.
