import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MarketKeywordSection} from '../../../app/market-keyword-section';
import '../../../app/globals.css';
import '../../../app/market-ui-reference.css';
import '../../../app/market-research.css';
function App(){const [selection,setSelection]=useState({nodeIdPath:'1:2:3',fromMonth:'2026-07',toMonth:'2026-08'});return <MarketKeywordSection showAuditDetails={new URLSearchParams(window.location.search).get("audit")==="1"} cacheIdentity="keyword-test-session" selection={selection} onSelectionChange={next=>setSelection(old=>({...old,...next}))} maxMonth="2026-08"/>;}
createRoot(document.getElementById('root')!).render(<main className="market-ui-reference"><App/></main>);
