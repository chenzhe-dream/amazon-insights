# Shape synthesis contract

Combine all children: by declared dimension in `dimension-reduce`, or the six dimensions in `final`. Do not omit a child or its limits.

Child section fields index `statements`; expand statement objects in output, never indexes. `leafSet` indexes `leafSets`. Use only supplied aliases. `rowRef` selects an `evidenceRows` entry and its `semanticKey`/`context`. `cellColumns` fixes each cell tuple as `[cellRef,metric,value,unit]`; cell aliases are row-local. `limitationRef` selects the supplied code, detail and provenance.

Numbers require visible cell/context references. Preserve exact alias relationships, values, units and limitations. Do not invent facts, calculations, causes or advice. State insufficient evidence when needed. These are audited interpretations; do not claim source inspection or refresh. Copy `nodeId` and `inputDigest`; output only the matching schema.
