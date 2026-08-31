import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const cssUrl = new URL("../../app/admin/users/admin-users.module.css", import.meta.url);

test("admin users layout contains wide content locally and has a mobile breakpoint", async () => {
  const css = await readFile(cssUrl, "utf8");

  assert.match(css, /\.page\s*\{[\s\S]*?min-width:\s*0/);
  assert.match(css, /\.shell\s*\{[\s\S]*?width:\s*min\(100%,\s*\d+px\)[\s\S]*?min-width:\s*0/);
  assert.match(css, /\.header\s*\{[\s\S]*?flex-wrap:\s*wrap/);
  assert.match(css, /\.actions\s*\{[\s\S]*?flex-wrap:\s*wrap/);
  assert.match(css, /\.actions\s+:global\(\.auth-identity-control\)\s*\{[\s\S]*?min-width:\s*0[\s\S]*?max-width:\s*100%[\s\S]*?flex-wrap:\s*wrap/);
  assert.match(css, /\.tableViewport\s*\{[\s\S]*?max-width:\s*100%[\s\S]*?overflow-x:\s*auto/);
  assert.match(css, /\.detailViewport\s*\{[\s\S]*?max-width:\s*100%[\s\S]*?overflow-x:\s*auto/);
  for (const status of ["recently-online", "valid-session-idle", "never-logged-in", "session-expired", "disabled"]) {
    assert.match(css, new RegExp(`data-presence-status=[\\\"']${status}[\\\"']`));
  }
  assert.match(css, /@media\s*\(max-width:\s*720px\)[\s\S]*?\.page[\s\S]*?\.header[\s\S]*?\.actions\s+:global\(\.auth-identity-control\)[\s\S]*?width:\s*100%/);
  assert.doesNotMatch(css, /(?:html|body)\s*\{[\s\S]*?overflow-x:\s*(?:auto|scroll)/);
});
