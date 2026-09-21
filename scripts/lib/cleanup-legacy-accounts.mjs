// Exact historical seed accounts; never select all local or all disabled users.
const emails=[
  ...Array.from({length:3},(_,i)=>`ops-admin-${i+1}`),
  ...Array.from({length:6},(_,i)=>`ops-member-${i+1}`),
  'test-admin',...Array.from({length:4},(_,i)=>`test-member-${i+1}`),
].map(name=>name+'@amazon-insights.local');

/** @param {import('pg').Pool} pool
 * @param {{organizationId:string,apply:boolean}} options
 */
export async function cleanupLegacyAccounts(pool,{organizationId,apply}){
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('legacy-account-cleanup'))");
    const selected=await client.query(`SELECT u.id,u.email,u.display_name,
      EXISTS(SELECT 1 FROM auth_identities i WHERE i.user_id=u.id) AS bound
      FROM users u WHERE u.organization_id=$1 AND lower(u.email)=ANY($2::text[])
      AND u.archived_at IS NULL ORDER BY u.email FOR UPDATE OF u`,[organizationId,emails]);
    const references=await client.query(`SELECT c.conrelid::regclass::text AS relation,
      (SELECT string_agg(format('r.%I=u.%I',a.attname,b.attname),' AND ')
       FROM unnest(c.conkey,c.confkey) k(l,f)
       JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.l
       JOIN pg_attribute b ON b.attrelid=c.confrelid AND b.attnum=k.f) AS predicate
      FROM pg_constraint c WHERE c.contype='f' AND c.confrelid='users'::regclass`);
    const result=[];
    for(const user of selected.rows){
      if(user.bound){result.push({account:user.email,action:'skip-bound',references:[]});continue;}
      const linked=[];
      for(const reference of references.rows){
        // Identifiers and join predicates come from PostgreSQL's catalog, values stay bound.
        const check=await client.query(`SELECT EXISTS(SELECT 1 FROM ${reference.relation} r JOIN users u ON ${reference.predicate} WHERE u.id=$1) AS found`,[user.id]);
        if(check.rows[0].found)linked.push(reference.relation);
      }
      const action=linked.length?'archive':'delete';
      result.push({account:user.email,action,references:linked.sort()});
      if(!apply)continue;
      if(action==='delete')await client.query('DELETE FROM users WHERE id=$1',[user.id]);
      else{
        await client.query("UPDATE users SET status='disabled',archived_at=now(),updated_at=now() WHERE id=$1",[user.id]);
        await client.query('UPDATE sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1',[user.id]);
      }
    }
    await client.query(apply?'COMMIT':'ROLLBACK');
    return result;
  }catch(error){await client.query('ROLLBACK');throw error;}
  finally{client.release();}
}
