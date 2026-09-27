import React, {useState} from 'react';
import type {MarketSite} from '../../../shared/market-sites';
import {createRoot} from 'react-dom/client';
import {MarketThemeSection} from '../../../app/market-theme-section';
import '../../../app/globals.css';
import '../../../app/market-research.css';
function Harness(){
 const [selection,setSelection]=useState({marketplace:'US' as MarketSite,nodeIdPath:'',fromMonth:'2026-08',toMonth:'2026-08'});
 return new URL(location.href).searchParams.has('controlled')?<MarketThemeSection maxMonth="2026-08" selection={selection} onSelectionChange={patch=>setSelection(s=>({...s,...patch}))}/>:<MarketThemeSection maxMonth="2026-08"/>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);
