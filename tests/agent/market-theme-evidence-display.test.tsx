import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ThemeEvidenceContent} from '../../app/market-theme-evidence';
import {themeEvidence,themeEntry} from './helpers/market-theme-page-fixture';
test('saved model explanation renders as text alongside the original summary, absence stays explicit',()=>{
  const value=themeEvidence(new URL(`http://fixture/${themeEntry().attemptId}`)).evidence;
  value.analysis!.status='mapped';value.analysis!.reason=null;value.analysis!.labelZh='组装体验';value.analysis!.explanationZh='<img src=x onerror=alert(1)>原文描述组装';
  const markup=renderToStaticMarkup(<ThemeEvidenceContent value={value}/>);assert.match(markup,/主题中文名称：.*组装体验/);assert.match(markup,/归类解释/);assert.match(markup,/&lt;img/);assert.doesNotMatch(markup,/<img|<script/);
  const absent=renderToStaticMarkup(<ThemeEvidenceContent value={{...value,analysis:null}}/>);assert.match(absent,/没有可用的模型结果/);assert.match(absent,/完整摘要原文/);assert.doesNotMatch(absent,/归类解释/);
});
