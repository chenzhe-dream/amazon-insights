import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MarketResearchSection} from '../../../app/market-research-section';
import '../../../app/globals.css';
import '../../../app/market-research.css';
function App(){const [admin,setAdmin]=useState(new URLSearchParams(location.search).get('fixtureRole')==='admin');return <>{admin&&<button onClick={()=>setAdmin(false)}>切换为普通账号</button>}<MarketResearchSection sessionIdentity="role-fixture" showAuditDetails={admin}/></>;}
createRoot(document.getElementById('root')!).render(<App/>);
