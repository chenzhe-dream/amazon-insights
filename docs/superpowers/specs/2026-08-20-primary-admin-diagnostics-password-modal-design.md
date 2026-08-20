# Primary-Admin Diagnostics and Password Modal Design

**Date:** 2026-08-20

**Status:** Approved design; implementation not started

**Scope:** Restrict three builder path diagnostics to one primary administrator and restore the existing password-change modal to the viewport without changing authorization or password semantics

## Goal

Make two narrowly scoped UI corrections:

1. show the red root/workspace path diagnostic rendered in the overview, keyword, and traffic ASIN builders only to the single approved primary administrator; and
2. render the existing password-change dialog against the viewport so its backdrop and complete three-field form are visible instead of being clipped to the sticky top bar.

The primary administrator is exactly a validated session user whose role is `admin` and whose normalized email is `admin@example.com`. `test-admin@amazon-insights.local`, every other `admin`, and every `member` are not primary administrators.

This is a presentation policy, not a new authorization tier. The Agent Service continues to recognize only `admin` and `member` and remains the source of truth for all protected operations.

## Verified Current State and Root Cause Evidence

### Builder diagnostics

`AuthenticatedAmazonOpportunityApp` in `app/page.tsx` receives the validated `AuthenticatedWebSession`, including the user's email and role, so no additional identity request is needed. The page currently initializes one shared `message` string with either a workspace-opening status or this root-path diagnostic:

> 根路径不再混合展示全部底库。请输入一批同类 ASIN，或点下方工作区进入 /p/floor-lamps、/p/kick-scooters

The same state is rendered in three separate `.builder-actions` areas:

- the `overview` ASIN builder beside “项目收藏”;
- the `keywords` ASIN builder beside “流量词对比”; and
- the `traffic` ASIN builder beside “推广能力分析”.

The root diagnostic contains “请”, so the existing string-based tone check assigns `.builder-message.error` and presents it as the reported red text. The same state later carries real validation failures, synchronization results, marketplace changes, project-save confirmations, and other business feedback. Hiding the entire `message` element for non-primary users would therefore suppress valid feedback and is outside the approved scope.

The shared `User` contract currently has only `role: "admin" | "member"`. The seeded test administrator is explicitly `test-admin@amazon-insights.local`, demonstrating why a role-only check would be too broad.

### Password-change modal

`AuthIdentityControl` is mounted inside `.topbar`. `PasswordChangeControl` currently renders `.auth-modal-backdrop` as a descendant of that identity control. The backdrop uses `position: fixed; inset: 0`, but `.topbar` is `position: sticky` and has `backdrop-filter: blur(12px)`.

The filtered ancestor establishes the containing block that captures the fixed descendant. Consequently the nominally viewport-sized backdrop is constrained by the top bar's box and height, producing the clipped horizontal strip instead of a full-screen overlay. Increasing `z-index`, changing the dialog width, or adding more `position: fixed` CSS does not remove that containing-block relationship.

The password route and browser request path already exist. The dialog already submits the three fields `currentPassword`, `newPassword`, and `confirmation` to `POST /v1/auth/password`; the backend keeps the current session, revokes other sessions after success, and returns `401 INVALID_CREDENTIALS` for an incorrect current password. `localAgentFetch` only emits the global authentication-required signal for `401 AUTHENTICATION_REQUIRED`, so an incorrect-current-password response remains an inline dialog failure rather than logging the user out. Those semantics must be preserved.

## Decision

### Primary-administrator predicate

Define one small, pure client helper and use it everywhere this presentation exception is evaluated:

```ts
const PRIMARY_ADMIN_EMAIL = "admin@example.com";

function isPrimaryAdmin(user: User): boolean {
  return user.role === "admin"
    && user.email.trim().toLowerCase() === PRIMARY_ADMIN_EMAIL;
}
```

The email is already schema-validated; normalization here is limited to surrounding whitespace removal and lowercase comparison. Role and email are both required. In particular:

| Session identity | Result |
| --- | --- |
| `admin@example.com`, role `admin` | Primary administrator |
| case/whitespace variant of `admin@example.com`, role `admin` | Primary administrator after normalization |
| `test-admin@amazon-insights.local`, role `admin` | Not primary administrator |
| `admin@example.com`, role `member` | Not primary administrator |
| any other email or role | Not primary administrator |

The helper does not grant backend access and must not be reused as a substitute for Agent Service authorization.

### Explicit diagnostic provenance

Do not decide visibility by searching the rendered Chinese text and do not treat every `.builder-message.error` as privileged. Represent the initial builder notice with explicit provenance, for example:

```ts
type BuilderNotice = Readonly<{
  kind: "path-diagnostic" | "business";
  text: string;
}>;
```

Only the exact root-path initialization is `kind: "path-diagnostic"`. The existing `/p/<slug>` workspace-opening status and every later call that reports validation, synchronization, save/load, marketplace, or analysis state are `kind: "business"`. The existing `message` text and `setMessage(text)` calling shape may be retained through a small wrapper around the structured state, avoiding a broad rewrite of the page's business handlers.

Visibility is then:

```ts
const showBuilderNotice = notice.kind !== "path-diagnostic"
  || isPrimaryAdmin(authSession.user);
```

Each of the three existing builder locations conditionally renders the entire `<span>` only when `showBuilderNotice` is true. A non-primary user therefore gets no diagnostic DOM node and no empty flex item or blank placeholder. The links, save buttons, analysis buttons, input controls, and layout remain unchanged. Once any business message replaces the initial diagnostic, that message renders for all authenticated users with its existing success/error class logic.

This provenance boundary is intentionally narrow: it covers only the one red root/workspace path diagnostic as it appears in the three approved builders. It does not hide project names, saved-project paths elsewhere in the application, breadcrumbs, ordinary errors, ordinary success messages, or any button.

### Body-level password portal

Keep `PasswordChangeControl` owned by `AuthIdentityControl`, but render the open backdrop with React `createPortal(dialog, document.body)`. Moving only the DOM host breaks the filtered-ancestor containing block while retaining the component's state, submit handler, and top-bar trigger.

Portal creation must be hydration-safe:

- initialize a `mounted` flag as false;
- set it true in `useEffect`, which runs only in the browser;
- create the portal only when `open && mounted && typeof document !== "undefined"`; and
- return no dialog subtree during SSR or the pre-hydration render.

The existing button can only be activated after hydration, but the explicit guard makes the rendering invariant auditable and prevents future server-render access to `document`.

The portaled subtree retains `.auth-modal-backdrop` and `.auth-modal`, the same three password fields, native field constraints, pending state, submit label, success message, and generic inline failure message. The dialog adds the minimum semantic wiring expected for a modal: `role="dialog"`, `aria-modal="true"`, and `aria-labelledby` pointing to its “修改密码” heading. The existing explicit “关闭” button remains the primary close action. Supporting `Escape` while the dialog is open is a small, local enhancement and should use an effect that installs and removes one keydown listener; backdrop-click closing, focus trapping, animation, and a general modal framework are not part of this change.

Opening or closing clears stale dialog feedback, and closing unmounts the portal subtree completely. No orphaned backdrop or form node remains under `document.body`. The implementation must not portal or otherwise change the feedback modal.

## Component and File Boundary

Implementation is limited to the following responsibilities:

- `app/lib/primary-admin.ts` (new): the normalized `admin@example.com` plus `admin` predicate; no role schema or authorization logic.
- `app/page.tsx`: structured builder-notice provenance, one predicate result derived from `authSession.user`, and conditional rendering at the three existing builder-message sites only.
- `app/auth-session-gate.tsx`: `createPortal`, hydration guard, complete portal teardown, and minimal dialog semantics/Escape handling; no request-contract changes.
- `app/globals.css`: retain the existing modal visual rules; only add narrowly required dialog/portal accessibility or responsive rules if browser verification exposes a gap.
- focused tests under `tests/agent/` and their existing render/browser helpers: primary-admin matrix, builder-message visibility, password-dialog portal behavior, and password failure/session regression.
- `tests/rendered-html.test.mjs`: preserve the unauthenticated SSR shell and ensure the client-only portal does not introduce protected or modal markup into the server response.

No server, database, migration, shared role schema, generated data, package dependency, lockfile, or feedback-modal file should change.

## Data Flow

### Diagnostic visibility

1. `AuthSessionGate` validates the cookie-backed session and passes `authSession.user` into `AuthenticatedAmazonOpportunityApp` as it does today.
2. `isPrimaryAdmin(authSession.user)` evaluates role and normalized email locally.
3. The page initializes the root notice with `kind: "path-diagnostic"`; `/p/<slug>` and subsequent user/business events use `kind: "business"`.
4. The active overview, keyword, or traffic builder renders its notice only when it is business feedback or the viewer is the primary administrator.
5. Buttons and event handlers continue to run for all roles exactly as before. A resulting business message replaces the diagnostic and becomes visible for all users.

### Password dialog

1. The authenticated user clicks “修改密码” in the top bar.
2. `PasswordChangeControl` sets `open`; after the mounted/document guard, React portals the backdrop and form directly under `document.body`.
3. Submission uses the existing `changeWebPassword` function and exact three-field contract.
4. Success resets the form and reports that the password changed and other sessions were revoked; the current session remains authenticated.
5. `401 INVALID_CREDENTIALS` produces only the existing safe inline failure and does not publish an authentication-required event.
6. A genuine `401 AUTHENTICATION_REQUIRED` still reaches the central session-expiry path, unmounting the authenticated application rather than being disguised as a wrong-current-password case.
7. Close button or Escape sets the dialog closed, clears local feedback, removes the keydown listener, and removes the portal subtree from `document.body`.

## Error and Security Boundaries

- The primary-admin check controls only diagnostic rendering. It is not a security boundary, capability, entitlement, or API authorization check.
- Client input cannot elevate an account: the predicate consumes only the validated session `User` supplied by the existing gate.
- Incorrect current password keeps the user logged in and shows the generic inline message. The UI does not expose raw backend details.
- Actual expired/revoked sessions keep the existing global `401 AUTHENTICATION_REQUIRED` behavior.
- Passwords remain in form controls/FormData only for the current submission and must not enter logs, URLs, Web Storage, analytics, or persistence.
- Closing the modal does not cancel, replay, or duplicate a password mutation. Duplicate submission remains disabled by the existing pending state.
- Portaling changes DOM placement only; it does not change the endpoint, password length policy, confirmation validation, session revocation rules, or cookie handling.

## Alternatives Considered

### Add `super-admin` to the role schema or add a backend capability

Rejected for this change. It would require contract, database, migration, seed, middleware, and authorization work for a UI-only diagnostic exception. The approved identity is one existing administrator, and backend permissions must remain unchanged.

### Treat every `admin` as primary

Rejected because it would expose the diagnostics to `test-admin@amazon-insights.local` and any future ordinary administrator, contrary to the approved identity rule.

### Compare only the email

Rejected because an incorrectly assigned member record with the same email would pass. Requiring both role and normalized email is explicit and fail-closed for this display policy.

### Hide the whole builder-message region for non-primary users

Rejected because the state also carries input validation, failures, success confirmations, and progress. Explicit notice provenance limits suppression to the approved diagnostic and preserves all business feedback.

### Detect the diagnostic by color, CSS class, or a Chinese substring

Rejected because error styling is shared with real failures and copy edits would silently change visibility. A structured `kind` is stable and directly testable.

### Fix the password modal with a larger `z-index` or altered fixed CSS

Rejected because stacking order does not escape the containing block created by the filtered sticky ancestor. The modal can remain clipped even at a higher z-index.

### Move the identity control or remove the top-bar filter

Rejected because both would change unrelated layout/visual behavior. A body portal corrects only the overlay's DOM host.

### Introduce a general modal framework or change the feedback modal

Rejected under YAGNI. The password dialog needs one portal and minimal semantics; the feedback modal is not reported broken and is explicitly outside scope.

## Test Strategy

Implementation proceeds test-first with focused deterministic cases, followed by render and build regression gates.

### Primary-administrator and builder cases

1. `admin@example.com` with role `admin` passes the predicate and sees the path diagnostic on each of `overview`, `keywords`, and `traffic`.
2. A normalized case/whitespace variant of that identity with role `admin` also passes.
3. `test-admin@amazon-insights.local` with role `admin` does not see the diagnostic in any of the three builders, and the diagnostic `<span>` is absent rather than empty.
4. A `member` does not see the diagnostic in any of the three builders, including a defensive member fixture using `admin@example.com`.
5. For both non-primary fixtures, replacing the diagnostic with each representative business category—validation error, synchronization failure, marketplace change, and save success—renders the message normally.
6. Project收藏, 流量词对比, 推广能力分析, save, refresh, and analysis buttons remain present and enabled/disabled according to their existing business inputs; role does not change them.

### Password-dialog cases

7. Before opening, no `.auth-modal-backdrop` exists under `document.body`. After clicking “修改密码”, exactly one backdrop exists and its direct portal host is `document.body`, outside `.topbar` and `.auth-identity-control`.
8. The open dialog exposes `role="dialog"`, `aria-modal="true"`, a labelled heading, and all three named password fields with their existing autocomplete and length constraints.
9. Computed/browser layout covers the viewport and displays the complete form at both the normal desktop width and the existing narrow responsive breakpoint.
10. An incorrect current password displays the generic inline error, keeps the authenticated identity/application mounted, and does not trigger logout or the expired-session login view.
11. A successful change preserves the current session, shows the existing success message, and continues to rely on backend tests for revocation of other sessions.
12. Close button and Escape remove the entire portal subtree and listener. Reopening starts without stale feedback and creates only one dialog.
13. A real `AUTHENTICATION_REQUIRED` response still expires the gate; an `INVALID_CREDENTIALS` password response does not.

### Regression gates

Run the focused UI/session tests, including the existing `tests/agent/web-auth-session.test.ts`, `tests/agent/local-agent-browser.test.ts`, and `tests/agent/password-change.test.ts`, plus the new primary-admin/dialog cases. Then run:

```powershell
npm run build
node --test tests/rendered-html.test.mjs
```

The server-render regression must continue to show only the authentication checking shell before session confirmation. Because the portal is guarded by client mount state, SSR must not contain the password dialog, protected navigation, or a hydration mismatch. A manual authenticated browser pass verifies the three tabs with primary admin, test admin, and member sessions and confirms the viewport-sized password dialog visually.

## Acceptance Criteria

The change is accepted only when all of the following are true:

1. The exact `admin` plus normalized `admin@example.com` identity sees the red root-path diagnostic in all three approved builders.
2. `test-admin@amazon-insights.local`, all members, and all other administrators receive no diagnostic element and no blank placeholder in those builders.
3. Validation, failure, success, progress, project, and marketplace messages still render for every authenticated role.
4. No project/library/analysis button or existing business action is hidden or permission-gated by the new predicate.
5. The password backdrop is portaled under `document.body`, covers the viewport, and shows the full three-field form outside the top-bar containing block.
6. The modal is hydration-safe, labelled as a dialog, closes by its explicit button and Escape, and leaves no portal residue after closing.
7. Incorrect current password remains an inline error without logout; genuine session expiry retains the current global logout behavior.
8. Password endpoint, policy, confirmation contract, current-session retention, other-session revocation, and safe error copy remain unchanged.
9. The feedback modal, backend roles/permissions, database schema, migrations, dependencies, and overall UI design are unchanged.
10. Focused automated tests, `npm run build`, rendered-HTML regression, and the authenticated browser acceptance pass succeed.

## Non-Goals

- Adding a `super-admin` role, capability, entitlement, organization-owner model, or backend permission branch.
- Changing database records, migrations, admin initialization, seeded accounts, or account-management UI.
- Hiding “项目收藏”, “流量词对比”, “推广能力分析”, save/refresh/analysis buttons, or any other business control.
- Changing authorization for projects, reports, connectors, synchronization, analysis, or password changes.
- Hiding ordinary validation, failure, progress, success, project, or marketplace messages.
- Redesigning the top bar, builders, login page, password form, or general modal system.
- Moving, refactoring, or visually changing the feedback modal.
- Adding backdrop-click close, a reusable focus-trap package, animation framework, password reset, recovery email, or new dependencies.

## Completion Boundary

This design is complete when the single approved primary administrator alone can see the three red path diagnostics, all later business feedback remains visible to ordinary admins and members, and the existing password-change form operates as a body-level viewport modal with unchanged authentication semantics and no residual DOM after close. It does not claim a new authorization model, account-management system, or general UI redesign.
