import type {ModuleVisibilityDefaults,ModuleKey,VisibilityPeopleResponse,VisibilityPerson} from '../../shared/module-visibility-contracts';
export interface ModuleVisibilityRepository {
 readDefaults(organizationId:string):Promise<ModuleVisibilityDefaults>;
 saveDefaults(input:{organizationId:string;actorId:string;visibleModules:ModuleKey[];version:number}):Promise<ModuleVisibilityDefaults>;
 isOwner(organizationId:string,userId:string):Promise<boolean>;
 read(organizationId:string,userId:string):Promise<ModuleKey[]>;
 list(organizationId:string,q:string,page:number):Promise<VisibilityPeopleResponse>;
 save(input:{organizationId:string;actorId:string;userId:string;visibleModules:ModuleKey[];version:number}):Promise<VisibilityPerson>;
}
export class VisibilityConflictError extends Error {}
export class VisibilityPersonNotFoundError extends Error {}
export class ProtectedSystemOwnerError extends Error {}
