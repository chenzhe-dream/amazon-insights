import type {AuthenticationService} from './authentication-service';
import type {UserPresenceAccess} from './user-presence-access';
import type {ModuleVisibilityRepository} from '../db/module-visibility-repository';

/** Read-only grants deliberately do not participate in module-management authorization. */
export function createStatisticsViewAccess(options:{
 legacyAccess:UserPresenceAccess|null;
 authService:Pick<AuthenticationService,'findPublicUser'>|null;
 visibility:Pick<ModuleVisibilityRepository,'hasStatisticsViewGrant'>|null;
}):UserPresenceAccess{
 return {async canView(principal){
  try{
   if(principal.kind!=='user')return false;
   if(await options.legacyAccess?.canView(principal))return true;
   const user=await options.authService?.findPublicUser(principal.userId);
   if(!user||user.id!==principal.userId||user.organizationId!==principal.organizationId||user.status!=='active')return false;
   return Boolean(await options.visibility?.hasStatisticsViewGrant(principal.organizationId,principal.userId));
  }catch{return false;}
 }};
}
