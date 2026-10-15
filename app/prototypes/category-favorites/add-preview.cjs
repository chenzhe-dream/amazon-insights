// Update only the static prototype page; no service restart or database mutation.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const audit=JSON.parse(fs.readFileSync('C:/Users/EDY/Amazon-Product-Opportunity-Insights.runtime/verification/20261013-market-favorites-v2/duplicate-audit/audit.json','utf8'));
const scopes=Object.fromEntries(audit.groups.flatMap(g=>g.rows).map(r=>[r.id,r.scope.nodeIdPath]));
const file=path.join(__dirname,'category-favorites-prototype.html');
let html=fs.readFileSync(file,'utf8');
if(html.includes('function reportHref'))throw new Error('Already updated');
html=html.replace('</style>','a.link{text-decoration:none}a.link:hover{text-decoration:underline}a.link:focus-visible{outline:2px solid #9b73f0;outline-offset:2px}.no-report{color:#98a5b6;font-size:11px;padding:0 5px}td:last-child{white-space:nowrap}</style>');
html=html.replace('function render(){',`const reportNodePaths=${JSON.stringify(scopes)};
function reportHref(r){
 const view={overview:'overview','shape-price':'shapes',keywords:'keywords','customer-themes':'themes'}[r.module];
 const prefix={overview:'market',shapes:'marketShape',keywords:'marketKeyword',themes:'marketTheme'}[view];
 const runKey={overview:'overviewRun',shapes:'shapeRun',keywords:'keywordRun',themes:'themeRun'}[view];
 const p=new URLSearchParams({tab:'market-overview',themeView:view});
 for(const key of new Set(['market',prefix])){p.set(key+'Site',r.site);p.set(key+'Node',reportNodePaths[r.id]);p.set(key+'From',r.from);p.set(key+'Month',r.period||r.to);}
 p.set(runKey,r.id);if(r.head)p.set('marketHead',String(r.head));if(r.newMonths)p.set('marketNew',String(r.newMonths));
 return 'http://192.168.1.109:32900/?'+p.toString();
}
function render(){`);
const old='查看详情</button><button class="link remove"';
const next='查看详情</button>${r.condition?\'<span class="no-report">暂无报告</span>\':`<a class="link" href="${esc(reportHref(r))}" target="_blank" rel="noopener noreferrer" title="在新标签页预览此历史报告">预览报告 ↗</a>`}<button class="link remove"';
if(!html.includes(old))throw new Error('Action marker missing');
html=html.replace(old,next).replace('这是只读演示，正式页面将从这里打开所选历史报告，沿用其原有条件。','可在列表点击“预览报告”，在新标签页打开 32900 对应历史任务；仅保存条件的记录暂无报告。');
for(const x of html.matchAll(/<script>([\s\S]*?)<\/script>/g))new vm.Script(x[1]);
fs.writeFileSync(file,html);
console.log('Static prototype updated; inline syntax valid; server unchanged.');
