-- Preserve every existing task; overview synthesis has a separate audit identity.
ALTER TABLE market_analysis_semantic_snapshot_bindings
  DROP CONSTRAINT market_analysis_semantic_snapshot_bindings_task_check;
ALTER TABLE market_analysis_semantic_snapshot_bindings
  ADD CONSTRAINT market_analysis_semantic_snapshot_bindings_task_check
  CHECK (task IN ('market-overview-explanation','market-product-shape-suggestion',
    'market-keyword-semantics','market-customer-theme-mapping',
    'market-shape-structure-explanation','market-shape-synthesis','market-overview-synthesis'));
