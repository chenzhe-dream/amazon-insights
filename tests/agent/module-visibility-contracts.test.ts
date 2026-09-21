import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import assert from 'node:assert/strict';
import test from 'node:test';
import {SessionResponseSchema} from '../../shared/agent-contracts';
import {VisibleModulesSchema} from '../../shared/module-visibility-contracts';
import {canSeeTab,firstVisibleTab} from '../../app/lib/module-visibility';

test('module visibility covers child tabs and favorite shortcuts without enabling hidden modules',()=>{
 assert.equal(canSeeTab(undefined,'voc-positioning'),true);
 assert.equal(canSeeTab([],'voc'),false);assert.equal(firstVisibleTab([]),null);
 assert.equal(canSeeTab(['voc'],'launch'),true);assert.equal(canSeeTab(['voc'],'keyword-insight'),false);
 assert.equal(canSeeTab(['favorites'],'traffic-promo'),false);
 assert.equal(canSeeTab(['favorites','traffic'],'traffic-promo'),true);
 assert.equal(VisibleModulesSchema.safeParse(['voc','voc']).success,false);
 assert.equal(VisibleModulesSchema.safeParse(['unknown']).success,false);
});

test('session carries an explicit empty visibility list without treating it as default access',()=>{
 const result=SessionResponseSchema.safeParse({authenticated:true,user:{id:'11111111-1111-4111-8111-111111111111',organizationId:'22222222-2222-4222-8222-222222222222',email:'person@example.com',displayName:'Person',role:'member',status:'active',createdAt:'2026-09-14T00:00:00.000Z',updatedAt:'2026-09-14T00:00:00.000Z'},sessionIdentity:'A'.repeat(43),canViewUserPresence:false,visibleModules:[],canManageModuleVisibility:false});
 assert.equal(result.success,true);
 if(result.success&&result.data.authenticated)assert.deepEqual(result.data.visibleModules,[]);
});

test('registering a future parent module updates selection validation without opening it in initial defaults',()=>{
 const source=readFileSync(new URL('../../shared/module-visibility-contracts.ts',import.meta.url),'utf8');
 // Simulate the developer adding ONLY a registry entry, leaving validators and defaults untouched.
 const expanded=source.replace('export const MODULES = [',"export const MODULES = [{key:'future-module',label:'Future module'},");
 assert.notEqual(expanded,source);
 const output=ts.transpileModule(expanded,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
 const exports:Record<string,unknown>={};
 runInNewContext(output,{exports,require:createRequire(import.meta.url)});
 const keys=Array.from(exports.ALL_MODULES as string[]);
 assert.ok(keys.includes('future-module'));
 const schema=exports.VisibleModulesSchema as typeof VisibleModulesSchema;
 assert.equal(schema.safeParse(keys).success,true);
 assert.equal(schema.safeParse([...keys,'future-module']).success,false);
 assert.equal(schema.safeParse(['not-registered']).success,false);
 assert.equal((exports.INITIAL_NEW_USER_MODULES as string[]).includes('future-module'),false);
});
