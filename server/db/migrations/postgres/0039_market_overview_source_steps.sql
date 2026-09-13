-- Append a source kind without rewriting any existing attempt or definition.
ALTER TABLE market_analysis_steps DROP CONSTRAINT market_analysis_steps_kind_check;
ALTER TABLE market_analysis_steps ADD CONSTRAINT market_analysis_steps_kind_check
  CHECK(kind IN ('collect-product-month','collect-overview-month','collect-keyword-page','collect-keyword-trend','collect-customer-themes','prepare-members','prepare-keyword-pool','prepare-model-batches','reconcile','model-batch','rules','report'));
