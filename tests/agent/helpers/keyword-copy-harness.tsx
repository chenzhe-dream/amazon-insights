import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { KeywordDemandSection } from "../../../app/keyword-demand-section";
import type { KeywordDemandSources } from "../../../app/keyword-demand-analysis";
import "../../../app/globals.css";
import "../../../app/comparison-layout.css";

function Harness() {
  const [other, setOther] = useState(false);
  const products = [{ asin: other ? "B00P8J6AQG" : "B01M119PTN", brand: "Fixture", title: "Snow sled" }];
  const words = other ? ["new snow sled"] : ["snow sled", "snow sled for kids", "red snow sled"];
  const sources: KeywordDemandSources = { enrichmentByKeyword: {}, analysisByAsin: {
    [products[0].asin]: { asin: products[0].asin, marketplace: "US", fetchedAt: "2026-09-15", status: "ready", totalKeywordsInPeriod: 3, topKeywordsAnalyzed: 3,
      keywords: words.map((keyword, i) => ({ keyword, searchVolume: 100 - i * 10, trafficShare: 30, abaRank: i + 1, cpcMedian: null, cpcLow: null, cpcHigh: null, naturalRatio: null, trafficDependency: null, organicRank: null, rankEvolution: null, keywordHealth: null, top3ClickShare: null, top3ConversionShare: null, clickConversionRate: null })) },
  } };
  return <><button onClick={() => setOther(true)}>切换测试项目</button><KeywordDemandSection products={products} sources={sources} /></>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
