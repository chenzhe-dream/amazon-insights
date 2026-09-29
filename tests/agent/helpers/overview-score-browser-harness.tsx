import React from 'react';
import {createRoot} from 'react-dom/client';
import {MarketOverviewOriginalSummary} from '../../../app/market-overview-original-summary';
import type {MarketOverviewOriginalSynthesis} from '../../../shared/market-overview-original-synthesis';
import '../../../app/globals.css';
import '../../../app/market-research.css';
import '../../../app/market-overview-reference.css';
createRoot(document.getElementById('root')!).render(<main className="market-research-page market-ui-reference"><div className="card" style={{padding:24}}><MarketOverviewOriginalSummary result={(window as unknown as {scoreResult:MarketOverviewOriginalSynthesis}).scoreResult}/></div></main>);
