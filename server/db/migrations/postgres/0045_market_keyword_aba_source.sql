-- Add an independently recoverable source step. Existing rows remain unchanged.
ALTER TABLE market_analysis_steps DROP CONSTRAINT market_analysis_steps_kind_check;
ALTER TABLE market_analysis_steps ADD CONSTRAINT market_analysis_steps_kind_check
  CHECK(kind IN ('collect-product-month','collect-overview-month','collect-keyword-page','collect-keyword-trend','collect-keyword-aba','collect-customer-themes','prepare-members','prepare-keyword-pool','prepare-model-batches','reconcile','model-batch','rules','report'));
