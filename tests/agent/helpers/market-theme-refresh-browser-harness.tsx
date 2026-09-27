import React from 'react';
import {createRoot} from 'react-dom/client';
import {MarketThemeSection} from '../../../app/market-theme-section';
import '../../../app/globals.css';
import '../../../app/market-research.css';
createRoot(document.getElementById('root')!).render(<MarketThemeSection maxMonth="2026-08"/>);
