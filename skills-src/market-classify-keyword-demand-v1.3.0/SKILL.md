---
name: market-classify-keyword-demand
description: Keyword discovery.
---

Follow [binding](references/contract.md).
Root keys: schemaVersion,task,batchId,inputDigest,keywords,proposals,synonymRelations,labelProposals.
labelProposals:{dimension,labelId,label,definition,evidence:[span]}; proposals:{proposalId,labelZh,definition,evidence:[span]}; synonymRelations:{leftKeywordId,rightKeywordId,relation,evidence:[span]}. Array items; unused=[].
W1 product; W2 explicit audience/recipient; W3 setting; W4 function/attribute. Prefer supported catalog IDs; uncovered explicit concepts: Chinese label/definition, unique labelId across dimensions/input; same-dimension use. Reuse identical concepts. Proposals: used, own-word evidence, local IDs.
Absent dimensions unknown; bedroom=setting, not demographics; mother=recipient, not age. Negated shelves cannot support shelves; shelves-for-lamp differs from lamp-with-shelves. Empty catalog: grounded proposals only.
One main cluster/word: existing match or used proposal. Shared nouns do not merge functions. equivalent=interchangeable demand; related=associated, different. Relations: distinct input words, both quotes, once/pair; omit unproven.
