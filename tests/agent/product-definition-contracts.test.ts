import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import {
  extractVocPositioningProjection,
} from "../../server/domain/product/product-definition-contracts";
import {
  SCOOTER_ASINS,
  realVocFacts,
  validVocPositioningOutput,
} from "./helpers/voc-positioning-fixture";

test("projects both legacy VOC reports and combined Amazon insight reports", () => {
  const projection = validVocPositioningOutput(
    realVocFacts(SCOOTER_ASINS, randomUUID(), randomUUID()),
  );
  assert.deepEqual(extractVocPositioningProjection(projection), projection);
  assert.deepEqual(
    extractVocPositioningProjection({
      schemaVersion: "1.0.0",
      kind: "amazon-voc-insight-result",
      insight: {},
      positioningProjection: projection,
    }),
    projection,
  );
});
