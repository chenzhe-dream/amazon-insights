import {marketSites,type MarketSite} from "../shared/market-sites";
export function MarketSiteSelector({value,onChange,disabled=false}:{value:MarketSite;onChange:(site:MarketSite)=>void;disabled?:boolean}){
 return <div className="ss-market-chip-wrap" aria-label="选择市场站点">{marketSites.map(site=><button type="button" key={site.code} className={"ss-market-chip"+(site.code===value?" selected":"")} aria-pressed={site.code===value} disabled={disabled} onClick={()=>onChange(site.code)}>{site.label}</button>)}{["印度站","墨西哥站"].map(label=><button type="button" className="ss-market-chip" key={label} disabled title="当前四模块的数据源支持范围尚未覆盖此站点">{label}</button>)}</div>;
}
