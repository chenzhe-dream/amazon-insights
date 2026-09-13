import assert from 'node:assert/strict';
import test from 'node:test';
import {z} from 'zod';
import {buildMarketShapeExplanationCatalog} from '../../server/domain/market-research/shape-explanation-catalog';
import {buildMarketShapeExplanationWindows, decodeMarketShapeExplanationWindow} from '../../server/domain/market-research/shape-explanation-wire';
import {buildMarketShapeDimensionSynthesisInput, validateMarketShapeDimensionSynthesisOutput} from '../../server/domain/market-research/shape-explanation-synthesis';
import {createMarketShapeSynthesisModelWire} from '../../server/runtime/market-shape-synthesis-wire';
import {MarketShapeSynthesisChildSchema} from '../../shared/market-shape-synthesis-contracts';
import type {MarketShapeExplanationCatalog} from '../../shared/market-shape-explanation-contracts';
import type {MarketShapeExplanationWindow} from '../../shared/market-shape-explanation-wire-contracts';
import {sourceCatalog} from './helpers/market-shape-explanation-fixture';

function leaf(catalog: MarketShapeExplanationCatalog, window: MarketShapeExplanationWindow) {
    const decoded = decodeMarketShapeExplanationWindow(catalog, window);
    const row = decoded.rows.find(candidate => candidate.cells.some(cell => cell.value !== null));
    if (!row) throw new Error('Fixture window has no numeric evidence row');
    const cell = row.cells.find(candidate => candidate.value !== null);
    if (!cell) throw new Error('Fixture row has no numeric evidence cell');
    const statement = {
        kind: 'observed' as const,
        parts: [{kind: 'text' as const, text: 'Observed value: '}, {kind: 'cell' as const, rowId: row.id, cellId: cell.id}],
        evidenceRowIds: [row.id],
        limitationCodes: [],
    };
    const limitationCodes = [...new Set(decoded.limitations.map(limitation => limitation.code))];
    const risk = {
        kind: 'risk' as const,
        parts: [{kind: 'text' as const, text: 'Retain every visible source limitation.'}],
        evidenceRowIds: [],
        limitationCodes,
    };
    return MarketShapeSynthesisChildSchema.parse({childId: window.windowId, leafWindowIds: [window.windowId], section: {
        dimension: window.dimension,
        status: 'explained',
        summary: statement,
        findings: [statement],
        limitations: [risk],
        verification: [{...risk, kind: 'verification', parts: [{kind: 'text', text: 'Verify with another source.'}]}],
    }});
}

async function fixture() {
    const catalog = buildMarketShapeExplanationCatalog(await sourceCatalog());
    const windows = (await buildMarketShapeExplanationWindows(catalog, window => window.coverage.rowIds.length <= 2))
        .filter(window => window.dimension === 'brand').slice(0, 2);
    const input = await buildMarketShapeDimensionSynthesisInput(catalog, 'brand', windows.map(window => leaf(catalog, window)), windows.map(window => window.windowId), () => true);
    return {catalog, input};
}

test('local synthesis wire preserves business content while aliasing repeated identities', async () => {
    const {catalog, input} = await fixture();
    const wire = createMarketShapeSynthesisModelWire(input);
    assert.equal(wire.input.nodeId, input.nodeId);
    assert.equal(wire.input.encoding, 'shape-synthesis-local-refs/v1');
    assert.equal(wire.encoding, 'shape-synthesis-local-refs/v1');
    assert.deepEqual(wire.input.cellColumns, ['cellRef', 'metric', 'value', 'unit']);
    assert.ok(JSON.stringify(wire.input).length < JSON.stringify(input).length);
    assert.deepEqual(wire.input.evidenceRows.map(row => ({
        id: row.semanticKey,
        context: row.context,
        cells: row.cells.map(([, metric, value, unit]) => ({id: metric, value, unit})),
    })), input.evidenceRows);
    assert.ok(wire.input.statements.length < input.children.flatMap(child => [child.section.summary, ...child.section.findings, ...child.section.limitations, ...child.section.verification]).length);
    const childSection = wire.input.children[0].section;
    const section = {
        dimension: childSection.dimension,
        status: childSection.status,
        summary: wire.input.statements[childSection.summary],
        findings: childSection.findings.map(index => wire.input.statements[index]),
        limitations: childSection.limitations.map(index => wire.input.statements[index]),
        verification: childSection.verification.map(index => wire.input.statements[index]),
    };
    const decoded = wire.decode({version: 'market-shape-dimension-synthesis-output/v1', nodeId: input.nodeId, inputDigest: input.inputDigest, section});
    assert.doesNotThrow(() => validateMarketShapeDimensionSynthesisOutput(catalog, input, decoded));
    for (const [index, child] of wire.input.children.entries()) {
        const references = child.section;
        const restored = wire.decode({version: 'market-shape-dimension-synthesis-output/v1', nodeId: input.nodeId, inputDigest: input.inputDigest, section: {
            dimension: references.dimension,
            status: references.status,
            summary: wire.input.statements[references.summary],
            findings: references.findings.map(reference => wire.input.statements[reference]),
            limitations: references.limitations.map(reference => wire.input.statements[reference]),
            verification: references.verification.map(reference => wire.input.statements[reference]),
        }});
        assert.deepEqual(restored.section, input.children[index].section);
    }
});

test('decode rejects unknown aliases and cross-input binding drift without string replacement', async () => {
    const {input} = await fixture();
    const wire = createMarketShapeSynthesisModelWire(input);
    const childSection = wire.input.children[0].section;
    const output = {version: 'market-shape-dimension-synthesis-output/v1' as const, nodeId: input.nodeId, inputDigest: input.inputDigest, section: {
        dimension: childSection.dimension,
        status: childSection.status,
        summary: structuredClone(wire.input.statements[childSection.summary]),
        findings: childSection.findings.map(index => structuredClone(wire.input.statements[index])),
        limitations: childSection.limitations.map(index => structuredClone(wire.input.statements[index])),
        verification: childSection.verification.map(index => structuredClone(wire.input.statements[index])),
    }};
    output.section.summary.evidenceRowRefs = ['r999'];
    assert.throws(() => wire.decode(output), error => error instanceof z.ZodError && /alias/.test(error.message));
    output.section.summary.evidenceRowRefs = ['r00'];
    assert.throws(() => wire.decode(output), error => error instanceof z.ZodError && /alias/.test(error.message));
    output.section.summary.evidenceRowRefs = [];
    const cellPart = output.section.summary.parts.find(part => part.kind === 'cell');
    assert.ok(cellPart && cellPart.kind === 'cell');
    cellPart.cellRef = 'k01';
    assert.throws(() => wire.decode(output), error => error instanceof z.ZodError && /alias/.test(error.message));
    cellPart.cellRef = 'k0';
    output.inputDigest = '0'.repeat(64);
    assert.throws(() => wire.decode(output), error => error instanceof z.ZodError && /binding/.test(error.message));
});
