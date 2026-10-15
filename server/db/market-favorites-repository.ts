import type {MarketFavorite,MarketFavoriteCreate,MarketFavoriteListQuery,MarketFavoriteListResponse} from '../../shared/market-favorites-contracts';

export interface MarketFavoriteActor {organizationId:string;userId:string;role:'admin'|'member'}
export interface MarketFavoritesRepository {
 readonly projects?: import('./postgres/market-project-favorites-store').PostgresMarketProjectFavoritesStore;
 list(actor:MarketFavoriteActor,query:MarketFavoriteListQuery):Promise<MarketFavoriteListResponse>;
 create(actor:MarketFavoriteActor,input:MarketFavoriteCreate):Promise<MarketFavorite>;
 delete(actor:MarketFavoriteActor,favoriteId:string):Promise<void>;
}
export class MarketFavoriteConflictError extends Error {}
export class MarketFavoriteNotFoundError extends Error {}
export class MarketFavoriteForbiddenError extends Error {}
