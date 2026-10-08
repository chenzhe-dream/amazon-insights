import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { MarketThemeTranslationQuerySchema,MarketThemeTranslationStartSchema,MarketThemeTranslationItemSchema } from '../../shared/market-theme-translation-contracts';

const hash='a'.repeat(64);
test('theme translation request is bound to one saved report and optional item retry list',()=>{
 const reportHash=hash;
 assert.deepEqual(MarketThemeTranslationQuerySchema.parse({reportHash}),{reportHash});
 assert.deepEqual(MarketThemeTranslationStartSchema.parse({reportHash,itemIds:['asin:B000000001:summary']}),{reportHash,itemIds:['asin:B000000001:summary']});
 assert.throws(()=>MarketThemeTranslationQuerySchema.parse({reportHash,source:'client-text'}));
});
test('translation item preserves original text, language and failure state without changing facts',()=>{
 const item=MarketThemeTranslationItemSchema.parse({itemId:'member:t1:content',field:'member-content',language:'zh-CN',translationVersion:'market-theme-translation/v1',sourceHash:hash,original:'Not easy to assemble 2 tools',translated:null,state:'failed',message:'provider timeout'});
 assert.equal(item.original,'Not easy to assemble 2 tools');assert.equal(item.translated,null);assert.equal(item.state,'failed');
 assert.match(randomUUID(),/^[0-9a-f-]{36}$/);
});
