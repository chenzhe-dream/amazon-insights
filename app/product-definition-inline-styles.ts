export const inlineDefinitionStyles = `
.definition-native-text>summary{list-style:none;color:inherit!important;padding:0!important;cursor:pointer}
.definition-native-text>summary::-webkit-details-marker{display:none}
.definition-native-more,.definition-native-less{display:inline-block;text-decoration:underline;color:#526891;line-height:24px}
.definition-native-less,.definition-native-text[open]>summary>.definition-native-preview,.definition-native-text[open]>summary>.definition-native-more{display:none}
.definition-native-text[open]>summary>.definition-native-less{display:inline-block}
.definition-native-decision>summary{padding:6px 14px!important;font-size:11px}
.definition-reading-paragraphs{white-space:pre-wrap;overflow-wrap:anywhere}
.definition-reading-paragraph+.definition-reading-paragraph{margin-top:5px}
.final-oneliner-value .definition-reading-more{font-weight:400}
.definition-conclusion,.definition-conclusion-original{overflow-wrap:anywhere;white-space:pre-wrap}
.definition-conclusion-warnings{color:#845716}
.definition-product-keys{margin-bottom:6px;font-size:inherit;overflow-wrap:anywhere}
.definition-reading-more{margin-top:5px;white-space:normal}
.definition-reading-more>summary{cursor:pointer;color:#526891;text-decoration:underline;min-height:24px}
.definition-inline-page .action-more:has(.definition-reading-more){display:block;font-size:inherit;font-weight:normal}
.definition-inline-page .final-def-evidence{font-size:10px;line-height:1.6}
.definition-inline-page .final-oneliner-value{font-size:10px;line-height:1.55;color:#24354a;font-weight:700;word-break:break-word;white-space:normal}
.definition-inline-text{min-width:0;max-width:100%;font-weight:inherit;line-height:inherit}
.definition-inline-fragment{overflow-wrap:anywhere;white-space:pre-wrap}
.definition-inline-body{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:var(--definition-inline-lines,3);overflow:hidden}
.definition-inline-copy.expanded .definition-inline-body{display:block;-webkit-line-clamp:unset;overflow:visible}
.definition-inline-asin-heading{margin-bottom:4px;font-size:inherit;line-height:inherit}
.definition-inline-asin-label{font-family:var(--font-geist-mono,Consolas,monospace)}
.definition-inline-copy>.definition-inline-fragment+.definition-inline-fragment{margin-top:8px;padding-top:8px;border-top:1px solid #e7edf5}
.definition-inline-asins>.definition-inline-text+.definition-inline-text{margin-top:9px;padding-top:9px;border-top:1px solid #e7edf5}
.definition-inline-page button.definition-inline-link{appearance:none;display:inline-flex;align-items:center;width:auto;min-height:24px;margin:3px 0 0;padding:2px 0;background:transparent;border:0;box-shadow:none;color:inherit;font:inherit;font-weight:500;text-decoration:underline;white-space:nowrap;cursor:pointer}
.definition-inline-page button.definition-inline-link:hover{text-decoration:none}
.definition-inline-page button.definition-inline-link:focus-visible,.definition-inline-page summary:focus-visible{outline:2px solid #8b7ae8;outline-offset:3px;border-radius:3px}
.definition-inline-page .definition-inline-selected-row>td,.definition-inline-page .definition-inline-selected-row>th{background:#f6f8fe}
.definition-inline-page .definition-inline-detail-row>td{padding:0;background:#f8faff}
.definition-inline-panel{padding:18px 22px;max-width:100%;white-space:normal}
.definition-inline-panel-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:14px}
.definition-inline-panel-heading>b{font-size:13px}
.definition-inline-decisions{display:grid;gap:14px}
.definition-inline-decision{padding:14px 16px;border:1px solid #dfe7f1;border-radius:8px;background:#fff;font-size:12px;line-height:1.7;text-align:left;white-space:normal;min-width:0}
.definition-inline-decision-heading{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px}
.definition-inline-status{font-size:11px;padding:1px 7px;border-radius:5px;background:#eaf7ef;color:#18794e}
.definition-inline-decision.needs_check .definition-inline-status{background:#fff3df;color:#986416}
.definition-inline-decision.rejected .definition-inline-status{background:#fff0ef;color:#b83c3c}
.definition-inline-decision-title{font-weight:600}
.definition-inline-reason{margin:8px 0 14px;color:#475569}
.definition-inline-evidence-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px}
.definition-inline-page .definition-inline-decision h5{font-size:12px;margin:0 0 6px;color:#34445d}
.definition-inline-page .definition-inline-list{margin:0;padding-left:17px;line-height:1.75}
.definition-inline-page .definition-inline-list>li{margin:4px 0;padding-left:0}
.definition-inline-muted{color:#73839a;font-size:12px;font-weight:400}
.definition-inline-warning{color:#996217}
.definition-inline-source+.definition-inline-source{margin-top:10px;padding-top:10px;border-top:1px solid #edf0f6}
.definition-inline-more-sources{margin-top:10px}
.definition-inline-more-sources>summary{cursor:pointer;color:#4f46ad;font-size:12px;line-height:28px}
.definition-inline-more-sources>.definition-inline-source{margin-top:10px}
.definition-inline-less-label,.definition-inline-more-sources[open]>summary>.definition-inline-more-label{display:none}
.definition-inline-more-sources[open]>summary>.definition-inline-less-label{display:inline}
.definition-inline-checks{margin-top:12px;padding:10px 12px;background:#fff9ed;border-radius:6px}
.definition-inline-audit{margin-top:14px;padding-top:10px;border-top:1px solid #e7edf5}
.definition-inline-page .definition-inline-audit>summary,.definition-inline-page .definition-inline-rule>summary{cursor:pointer;color:#73839a;font-size:12px;font-weight:400}
.definition-inline-rule{margin:8px 0}
.definition-inline-rule dl{display:grid;grid-template-columns:70px minmax(0,1fr);gap:5px 12px}
.definition-inline-rule dd{margin:0}
.definition-inline-feature{margin-top:5px}
.definition-inline-page .definition-inline-feature>summary{display:list-item;cursor:pointer;color:#4f46ad;font-size:12px;font-weight:500;line-height:28px;text-decoration:none}
.definition-inline-feature>.definition-inline-decisions{margin-top:8px}
.definition-inline-feature .definition-inline-evidence-grid{grid-template-columns:minmax(0,1fr);gap:14px}
@media(max-width:760px){.definition-inline-evidence-grid{grid-template-columns:minmax(0,1fr);gap:14px}.definition-inline-panel{padding:12px}.definition-inline-decision{padding:12px}}
`;
