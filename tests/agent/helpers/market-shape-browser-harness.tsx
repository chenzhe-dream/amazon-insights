import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MarketShapeSection } from '../../../app/market-shape-section';
import '../../../app/globals.css';
import '../../../app/warm-theme.css';
import '../../../app/comparison-layout.css';
import '../../../app/market-research.css';
import '../../../app/market-shape-reference.css';
function App() { const [selection, setSelection] = useState({ nodeIdPath: '1:2:3', fromMonth: '2026-08', toMonth: '2026-08' }); return <MarketShapeSection selection={selection} onSelectionChange={next => setSelection(old => ({ ...old, ...next }))} maxMonth="2026-08"/>; }
createRoot(document.getElementById('root')!).render(<div className="market-ui-reference launch-page market-research-page"><App /></div>);
