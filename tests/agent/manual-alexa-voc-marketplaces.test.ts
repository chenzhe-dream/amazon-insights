import assert from "node:assert/strict";
import test from "node:test";
import { ManualAlexaVocImportRequestSchema, ManualAlexaVocListQuerySchema, AlexaVocNormalizationStatusQuerySchema } from "../../shared/agent-contracts";
import { createAlexaVocImportSubmission } from "../../app/manual-alexa-voc-store";
import { discoverAlexaVocNormalizationStatuses, pollAlexaVocNormalizationOnce, readAlexaVocNormalizationStatuses } from "../../app/lib/alexa-voc-normalization-status-client";
import { createManualAlexaVocCipher } from "../../server/security/manual-alexa-voc-cipher";

const projectId = "10000000-0000-4000-8000-000000000010";
const runId = "10000000-0000-4000-8000-000000000011";
const asin = "B09Q8MJP3R";
test("DE scope rejection explains the issue and polling stops instead of retrying forever", async () => {
  const input = {projectId, runId, marketplace:"DE" as const, asins:[asin], asin, fingerprint:"a".repeat(64), request:async()=>Response.json({}, {status:403})};
  const discovered = await discoverAlexaVocNormalizationStatuses(input);
  assert.equal(discovered.phase,"recoverable-error");
  assert.match((discovered as {message:string}).message,/项目或站点/);
  assert.deepEqual(await pollAlexaVocNormalizationOnce(input),{phase:"failure",error:"authorization"});
});
for (const marketplace of ["US", "UK", "DE", "CA"] as const) {
  test(`${marketplace} manual VOC accepts explicit scoped import, list and status`, () => {
    assert.equal(ManualAlexaVocImportRequestSchema.safeParse({projectId, runId, asin, marketplace, text:"使用人群：家庭"}).success,true);
    assert.equal(ManualAlexaVocListQuerySchema.safeParse({projectId, marketplace, asins:[asin]}).success,true);
    assert.equal(AlexaVocNormalizationStatusQuerySchema.safeParse({projectId, runId, marketplace, asins:[asin]}).success,true);
  });
}
test("DE submission includes marketplace and status request preserves it", async () => {
  const input = {projectId, runId, asin, marketplace:"DE" as const, text:"使用人群：家庭"};
  const submission = createAlexaVocImportSubmission(input);
  assert.equal((submission.request as Record<string, unknown>).marketplace,"DE");
  let observed = "";
  await readAlexaVocNormalizationStatuses({...input, asins:[asin], request:async url => {observed=String(url);return Response.json({records:[]});}});
  assert.equal(new URL(observed,"http://candidate").searchParams.get("marketplace"),"DE");
});
test("DE report encryption binds its real marketplace and rejects cross-site decryption", () => {
  const cipher = createManualAlexaVocCipher({MANUAL_VOC_RAW_REPORT_KEYRING:JSON.stringify({activeKeyId:"test",keys:{test:Buffer.alloc(32, 23).toString("base64url")}})});
  const identity = {organizationId:projectId, marketplace:"DE", asin, revision:"1", normalizedSchemaVersion:"alexa-voc-record/v2", parserVersion:"deterministic-alexa-parser/v3"};
  const encrypted=cipher.encrypt({identity,plaintext:"德国站测试报告"});
  assert.equal(cipher.decrypt({identity,envelope:encrypted}),"德国站测试报告");
  assert.throws(()=>cipher.decrypt({identity:{...identity,marketplace:"US"},envelope:encrypted}));
});
