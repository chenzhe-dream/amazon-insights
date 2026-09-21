import {isModuleVisible,type ModuleKey} from '../../shared/module-visibility-contracts';
import type {TabId} from './app-tabs';

const required:Record<TabId,readonly ModuleKey[]>={
 'market-overview':['market'],overview:['overview'],'overview-images':['overview'],
 voc:['voc'],launch:['voc'],'voc-positioning':['voc'],
 keywords:['keywords'],'keyword-insight':['keywords'],definition:['definition'],
 checklist:['checklist'],traffic:['traffic'],projects:['favorites'],
 'keyword-compare':['favorites','keywords'],'traffic-promo':['favorites','traffic'],
 'checklist-library':['favorites','checklist'],
};
export function canSeeTab(modules:readonly ModuleKey[]|undefined,tab:TabId){
 return required[tab].every(module=>isModuleVisible(modules,module));
}
export function firstVisibleTab(modules:readonly ModuleKey[]|undefined):TabId|null {
 return (['overview','market-overview','voc','keywords','definition','checklist','traffic','projects'] as const).find(tab=>canSeeTab(modules,tab))??null;
}
