import assert from 'node:assert/strict';
import test from 'node:test';
import {renderToStaticMarkup} from 'react-dom/server';
import {SnapshotPresentationProvider} from '../../app/project-report-views/snapshot-presentation';
import {InlineReportText, InlineDecisionTableRow} from '../../app/product-definition-inline';
import {ActionStepsCell} from '../../app/action-steps-cell';

test('snapshot retains text, row evidence and all actions in native disclosures',()=>{
  const html=renderToStaticMarkup(<SnapshotPresentationProvider><InlineReportText text={'完整业务原文'.repeat(40)}/><table><tbody><InlineDecisionTableRow label="结构方案" colSpan={2}><td>结构方案</td></InlineDecisionTableRow></tbody></table><ActionStepsCell value="第一项；第二项；第三项；第四项；第五项；第六项完整动作"/></SnapshotPresentationProvider>);
  assert.match(html,/definition-native-text/);
  assert.match(html,/历史结果未记录规则版本/);
  assert.match(html,/第六项完整动作/);
  assert.doesNotMatch(html,/<button/);
  assert.match(html,/<details/);
});

test('ordinary page retains its interactive buttons and default action limit',()=>{
  const html=renderToStaticMarkup(<table><tbody><InlineDecisionTableRow label="方案" colSpan={2}><td>方案</td></InlineDecisionTableRow></tbody></table>);
  assert.match(html,/<button/);
  assert.doesNotMatch(html,/历史结果未记录规则版本/);
  const actions=renderToStaticMarkup(<ActionStepsCell value="一；二；三；四；五；未展开的第六项"/>);
  assert.doesNotMatch(actions,/未展开的第六项/);
});
