import assert from "node:assert/strict";
import test from "node:test";
import { queryProjectLibrary } from "../../server/services/project-library-query";
import { LocalDataProjectListQuerySchema } from "../../shared/agent-contracts";
import type { AnalysisProject } from "../../app/lib/project-server";
const projects: AnalysisProject[] = Array.from({ length: 23 }, (_, i) => ({ id: String(i).padStart(2, "0"),
  kind: "analysis", name: `灯具 ${i}`, marketplace: "US", majorCategory: i % 2 ? "Home & Kitchen" : null,
  categoryLabel: null, asins: [`B${String(i).padStart(9, "0")}`], createdBy: "张三", note: null,
  createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" }));
test("pagination is stable and returns only the requested page with complete totals", () => {
  const result = queryProjectLibrary(projects, { page: 2, pageSize: 10 }, ["01"]);
  assert.equal(result.projects.length, 10); assert.equal(result.projects[0].id, "10");
  assert.deepEqual([result.pagination.total, result.pagination.historyTotal, result.pagination.favoritesTotal], [23, 23, 1]);
});
test("search, category and favorites apply before paging; deleted last page clamps", () => {
  const result = queryProjectLibrary(projects, { page: 9, pageSize: 1, view: "favorites", search: "张三 灯具", category: "Home & Kitchen" }, ["01", "02", "03", "missing"]);
  assert.equal(result.pagination.total, 2); assert.equal(result.pagination.page, 2); assert.equal(result.projects[0].id, "03");
  assert.equal(queryProjectLibrary(projects, { search: "B000000022" }, []).projects[0].id, "22");
  assert.equal(queryProjectLibrary([], { page: 3 }, []).pagination.page, 1);
});
test("pagination query rejects invalid sizes and page numbers", () => {
  for (const value of [{ page: "0" }, { page: "NaN" }, { pageSize: "51" }, { page: "1.5" }]) {
    assert.equal(LocalDataProjectListQuerySchema.safeParse(value).success, false);
  }
  assert.equal(LocalDataProjectListQuerySchema.parse({ page: "2", pageSize: "20" }).page, 2);
});

test("all four time orders sort globally before paging with modification fallback", () => {
  const items = [
    { ...projects[0], id: "a", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-10T00:00:00Z" },
    { ...projects[0], id: "b", createdAt: "2026-09-02T00:00:00Z", updatedAt: "" },
    { ...projects[0], id: "c", createdAt: "2026-09-03T00:00:00Z", updatedAt: "2026-09-03T08:00:00+08:00" },
  ];
  for (const [sort, expected] of Object.entries({ created_desc: "cba", created_asc: "abc", updated_desc: "acb", updated_asc: "bca" })) {
    const query = LocalDataProjectListQuerySchema.parse({ sort });
    assert.equal(queryProjectLibrary(items, query, []).projects.map(item => item.id).join(""), expected);
    assert.equal(queryProjectLibrary(items, { ...query, page: 2, pageSize: 1 }, []).projects[0].id, expected[1]);
  }
  assert.equal(LocalDataProjectListQuerySchema.safeParse({ sort: "invalid" }).success, false);
});
