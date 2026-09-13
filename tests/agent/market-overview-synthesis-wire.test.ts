import assert from 'node:assert/strict';
import test from 'node:test';
import {createMarketOverviewSynthesisModelWire} from '../../server/runtime/market-overview-synthesis-wire';
import {createStructuredResponseFormat} from '../../server/runtime/structured-response-format';

import {synthesisWireFixture} from './helpers/market-overview-synthesis-wire-fixture';

test('overview synthesis wire compacts repeated evidence and restores every output reference',()=>{
 const input=synthesisWireFixture(),wire=createMarketOverviewSynthesisModelWire(input);
 assert.ok(JSON.stringify(wire.input).length<JSON.stringify(input).length);
 assert.equal(wire.input.statements.length,1);
 const statement=(i:number)=>{const [parts,f,g]=wire.input.statements[i];return {p:parts.map(([k,value])=>({k,v:k==='t'?wire.input.texts[value]:value})),f,g};};
 const [dimension,data,meaning,conclusion,limitations,verification]=wire.input.children[0];
 const result={mode:'dimension-reduce',dimensionSection:{dimensionId:wire.input.dimensions[dimension].map(i=>wire.input.names[i]).join(':'),data:statement(data),meaning:statement(meaning),conclusion:statement(conclusion),limitations:limitations.map(statement),verification:verification.map(statement)}};
 assert.deepEqual(wire.decode(result),{mode:'dimension-reduce',dimensionSection:input.children[0].section});
 const invalid=structuredClone(result);invalid.dimensionSection.data.f=[999];assert.throws(()=>wire.decode(invalid));
 assert.equal(createStructuredResponseFormat<unknown>(wire.outputSchema,'MarketOverviewSynthesisModelDimensionOutput@1.0.0',wire.schemaDefinitions).format.strict,true);
 const final=createMarketOverviewSynthesisModelWire({...input,mode:'final',dimensionId:'final'});
 assert.throws(()=>final.decode(result));
 const finalResult={mode:'final',summary:{decision:'mixed-signals',statement:statement(0)},conflicts:[],limitations:[statement(0)],verification:[statement(0)]};
 assert.equal(final.decode(finalResult).mode,'final');
 assert.equal(createStructuredResponseFormat<unknown>(final.outputSchema,'MarketOverviewSynthesisModelFinalOutput@1.0.0',final.schemaDefinitions).format.strict,true);
});
