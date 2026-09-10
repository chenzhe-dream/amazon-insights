// Fixed-job read-only inspection. Prints counts only; never raw reviews or credentials.
import fs from "node:fs";
import pg from "pg";
const env = Object.fromEntries(fs.readFileSync("C:/Users/EDY/Amazon-Product-Opportunity-Insights.runtime/formal-stack.env", "utf8").split(/\r?\n/).filter(line => /^[A-Z_]+=/.test(line)).map(line => { const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1).replace(/^['"]|['"]$/g, "")]; }));
const client = new pg.Client({ connectionString: env.AGENT_DATABASE_URL, connectionTimeoutMillis: 5000, options: "-c default_transaction_read_only=on -c statement_timeout=10000" });
try {
  await client.connect(); await client.query("BEGIN READ ONLY");
  const result = await client.query("SELECT j.job_id,j.job_version,o.output_version,o.updated_at,o.content_hash,o.data_json,o.gap_json FROM sync_jobs j JOIN sync_job_stage_outputs o ON o.job_id=j.job_id WHERE j.job_id=$1 AND o.stage_id='reviews'", ["2f37a6e3-5ef0-4561-a6dd-359096876b72"]);
  for (const { data_json, ...row } of result.rows) console.log(JSON.stringify({ ...row, records: Object.entries(data_json?.analysisByAsin ?? {}).map(([asin, record]) => ({ asin, status: record.status, family: record.family, sampledReviews: record.sampledReviews, mentionTopics: record.mentionTopics, fetchedAt: record.fetchedAt, dimensions: record.blocks?.map(block => ({ key: block.key, themes: block.rows?.length })) })) }));
  console.log(JSON.stringify((await client.query("SHOW transaction_read_only")).rows[0]));
  await client.query("ROLLBACK");
} catch (error) { console.error(JSON.stringify({ error: error.name, code: error.code })); process.exitCode = 1; }
finally { await client.end(); }
