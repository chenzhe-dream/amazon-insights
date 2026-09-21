import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MarketThemeInsightPanel } from '../../../app/market-theme-insight-panel';
import { themeEntry } from './market-theme-page-fixture';
function Harness(){const [old,setOld]=useState(false);return <><button onClick={()=>setOld(v=>!v)}>切换报告</button><MarketThemeInsightPanel entry={themeEntry(old)}/></>;}
createRoot(document.getElementById('root')!).render(<Harness/>);
