import {mapNiche,distRows} from '../../../server/domain/market-research/original-overview/original-mappers';
import type {SellerSpriteMarketReport} from '../../../server/domain/market-research/original-overview/sellersprite-market-niche';
export function completeScoreFixture(){
 const niche=mapNiche({totalUnits:50000,avgUnits:500,avgPrice:25,avgProfit:60,top10ProductCrn:.3,top10BrandCrn:.4,top10SellerCrn:.5,l6NewRatio:.15,l6NewCount:15,l6NewAvgSales:250,ebcProportion:50,amazonSelfProportion:10,fbaProportion:80,returnRatio:3,avgReturnRatio:1}, {}, {marketplace:'US',topN:10,newProductMonths:6,fetchedAt:''});
 const points=Array.from({length:24},(_,i)=>({month:`${2024+Math.floor(i/12)}-${String(i%12+1).padStart(2,'0')}`,value:100+i*3}));
 const rows=(labels:string[])=>distRows(labels.map(label=>({label,products:25,units:100,unitsRatio:.25,asinRatio:.25})),r=>String(r.label));
 const report:SellerSpriteMarketReport={sampleSize:100,concentrationSampleSize:100,products:[],brands:[{rank:1,label:'Brand',products:10,newProducts:1,isNew:false,units:100,newUnits:10,unitsShare:20,newUnitsShare:2,revenue:1000,newRevenue:100,revenueShare:20,newRevenueShare:2}],sellers:[],sellerTypes:[],countries:[],listingTrend:[],listingAge:rows(['3年以上','1年以内']),ratingCounts:rows(['1-50','500以上']),ratingValues:rows(['4.0','4.8']),ebc:rows(['有A+有视频','有A+无视频','无A+有视频','无A+无视频']),prices:distRows([{label:'10-20',products:50,units:600,unitsRatio:.6,asinRatio:.5,items:[{asin:'B000000001',price:15,profit:70}]},{label:'20-30',products:50,units:400,unitsRatio:.4,asinRatio:.5,items:[{asin:'B000000002',price:25,profit:60}]}],r=>String(r.label)),keywordTrends:[{keyword:'lamp',searches:100000,points}],salesTrend:points,salesAmountTrend:points.map(p=>({...p,value:p.value*20})),productDemand:{asinCount:100,returnRatio:3,avgReturnRatio:1,searchToPurchaseRatio:5,avgSearchToPurchaseRatio:5,pageViews:points,updatedAt:'2025-12'}};
 report.sellers=structuredClone(report.brands);
 return {niche,report};
}
