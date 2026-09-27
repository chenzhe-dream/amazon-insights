/** Only the trusted export shell uses these selectors. Business markup is sanitized first. */
export const snapshotNavigationStyles = `
.snapshot-shell{min-height:100vh;color:#17221c}
.snapshot-shell,.snapshot-shell *{box-sizing:border-box}
.snapshot-shell>.snapshot-radio{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;clip-path:inset(50%)}
.snapshot-layout{display:grid;grid-template-columns:224px minmax(0,1fr);gap:20px;margin:auto;padding:0}
.snapshot-nav{align-self:start;position:sticky;top:16px;max-height:calc(100dvh - 32px);overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#cbd5e1 transparent;padding:12px;border:1px solid #e0e7ef;border-radius:14px;background:#fff;box-shadow:0 3px 16px #21374e06}
.snapshot-nav-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:3px 8px 12px;margin-bottom:8px;border-bottom:1px solid #edf1f5;font-size:13px;font-weight:700;color:#33475e}.snapshot-nav-heading span{font-size:11px;font-weight:400;color:#8392a5}
.snapshot-mobile-menu>summary{display:none}
@media(min-width:1101px){.snapshot-mobile-menu:not([open])>summary{display:block;cursor:pointer;padding:9px 12px;font-size:13px;font-weight:750}}
.snapshot-nav-list{display:flex;flex-direction:column;gap:6px}
.snapshot-nav-group{margin:0}.snapshot-nav-group>summary{list-style:none;cursor:pointer}.snapshot-nav-group>summary::-webkit-details-marker{display:none}
.snapshot-nav-card{display:flex;align-items:center;gap:9px;width:100%;padding:10px;border:1px solid transparent;border-radius:9px;background:transparent;box-shadow:none;color:#111827;text-align:left;text-decoration:none;cursor:pointer}
.snapshot-nav-card:hover{background:#f4f7fb}.snapshot-nav-card b,.snapshot-nav-card small{display:block}.snapshot-nav-card b{font-size:13px;color:#33475e;font-weight:650}.snapshot-nav-card small{font-size:10px;color:#8290a3;line-height:1.5;margin-top:2px}.snapshot-nav-copy{min-width:0;flex:1}
.snapshot-nav-icon{width:28px;height:28px;border-radius:8px;display:grid;place-items:center;flex:none;background:var(--snap-tone);color:#fff}.snapshot-nav-icon svg{width:16px;height:16px;display:block}
.snapshot-nav-chevron{width:7px;height:7px;border-right:1.5px solid var(--snap-tone);border-bottom:1.5px solid var(--snap-tone);transform:rotate(45deg);flex:none;margin-right:3px}.snapshot-nav-group[open] .snapshot-nav-chevron{transform:rotate(225deg)}
.snapshot-nav-children{display:flex;flex-direction:column;gap:3px;margin:2px 0 5px 13px;padding-left:8px;border-left:1px solid #e6ebf2}.snapshot-nav-child{font-size:12px;padding:8px}.snapshot-nav-child .snapshot-nav-icon{width:23px;height:23px;border-radius:6px}.snapshot-nav-child .snapshot-nav-icon svg{width:13px;height:13px}
.snapshot-body{min-width:0}.snapshot-page{display:none;min-width:0}.snapshot-page .matrix-wrap,.snapshot-page [class*="table-wrap"]{max-width:100%;overflow-x:auto}
.snapshot-page table :is(td,th){font-size:12px;line-height:1.6}
.snapshot-page .traffic-distribution-grid{min-width:1080px}
.snapshot-page :is(.traffic-distribution-head,.traffic-distribution-row){grid-template-columns:168px repeat(3,minmax(300px,1fr))}
.snapshot-page .traffic-distribution-head{font-size:11px}
.snapshot-page .traffic-metric-cell{flex-direction:column;justify-content:center;align-items:stretch;gap:6px;min-width:0}
.snapshot-page .traffic-metric-cell>small{font-size:10px;line-height:1.5;color:#718095}
.snapshot-page .traffic-dist-bars{gap:5px}
.snapshot-page .traffic-dist-bars>div{grid-template-columns:80px minmax(60px,1fr) 64px 44px;font-size:11px;line-height:1.5}
.snapshot-page .traffic-dist-bars strong{font-size:11px}
.snapshot-page .child-traffic-meta :is(b,em){font-size:12px}
.snapshot-page .child-traffic-meta small{font-size:10px}
.snapshot-radio:focus-visible~.snapshot-layout label[for],.snapshot-radio:focus-visible~.snapshot-layout .snapshot-nav-group>summary{outline:0}
@media(max-width:1100px){.snapshot-layout{display:block;padding:0}.snapshot-nav{position:relative;top:auto;max-height:none;margin-bottom:14px;padding:8px}.snapshot-nav-heading{display:none}.snapshot-mobile-menu>summary{display:block;cursor:pointer;padding:9px 12px;font-size:13px;font-weight:750;list-style:none}.snapshot-mobile-menu>summary::-webkit-details-marker{display:none}.snapshot-mobile-menu>summary:after{content:'⌄';float:right}.snapshot-mobile-menu[open]>summary:after{content:'⌃'}.snapshot-mobile-menu:not([open]) .snapshot-nav-list{display:none}.snapshot-shell:has(>.snapshot-radio:focus-visible) .snapshot-mobile-menu:not([open])>summary{outline:2px solid #155eef;outline-offset:2px}.snapshot-nav-list{padding-top:7px;max-height:min(65vh,560px);overflow:auto}.snapshot-nav-group{scroll-margin-top:8px}}
@media print{.snapshot-layout{display:block;max-width:none;padding:0}.snapshot-nav,.snapshot-shell>.snapshot-radio{display:none!important}.snapshot-page{display:block!important;break-before:page}.snapshot-page:first-child{break-before:auto}}
`;
