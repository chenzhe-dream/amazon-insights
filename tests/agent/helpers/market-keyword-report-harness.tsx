import React from 'react';
import {createRoot} from 'react-dom/client';
import {MarketKeywordFactsReport,MarketKeywordRevisionReport} from '../../../app/market-keyword-report';
import type {MarketKeywordRevisionCatalog} from '../../../shared/market-keyword-revision-contracts';
import '../../../app/globals.css';
import '../../../app/market-research.css';
const catalog:MarketKeywordRevisionCatalog=await fetch('/__keyword_report_fixture').then(r=>r.json());
createRoot(document.getElementById('root')!).render(<main className="market-research-section"><MarketKeywordFactsReport facts={catalog.facts}/><MarketKeywordRevisionReport catalog={catalog}/></main>);
