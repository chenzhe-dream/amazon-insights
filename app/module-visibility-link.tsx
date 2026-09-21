"use client";
import Link from 'next/link';
import type {ComponentProps} from 'react';
import type {ModuleKey} from '../shared/module-visibility-contracts';
import type {TabId} from './lib/app-tabs';
import {canSeeTab} from './lib/module-visibility';
export function ModuleVisibilityLink({visibleModules,tab,...props}:ComponentProps<typeof Link>&{visibleModules:readonly ModuleKey[]|undefined;tab:TabId}){
 return canSeeTab(visibleModules,tab)?<Link {...props}/>:null;
}
