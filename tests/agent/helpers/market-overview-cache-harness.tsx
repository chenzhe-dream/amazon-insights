import React,{useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {MarketOverviewSection,type MarketOverviewController} from '../../../app/market-overview-section';
import '../../../app/globals.css';
import '../../../app/market-research.css';
function Harness(){const controller=useRef<MarketOverviewController>(null),scope={marketplace:'US' as const,nodeQuery:'123:456',month:'2026-08',headTopN:10 as const,newProductMonths:6 as const};return <><button onClick={()=>controller.current?.openReport(scope)}>读取匹配报告</button><MarketOverviewSection scope={scope} fromMonth="2026-07" onFromMonth={()=>{}} onRestoreScope={()=>{}} controller={controller}/></>;}
createRoot(document.getElementById('root')!).render(<Harness/>);
