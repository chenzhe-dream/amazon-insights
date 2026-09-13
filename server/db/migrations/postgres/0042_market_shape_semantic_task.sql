-- Extend the immutable semantic binding allowlist for A2 structure explanation.
-- Existing task identifiers and historical contracts remain valid.
ALTER TABLE market_analysis_semantic_snapshot_bindings
  DROP CONSTRAINT market_analysis_semantic_snapshot_bindings_task_check;
ALTER TABLE market_analysis_semantic_snapshot_bindings
  ADD CONSTRAINT market_analysis_semantic_snapshot_bindings_task_check
  CHECK (task IN ('market-overview-explanation','market-product-shape-suggestion',
    'market-keyword-semantics','market-customer-theme-mapping','market-shape-structure-explanation'));
