import React from 'react';
import {createRoot} from 'react-dom/client';
import {MarketResearchSection} from '../../../app/market-research-section';
import '../../../app/globals.css';
import '../../../app/market-research.css';
createRoot(document.getElementById('root')!).render(<MarketResearchSection sessionIdentity="overview-fixture"/>);
