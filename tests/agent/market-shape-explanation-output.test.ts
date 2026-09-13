import assert from 'node:assert/strict';
import test from 'node:test';
import { MarketShapeExplanationStatementSchema } from '../../shared/market-shape-explanation-output-contracts';
const statement = (text: string) => ({kind:'inferred',parts:[{kind:'text',text}],evidenceRowIds:['r1'],limitationCodes:[]});
test('shape explanation prose blocks literal numbers and money while reference parts carry identifiers', () => {
  for (const text of ['增长20%', '增长２０％', '增长²倍', '售价$20', '价格￥']) {
    assert.equal(MarketShapeExplanationStatementSchema.safeParse(statement(text)).success, false);
  }
  assert.ok(MarketShapeExplanationStatementSchema.safeParse(statement('样本结构呈现差异，需进一步验证。')).success);
  assert.ok(MarketShapeExplanationStatementSchema.safeParse({...statement('样本销量为'),parts:[{kind:'text',text:'样本销量为'},{kind:'cell',rowId:'r1',cellId:'c1'}]}).success);
});
