import {PostgresMarketProjectFavoritesStore} from './market-project-favorites-store';
import {isDeepStrictEqual} from 'node:util';
import {MarketFavoriteCreateSchema,MarketFavoriteListQuerySchema,MarketFavoriteListResponseSchema,MarketFavoriteSchema,type MarketFavoriteCreate,type MarketFavoriteListQuery} from '../../../shared/market-favorites-contracts';
import {MarketFavoriteConflictError,MarketFavoriteForbiddenError,MarketFavoriteNotFoundError,type MarketFavoriteActor,type MarketFavoritesRepository} from '../market-favorites-repository';
import {PostgresQueryContext} from './query-context';

function favorite(row:Record<string,unknown>,actor:MarketFavoriteActor,isOwner:boolean){
 return MarketFavoriteSchema.parse({id:row.id,title:row.title,module:row.module,query:row.query_json,...(row.keyword_input_json==null?{}:{keywordInput:row.keyword_input_json}),createdBy:row.created_by,creatorName:row.creator_name,createdAt:row.created_at instanceof Date?row.created_at.toISOString():row.created_at,canDelete:row.created_by===actor.userId||actor.role==='admin'||isOwner});
}

export class PostgresMarketFavoritesStore implements MarketFavoritesRepository {
 readonly projects:PostgresMarketProjectFavoritesStore;
 constructor(private readonly queries:PostgresQueryContext){this.projects=new PostgresMarketProjectFavoritesStore(queries)}

 private async isOwner(actor:MarketFavoriteActor){
  const result=await this.queries.query('SELECT 1 FROM system_owners WHERE organization_id=$1 AND user_id=$2',[actor.organizationId,actor.userId]);
  return result.rows.length>0;
 }

 async list(actor:MarketFavoriteActor,input:MarketFavoriteListQuery){
  const query=MarketFavoriteListQuerySchema.parse(input),owner=await this.isOwner(actor);
  const result=await this.queries.query(`WITH matches AS MATERIALIZED (
   SELECT f.*,u.display_name creator_name FROM market_favorites f JOIN users u ON u.id=f.created_by AND u.organization_id=f.organization_id
   WHERE f.organization_id=$1 AND ($2='' OR strpos(lower(f.title),lower($2))>0) AND ($3::text IS NULL OR f.module=$3)
  ), meta AS (SELECT COUNT(*)::int total,LEAST($4::int,GREATEST(1,CEIL(COUNT(*)::numeric/10)::int)) page FROM matches),
  selected AS (SELECT * FROM matches ORDER BY created_at DESC,id DESC LIMIT 10 OFFSET (SELECT (page-1)*10 FROM meta))
  SELECT meta.*,selected.* FROM meta LEFT JOIN selected ON true ORDER BY selected.created_at DESC,selected.id DESC`,[actor.organizationId,query.q,query.module??null,query.page]);
  return MarketFavoriteListResponseSchema.parse({items:result.rows.filter(row=>row.id!=null).map(row=>favorite(row,actor,owner)),total:result.rows[0].total,page:result.rows[0].page,pageSize:10});
 }

 async create(actor:MarketFavoriteActor,value:MarketFavoriteCreate){
  const input=MarketFavoriteCreateSchema.parse(value);
  return this.queries.transaction(async client=>{
   // ON CONFLICT serializes concurrent retries without ever overwriting another author's row.
   await client.query(`INSERT INTO market_favorites(id,organization_id,created_by,title,module,query_json,keyword_input_json)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) ON CONFLICT(id) DO NOTHING`,[input.id,actor.organizationId,actor.userId,input.title,input.module,JSON.stringify(input.query),input.keywordInput?JSON.stringify(input.keywordInput):null]);
   const result=await client.query(`SELECT f.*,u.display_name creator_name FROM market_favorites f JOIN users u ON u.id=f.created_by AND u.organization_id=f.organization_id
    WHERE f.id=$1 AND f.organization_id=$2`,[input.id,actor.organizationId]);
   const row=result.rows[0];
   if(!row||row.created_by!==actor.userId||!isDeepStrictEqual({title:row.title,module:row.module,query:row.query_json,keywordInput:row.keyword_input_json??undefined},{title:input.title,module:input.module,query:input.query,keywordInput:input.keywordInput}))throw new MarketFavoriteConflictError();
   return favorite(row,actor,false);
  });
 }

 async delete(actor:MarketFavoriteActor,favoriteId:string){
  await this.queries.transaction(async client=>{
   const result=await client.query('SELECT created_by FROM market_favorites WHERE id=$1 AND organization_id=$2 FOR UPDATE',[favoriteId,actor.organizationId]);
   if(!result.rows.length)throw new MarketFavoriteNotFoundError();
   if(result.rows[0].created_by!==actor.userId&&actor.role!=='admin'&&!await this.isOwner(actor))throw new MarketFavoriteForbiddenError();
   await client.query('DELETE FROM market_favorites WHERE id=$1 AND organization_id=$2',[favoriteId,actor.organizationId]);
  });
 }
}
