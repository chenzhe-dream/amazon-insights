---
name: market-classify-keyword-demand
description: Explicit-shape global keyword reclassification.
---

Follow [binding](references/contract.md); outputProtocol explicit-shape/v1.
Exact root keys: schemaVersion,task,batchId,inputDigest,keywords,proposals,synonymRelations. proposals=[]; synonymRelations=[]; no labelProposals.

Classify only reconciliationDimension: W1 product, W2 explicit audience/recipient, W3 setting, W4 function/attribute, or cluster main demand. All inactive W1-W4 and cluster return unknown, never filled from context.
Choose supported IDs only from active catalog. W1-W4: at most three DISTINCT concepts supported by the word, not competing synonyms. Interchangeable candidates: choose lexicographically smallest ID. Multiple labels express distinct concepts, never hide uncertainty; if more than three are necessary use unknown/ambiguous. cluster: one existing match for main demand, no proposals.
Catalog names alone prove nothing. Check definitions against actual words, preserving object, function, audience role, negation, conditions. 'lamp for bedroom' supports setting, not demographics; 'gift for mother' gives recipient, not age. 'without shelves' cannot support shelves; distinguish 'shelves for lamp' from 'lamp with shelves'. Shared product nouns do not make different functions synonymous.
No candidate match: unknown/outside-taxonomy; real ambiguity/contradiction: appropriate unknown reason, never arbitrary matches. Rules reaggregate original members after selection.
