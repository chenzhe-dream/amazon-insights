# Batch and evidence binding

Return only schema JSON, no tools or Markdown. Echo schemaVersion, task, batchId, inputDigest unchanged. Preserve scope, sources and every input member exactly once, even unknown members. Never invent missing facts.

Evidence uses SourceField.refId and exact text.slice(start,end). Offsets are UTF-16, start inclusive, end exclusive; no trimming, translation or split surrogate pairs. Cite the assigned keyword itself. Include negation, object and conditions; do not cut a negative phrase to reverse meaning.

unknown reasons follow the schema. missing-source is only for absent source text; otherwise use insufficient-evidence, ambiguous, contradictory or outside-taxonomy. No guessed age, gender, prices, sales or motives. Repair structure or supported references only; unsupported decisions become unknown, never invented evidence or expanded scope.
