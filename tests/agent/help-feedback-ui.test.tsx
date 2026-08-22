import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { isValidElement } from "react";

import {
  addFeedbackImages,
  MAX_FEEDBACK_IMAGES,
  removeFeedbackImage,
} from "../../app/help-feedback/feedback-image-input";
import { createHelpFeedbackClient } from "../../app/help-feedback/help-feedback-client";
import {
  availableFeedbackTabs,
  hasDirtyFeedbackDraft,
  isPrimaryFeedbackAdmin,
  shouldCloseFeedbackDrawer,
} from "../../app/help-feedback/help-feedback-drawer";
import { HelpManual } from "../../app/help-feedback/help-manual";
import type { FeedbackDraft, FeedbackImageDraft } from "../../app/help-feedback/feedback-types";
import type { User } from "../../shared/agent-contracts";

const root = process.cwd();
const pageSource = readFileSync(`${root}/app/page.tsx`, "utf8");
const imageInputSource = readFileSync(`${root}/app/help-feedback/feedback-image-input.tsx`, "utf8");
const drawerSource = readFileSync(`${root}/app/help-feedback/help-feedback-drawer.tsx`, "utf8");
const now = "2026-08-22T08:00:00.000Z";

function user(email: string, role: User["role"]): User {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    organizationId: "20000000-0000-4000-8000-000000000001",
    email,
    displayName: email,
    role,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
}

function emptyDraft(overrides: Partial<FeedbackDraft> = {}): FeedbackDraft {
  return {
    category: "bug",
    title: "",
    description: "",
    images: [],
    ...overrides,
  };
}

function file(name: string, type = "image/png", size = 8): File {
  return new File([new Uint8Array(size)], name, { type });
}

function renderText(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(renderText).join("");
  if (isValidElement(node)) {
    const element = node as { type: unknown; props: unknown };
    if (typeof element.type === "function") {
      return renderText((element.type as (props: unknown) => unknown)(element.props));
    }
    const props = element.props as { children?: unknown; "aria-label"?: unknown };
    return `${String(props["aria-label"] ?? "")}${renderText(props.children)}`;
  }
  return "";
}

test("page mounts help and feedback above data-source status, removes the duplicate float, and retains back-to-top", () => {
  const entry = pageSource.indexOf("<HelpFeedbackDrawer");
  const status = pageSource.indexOf("数据源状态正常");

  assert.ok(entry >= 0, "left-sidebar help entry must exist");
  assert.ok(status > entry, "help entry must be above data-source status");
  assert.match(drawerSource, /帮助与反馈/);
  assert.match(pageSource, /<HelpFeedbackDrawer\b/);
  assert.doesNotMatch(pageSource, /function FeedbackButton\b|<FeedbackButton\s*\/>|feedback-float-btn/);
  assert.match(pageSource, /<BackToTopButton\s*\/>/);
});

test("manual, submit, and mine are available to every user while management is primary-admin only", () => {
  assert.deepEqual(availableFeedbackTabs(user("member@example.com", "member")), ["manual", "submit", "mine"]);
  assert.deepEqual(availableFeedbackTabs(user("ops@example.com", "admin")), ["manual", "submit", "mine"]);
  assert.deepEqual(availableFeedbackTabs(user(" ADMIN@EXAMPLE.COM ", "admin")), [
    "manual",
    "submit",
    "mine",
    "admin",
  ]);
  assert.equal(isPrimaryFeedbackAdmin(user(" ADMIN@EXAMPLE.COM ", "admin")), true);
  assert.equal(isPrimaryFeedbackAdmin(user("admin@example.com", "member")), false);
  assert.match(drawerSource, /反馈管理/);
  assert.match(drawerSource, /feedback-unread-badge/);
});

test("manual explains all four workflows without requiring a live service", () => {
  const text = renderText(HelpManual({}));
  assert.match(text, /使用手册/);
  assert.match(text, /提交反馈/);
  assert.match(text, /我的反馈/);
  assert.match(text, /图片/);
});

test("picker, drop, and paste share capped image intake with previews, deletion, and per-file errors", () => {
  assert.equal(MAX_FEEDBACK_IMAGES, 3);
  const result = addFeedbackImages([], [
    file("one.png"),
    file("notes.txt", "text/plain"),
    file("two.jpg", "image/jpeg"),
    file("three.webp", "image/webp"),
    file("four.png"),
  ], (candidate) => `blob:${candidate.name}`);

  assert.deepEqual(result.images.map((image) => image.file.name), ["one.png", "two.jpg", "three.webp"]);
  assert.deepEqual(result.images.map((image) => image.previewUrl), ["blob:one.png", "blob:two.jpg", "blob:three.webp"]);
  assert.match(result.errors.join("\n"), /notes\.txt.*PNG.*JPEG.*WebP/i);
  assert.match(result.errors.join("\n"), /four\.png.*最多.*3/);
  assert.deepEqual(removeFeedbackImage(result.images, result.images[1]!.id).map((image) => image.file.name), [
    "one.png",
    "three.webp",
  ]);
  assert.match(imageInputSource, /onChange/);
  assert.match(imageInputSource, /onDrop/);
  assert.match(imageInputSource, /onPaste/);
  assert.match(imageInputSource, /URL\.revokeObjectURL/);
});

test("multipart submit and own/admin workflows use only the approved same-origin routes", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/unread-count")) return Response.json({ count: 2 });
    if (url.endsWith("/mark-seen")) return Response.json({ seen: true });
    if (url.endsWith("/status")) return Response.json({ feedback: { id: "f-1" } });
    if (url.includes("/mine/") || /\/admin\/[^/?]+$/.test(url)) {
      return Response.json({ feedback: { id: "f-1" } });
    }
    if (url.endsWith("/mine") || url.includes("/admin?")) return Response.json({ feedback: [] });
    return Response.json({ feedbackId: "40000000-0000-4000-8000-000000000001", createdAt: now });
  };
  const client = createHelpFeedbackClient(fetcher);
  const image: FeedbackImageDraft = { id: "image-1", file: file("proof.png"), previewUrl: "blob:proof" };

  await client.submit({ ...emptyDraft({ title: "标题", description: "描述", images: [image] }), pagePath: "/?tab=voc" });
  await client.listMine();
  await client.getMine("40000000-0000-4000-8000-000000000001");
  await client.listAdmin("processing");
  await client.getAdmin("40000000-0000-4000-8000-000000000001");
  await client.unreadCount();
  await client.markSeen("40000000-0000-4000-8000-000000000001");
  await client.changeStatus("40000000-0000-4000-8000-000000000001", "resolved", 2);

  const submit = calls[0]!;
  assert.equal(submit.url, "/api/agent/v1/feedback");
  assert.equal(submit.init?.method, "POST");
  assert.ok(submit.init?.body instanceof FormData);
  assert.equal(new Headers(submit.init?.headers).has("Content-Type"), false, "browser must generate multipart boundary");
  const data = submit.init?.body as FormData;
  assert.equal(data.get("title"), "标题");
  assert.equal(data.getAll("images").length, 1);
  assert.deepEqual(calls.slice(1).map((call) => call.url), [
    "/api/agent/v1/feedback/mine",
    "/api/agent/v1/feedback/mine/40000000-0000-4000-8000-000000000001",
    "/api/agent/v1/feedback/admin?status=processing",
    "/api/agent/v1/feedback/admin/40000000-0000-4000-8000-000000000001",
    "/api/agent/v1/feedback/admin/unread-count",
    "/api/agent/v1/feedback/admin/40000000-0000-4000-8000-000000000001/mark-seen",
    "/api/agent/v1/feedback/admin/40000000-0000-4000-8000-000000000001/status",
  ]);
});

test("dirty title, description, or attachments require confirmation on close button, backdrop, and Escape", () => {
  const clean = emptyDraft();
  assert.equal(hasDirtyFeedbackDraft(clean), false);
  for (const draft of [
    emptyDraft({ title: "未提交" }),
    emptyDraft({ description: "未提交" }),
    emptyDraft({ images: [{ id: "1", file: file("proof.png"), previewUrl: "blob:proof" }] }),
  ]) {
    assert.equal(hasDirtyFeedbackDraft(draft), true);
    for (const path of ["button", "backdrop", "escape"] as const) {
      assert.equal(shouldCloseFeedbackDrawer(draft, path, () => false), false);
      assert.equal(shouldCloseFeedbackDrawer(draft, path, () => true), true);
    }
  }
  assert.equal(shouldCloseFeedbackDrawer(clean, "escape", () => false), true);
  assert.match(drawerSource, /requestClose\("button"\)/);
  assert.match(drawerSource, /requestClose\("backdrop"\)/);
  assert.match(drawerSource, /requestClose\("escape"\)/);
});
