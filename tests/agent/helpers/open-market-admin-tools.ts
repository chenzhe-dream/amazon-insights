import type {Page} from 'playwright';
export async function openMarketAdminTools(page:Page){
 const panel=page.getByRole('group',{name:'管理员工具',exact:true});
 if(await panel.getAttribute('open')===null)await panel.locator(':scope > summary').click();
}
export async function openShapeTaskRecovery(page:Page){
 await openMarketAdminTools(page);
 const details=page.locator('.market-admin-tools .market-shape-query-footer');
 if(await details.getAttribute('open')===null)await details.locator(':scope > summary').click();
}
