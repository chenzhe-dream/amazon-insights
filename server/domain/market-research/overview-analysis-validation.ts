import {MarketOverviewAnalysisSchema,MarketOverviewCompleteBriefSchema,type MarketOverviewAnalysis,type MarketOverviewAnalysisBrief} from '../../../shared/market-overview-analysis-contracts';
import {z} from 'zod';

type Catalog={analysisBrief?:unknown;facts:readonly {factId:string;metricRefs:string[]}[];metrics:readonly {metricId:string}[];gaps:readonly {gapId:string}[]};
const fail=():never=>{throw new z.ZodError([{code:'custom',path:[],message:'Overview analysis must cover its frozen dimensions and cite only their facts, gaps and metric tokens'}]);};
const unique=(ids:readonly string[])=>{if(new Set(ids).size!==ids.length)fail();return new Set(ids);};
const subset=(values:readonly string[],allowed:Set<string>)=>{unique(values);if(values.some(id=>!allowed.has(id)))fail();};
export function validateOverviewAnalysisBrief(input:Catalog):MarketOverviewAnalysisBrief|undefined{
  if(input.analysisBrief===undefined)return undefined;
  const brief=MarketOverviewCompleteBriefSchema.parse(input.analysisBrief),facts=unique(input.facts.map(f=>f.factId)),gaps=unique(input.gaps.map(g=>g.gapId));
  unique(brief.dimensions.map(d=>d.id));unique(brief.factLabels.map(f=>f.factId));subset(brief.factLabels.map(f=>f.factId),facts);
  for(const d of brief.dimensions){subset(d.factIds,facts);subset(d.gapIds,gaps);if(!d.factIds.length&&!d.gapIds.length)fail();if(d.coverage&&(d.coverage.totalFactCount<d.factIds.length||d.coverage.totalGapCount<d.gapIds.length))fail();}
  // Every supplied fact and gap belongs to at least one explicit business dimension.
  if([...facts].some(f=>!brief.dimensions.some(d=>d.factIds.includes(f)))||[...gaps].some(g=>!brief.dimensions.some(d=>d.gapIds.includes(g))))fail();
  return brief;
}
export function validateOverviewAnalysis(input:Catalog,candidate:unknown):MarketOverviewAnalysis|undefined{
  const brief=validateOverviewAnalysisBrief(input);if(!brief){if(candidate!==undefined&&candidate!==null)fail();return undefined;}
  const output=MarketOverviewAnalysisSchema.parse(candidate),byId=new Map(brief.dimensions.map(d=>[d.id,d])),facts=new Map(input.facts.map(f=>[f.factId,f])),gapIds=new Set(input.gaps.map(g=>g.gapId)),labels=new Set(brief.factLabels.map(f=>f.factId));
  const dimensions=unique(output.dimensions.map(d=>d.dimensionId));if(dimensions.size!==byId.size||[...dimensions].some(d=>!byId.has(d)))fail();
  function check(s:MarketOverviewAnalysis['summary']['statement'],allowedFacts:Set<string>,allowedGaps:Set<string>){
    subset(s.factIds,allowedFacts);subset(s.gapIds,allowedGaps);if(!s.factIds.length&&!s.gapIds.length)fail();
    const metricIds=new Set(s.factIds.flatMap(id=>facts.get(id)!.metricRefs));
    for(const part of s.parts){
      if(part.kind==='metric'&&!metricIds.has(part.metricId))fail();
      if(part.kind==='fact-label'&&(!s.factIds.includes(part.factId)||!labels.has(part.factId)))fail();
      if(part.kind==='text'&&/([零〇一二两三四五六七八九十百千万亿]+\s*(成|倍|元|美元|人民币|条|个|件|款|家|天|日|月|年|点|%|％)|百分之|千分之|一半|半数)/.test(part.text))fail();
    }
  }
  for(const d of output.dimensions){const source=byId.get(d.dimensionId)!,allowedFacts=new Set(source.factIds),allowedGaps=new Set(source.gapIds);
    for(const s of [d.data,d.meaning,d.conclusion,...d.limitations,...d.verification])check(s,allowedFacts,allowedGaps);
    if(source.factIds.length&&!d.data.factIds.length)fail();
    if(d.data.factIds.some(id=>labels.has(id)&&!d.data.parts.some(p=>p.kind==='fact-label'&&p.factId===id)))fail();
    if(source.gapIds.length&&(!d.limitations.length||source.gapIds.some(id=>!d.limitations.some(l=>l.gapIds.includes(id)))))fail();
  }
  check(output.summary.statement,new Set(facts.keys()),gapIds);
  return output;
}
