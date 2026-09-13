# Contract

Copy the input schemaVersion, task, batchId and inputDigest to output; copy window explanationCatalogId, revisionId, windowId and dimension to fragment/section. Use declared version literals.

Decode dictionary.strings indexes: row=[rowIdIndex,contextPairs,cells]; context=[keyIndex,valueIndexOrNull]; cell=[cellIdIndex,numericValueOrNull,unitIndex]. Cell values are numbers, not indexes. Limitation=[codeIndex,part,parts,encoding,detail]; part/parts locate complete JSON-array elements, not statistics. rules.limitations contain code/detail objects.

Cite only current coverage.rowIds and their actual cells/context, and visible limitation codes. Every statement includes prose plus cited evidence or limitations. Display all numbers and labels through cell/context parts, never raw prose values. Keep null unknown and zero zero.

Separate observed, inferred, risk and verification. Observed requires a displayed known cell. Explained requires known evidence and nonempty findings; findings are observed or inferred. Insufficient evidence requires a risk summary, no findings, and a reason. Empty windows are insufficient. Verification cites evidence or limitations.

Every visible limitation code must appear in section.limitations risk statements. Preserve reference-price, sampling, unclassified-member and source-policy boundaries; do not claim historical transaction prices or market/BSR rank from the pool. Local fragments cannot conclude across dimensions; final synthesis remains separate. Repair structure/references only, without inventing evidence. Return JSON without Markdown.
