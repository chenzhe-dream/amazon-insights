import React from 'react';
import {createRoot} from 'react-dom/client';
import {MarketOverviewOriginalSummary} from '../../../app/market-overview-original-summary';
import {MarketAdminTools} from '../../../app/market-admin-tools';
import type {MarketOverviewOriginalSynthesis} from '../../../shared/market-overview-original-synthesis';
import '../../../app/globals.css';
import '../../../app/market-research.css';
import '../../../app/market-overview-reference.css';
createRoot(document.getElementById('root')!).render(<main className="market-research-page market-ui-reference"><div className="card" style={{padding:24}}><MarketAdminTools enabled={new URLSearchParams(location.search).get('role')==='admin'}><MarketOverviewOriginalSummary result={(window as unknown as {scoreResult:MarketOverviewOriginalSynthesis}).scoreResult}/></MarketAdminTools></div></main>);
