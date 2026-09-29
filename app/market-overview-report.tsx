"use client";
import {matchesFrozenOverviewBasicScope} from './lib/market-overview-basic-scope';
import React,{useEffect,useState} from 'react';
import type {z} from 'zod';
import type {MarketOverviewReportEntrySchema,MarketOverviewDetailsResponseSchema} from '../shared/market-overview-report-contracts';
import {readOverviewDetails} from './lib/market-overview-browser';
import {MarketOverviewReportView} from './market-overview-report-view';
export {MarketOverviewMetricCards} from './market-overview-report-view';
type Entry=z.infer<typeof MarketOverviewReportEntrySchema>;
type Details=z.infer<typeof MarketOverviewDetailsResponseSchema>;

/** Request ownership stays here. The original-style view receives saved data only. */
export function MarketOverviewReport({entry,headTopN,newProductMonths,categoryName,onSupplement,supplementBusy,showAuditDetails=false,onBasicSnapshot}:{entry:Entry;headTopN?:number;newProductMonths?:number;categoryName?:string|null;onSupplement?:()=>void;supplementBusy?:boolean;showAuditDetails?:boolean;onBasicSnapshot?:(value:{key:string;report:Details['numbers']['basicOverview']})=>void}){
 const [response,setResponse]=useState<{key:string;detail:Details|null;error:string|null}|null>(null),[reload,setReload]=useState(0);
 const key=`${entry.report.moduleRunId}/${entry.attemptId}/${entry.report.reportHash}/${reload}`;
 useEffect(()=>{const owner=new AbortController();void readOverviewDetails(entry.report.moduleRunId,entry.attemptId,entry.report.reportHash,owner.signal).then(detail=>{if(!owner.signal.aborted)setResponse({key,detail,error:null});}).catch(e=>{if(!owner.signal.aborted)setResponse({key,detail:null,error:e instanceof Error?e.message:'报告读取失败'});});return()=>owner.abort();},[entry.attemptId,entry.report.moduleRunId,entry.report.reportHash,key]);
 const current=response?.key===key?response:null;
 const owned=current?.detail?.entry.report.reportHash===entry.report.reportHash&&current.detail.entry.attemptId===entry.attemptId?current.detail:null;
 const frozen=owned?.numbers.basicOverview;
 const basic=frozen&&matchesFrozenOverviewBasicScope(frozen,entry.report.scope,headTopN,newProductMonths)?frozen:null;
 useEffect(()=>{onBasicSnapshot?.({key:`${entry.report.moduleRunId}/${entry.attemptId}/${entry.report.reportHash}`,report:basic});},[onBasicSnapshot,basic,entry.report.moduleRunId,entry.attemptId,entry.report.reportHash]);
 return <MarketOverviewReportView entry={entry} detail={owned} error={current?.error??null} onRetry={()=>setReload(n=>n+1)} headTopN={headTopN} newProductMonths={newProductMonths} categoryName={categoryName} onSupplement={onSupplement} supplementBusy={supplementBusy} showAuditDetails={showAuditDetails}/>;
}
