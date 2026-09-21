import assert from 'node:assert/strict';
import test from 'node:test';
import {createStatisticsViewAccess} from '../../server/auth/statistics-view-access';
import type {AuthenticatedPrincipal} from '../../server/auth/authentication-service';

test('explicit statistics grants are live, organization scoped and never mutate legacy management access',async()=>{
 const p={kind:'user',userId:'u',organizationId:'org',role:'member',email:'u@example.test',sessionId:'s'} as AuthenticatedPrincipal;
 let granted=false,active=true,legacy=false;
 const management={canView:async()=>legacy};
 const view=createStatisticsViewAccess({legacyAccess:management,authService:{findPublicUser:async()=>active?{id:'u',organizationId:'org',status:'active'} as never:null},visibility:{hasStatisticsViewGrant:async(org:string,id:string)=>granted&&org==='org'&&id==='u'}});
 assert.equal(await view.canView(p),false);
 granted=true;assert.equal(await view.canView(p),true);assert.equal(await management.canView(),false);
 assert.equal(await view.canView({...p,organizationId:'other'}),false);
 active=false;assert.equal(await view.canView(p),false);active=true;
 granted=false;assert.equal(await view.canView(p),false);
 legacy=true;assert.equal(await view.canView(p),true);
});

test('statistics storage failure denies new viewers',async()=>{
 const view=createStatisticsViewAccess({legacyAccess:null,authService:{findPublicUser:async()=>({id:'u',organizationId:'o',status:'active'} as never)},visibility:{hasStatisticsViewGrant:async()=>{throw new Error('unavailable')}}});
 assert.equal(await view.canView({kind:'user',userId:'u',organizationId:'o'} as AuthenticatedPrincipal),false);
});
