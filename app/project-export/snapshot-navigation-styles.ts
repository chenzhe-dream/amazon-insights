/** Only the trusted export shell uses these selectors. Business markup is sanitized first. */
export const snapshotNavigationStyles = `
.snapshot-shell{min-height:100vh;color:#17221c}
.snapshot-shell,.snapshot-shell *{box-sizing:border-box}
.snapshot-shell>.snapshot-radio{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;clip-path:inset(50%)}
.snapshot-layout{display:grid;grid-template-columns:238px minmax(0,1fr);gap:22px;max-width:1600px;margin:auto;padding:20px}
.snapshot-nav{align-self:start;position:sticky;top:12px;max-height:calc(100vh - 24px);overflow:auto;padding:12px;border:1px solid #d7dfeb;border-radius:13px;background:#e8edf4}
.snapshot-mobile-menu>summary{display:none}
@media(min-width:761px){.snapshot-mobile-menu:not([open])>summary{display:block;cursor:pointer;padding:9px 12px;font-size:13px;font-weight:750}}
.snapshot-nav-list{display:flex;flex-direction:column;gap:8px}
.snapshot-nav-group{margin:0}.snapshot-nav-group>summary{list-style:none;cursor:pointer}.snapshot-nav-group>summary::-webkit-details-marker{display:none}
.snapshot-nav-card{display:flex;align-items:center;gap:11px;width:100%;padding:10px 12px;border:1px solid #d7dfeb;border-radius:11px;background:#fff;box-shadow:0 2px 8px rgba(26,44,72,.06);color:#111827;text-align:left;text-decoration:none;cursor:pointer}
.snapshot-nav-card:hover{background:#f8fbff}.snapshot-nav-card b,.snapshot-nav-card small{display:block}.snapshot-nav-card b{font-size:14px;color:var(--snap-tone);font-weight:750}.snapshot-nav-card small{font-size:11px;color:#526074;line-height:1.4;margin-top:3px}.snapshot-nav-copy{min-width:0;flex:1}
.snapshot-nav-icon{width:30px;height:30px;border-radius:8px;display:grid;place-items:center;flex:none;background:var(--snap-tone);color:#fff}.snapshot-nav-icon svg{width:17px;height:17px;display:block}
.snapshot-nav-chevron{width:7px;height:7px;border-right:1.5px solid var(--snap-tone);border-bottom:1.5px solid var(--snap-tone);transform:rotate(45deg);flex:none;margin-right:3px}.snapshot-nav-group[open] .snapshot-nav-chevron{transform:rotate(225deg)}
.snapshot-nav-children{display:flex;flex-direction:column;gap:5px;margin:6px 0 2px 13px;padding-left:10px;border-left:1px solid #cad4df}.snapshot-nav-child{font-size:12px;padding:9px 11px}.snapshot-nav-child .snapshot-nav-icon{width:25px;height:25px;border-radius:7px}.snapshot-nav-child .snapshot-nav-icon svg{width:14px;height:14px}
.snapshot-body{min-width:0}.snapshot-page{display:none;min-width:0}.snapshot-page .matrix-wrap,.snapshot-page [class*="table-wrap"]{max-width:100%;overflow-x:auto}
.snapshot-radio:focus-visible~.snapshot-layout label[for],.snapshot-radio:focus-visible~.snapshot-layout .snapshot-nav-group>summary{outline:0}
@media(max-width:760px){.snapshot-layout{display:block;padding:10px}.snapshot-nav{position:relative;top:auto;max-height:none;margin-bottom:14px;padding:8px}.snapshot-mobile-menu>summary{display:block;cursor:pointer;padding:9px 12px;font-size:13px;font-weight:750;list-style:none}.snapshot-mobile-menu>summary::-webkit-details-marker{display:none}.snapshot-mobile-menu>summary:after{content:'⌄';float:right}.snapshot-mobile-menu[open]>summary:after{content:'⌃'}.snapshot-mobile-menu:not([open]) .snapshot-nav-list{display:none}.snapshot-shell:has(>.snapshot-radio:focus-visible) .snapshot-mobile-menu:not([open])>summary{outline:3px solid #155eef;outline-offset:2px}.snapshot-nav-list{padding-top:7px;max-height:min(65vh,560px);overflow:auto}.snapshot-nav-group{scroll-margin-top:8px}}
@media print{.snapshot-layout{display:block;max-width:none;padding:0}.snapshot-nav,.snapshot-shell>.snapshot-radio{display:none!important}.snapshot-page{display:block!important;break-before:page}.snapshot-page:first-child{break-before:auto}}
`;
