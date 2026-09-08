import type { TestContext } from "node:test";
import { httpFixture } from "./xydc-http-fixture";

export async function coordinationFixture(test: Pick<TestContext, "after">) {
  const fixture = await httpFixture();
  // Register before callers acquire credentials, install mocks, or enter their own try/finally.
  test.after(() => fixture.close());
  return fixture;
}
