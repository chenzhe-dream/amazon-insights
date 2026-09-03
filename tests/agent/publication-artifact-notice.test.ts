import assert from "node:assert/strict";
import test from "node:test";
import { publicationArtifactNotice } from "../../app/lib/publication-artifact-notice";

test("only a different valid applied artifact asks for manual refresh", () => {
  const current = "a".repeat(64);
  const target = "b".repeat(64);
  assert.equal(publicationArtifactNotice(current, current), null);
  assert.equal(publicationArtifactNotice(current, target), "新数据已发布，请手动刷新");
  assert.equal(publicationArtifactNotice(current, "invalid"), null);
});
