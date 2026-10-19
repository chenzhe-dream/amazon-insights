import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { generatedAppDataPath } from "../../scripts/lib/generated-app-data-path.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

test("UK project cache starts empty and never seeds the shared US cache", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-generated-"));
  const codeRoot = path.join(fixture, "code");
  const dataRoot = path.join(fixture, "data");
  fs.mkdirSync(path.join(codeRoot, "app"), { recursive: true });
  fs.writeFileSync(path.join(codeRoot, "app", "competitor-data.ts"), "US seed");
  const env = { AGENT_FORMAL_WORKTREE_ROOT: codeRoot, AGENT_DATA_ROOT: dataRoot,
    AGENT_RUNTIME_ROOT: path.join(fixture, "runtime"), AGENT_SYNC_MARKETPLACE: "UK",
    AGENT_EXECUTION_ORGANIZATION_ID: "org-1", AGENT_SYNC_PROJECT_ID: "project-uk" };
  try {
    const target = generatedAppDataPath(codeRoot, "competitor-data.ts", env);
    assert.equal(fs.readFileSync(target, "utf8"), "export const refreshedCatalog = [];\n", "US seed must not be copied into a UK collection");
    fs.writeFileSync(target, "UK result");
    assert.equal(generatedAppDataPath(codeRoot, "competitor-data.ts", env), target);
    assert.notEqual(generatedAppDataPath(codeRoot, "competitor-data.ts", { ...env, AGENT_SYNC_PROJECT_ID: "other" }), target);
    assert.notEqual(generatedAppDataPath(codeRoot, "competitor-data.ts", { ...env, AGENT_EXECUTION_ORGANIZATION_ID: "other" }), target);
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

test("formal generated data is copied once outside the code root", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "generated-app-data-"));
  const codeRoot = path.join(fixture, "code");
  const dataRoot = path.join(fixture, "data");
  const source = path.join(codeRoot, "app", "listing-image-remarks.ts");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, "original", "utf8");
  const env = { AGENT_FORMAL_WORKTREE_ROOT: codeRoot, AGENT_DATA_ROOT: dataRoot,
    AGENT_RUNTIME_ROOT: path.join(fixture, "runtime") };
  try {
    const target = generatedAppDataPath(codeRoot, "listing-image-remarks.ts", env);
    assert.equal(target, path.join(dataRoot, "generated-app-data", "listing-image-remarks.ts"));
    assert.equal(fs.readFileSync(target, "utf8"), "original");
    fs.writeFileSync(target, "new result", "utf8");
    assert.equal(generatedAppDataPath(codeRoot, "listing-image-remarks.ts", env), target);
    assert.equal(fs.readFileSync(target, "utf8"), "new result");
    assert.equal(fs.readFileSync(source, "utf8"), "original");
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("formal generated data refuses a data root inside the code root", () => {
  const codeRoot = path.join(os.tmpdir(), "generated-app-data-code");
  assert.throws(() => generatedAppDataPath(codeRoot, "competitor-data.ts", {
    AGENT_FORMAL_WORKTREE_ROOT: codeRoot,
    AGENT_DATA_ROOT: path.join(codeRoot, "data"),
    AGENT_RUNTIME_ROOT: path.join(os.tmpdir(), "generated-app-data-runtime"),
  }), /outside codeRoot/);
});

test("formal image sync updates the external copy and leaves its code module untouched", () => {
  const fixture = fs.mkdtempSync(path.join(repositoryRoot, ".tmp-generated-app-data-"));
  const dataRoot = `${fixture}-data`;
  const asin = "B0IMAGE001";
  const imageUrl = "https://example.test/product.jpg";
  const app = path.join(fixture, "app");
  const scripts = path.join(fixture, "scripts");
  fs.mkdirSync(app);
  fs.mkdirSync(scripts);
  fs.writeFileSync(path.join(app, "competitor-data.ts"), "export const refreshedCatalog = [];\n");
  fs.cpSync(path.join(repositoryRoot, "scripts", "lib"), path.join(scripts, "lib"), { recursive: true });
  fs.copyFileSync(path.join(repositoryRoot, "scripts", "build-listing-image-remarks.mjs"),
    path.join(scripts, "build-listing-image-remarks.mjs"));
  fs.writeFileSync(path.join(app, "sorftime-listing-content-data.ts"),
    `export const sorftimeListingContentData = ${JSON.stringify({ [asin]: { status: "ready", galleryImages: [imageUrl] } })};\n`);
  const source = path.join(app, "listing-image-remarks.ts");
  const original = `export const listingImageRemarksMeta = ${JSON.stringify({ imageUrlsByAsin: { [asin]: [imageUrl] } })};\n`
    + `export const listingImageRemarks = ${JSON.stringify({ [asin]: [{ remark: "已核实备注", imageUrl, image_types: ["产品展示"], confidence: "high" }] })};\n`;
  fs.writeFileSync(source, original);
  try {
    const result = spawnSync(process.execPath, [path.join(scripts, "build-listing-image-remarks.mjs")], {
      cwd: fixture, encoding: "utf8", env: { ...process.env,
        AGENT_FORMAL_WORKTREE_ROOT: fixture,
        AGENT_DATA_ROOT: dataRoot,
        AGENT_RUNTIME_ROOT: path.join(dataRoot, "runtime"),
        REMARK_ASINS: asin,
        OPENAI_API_KEY: "",
        NODE_OPTIONS: "",
      },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.readFileSync(source, "utf8"), original);
    const external = path.join(dataRoot, "generated-app-data", "listing-image-remarks.ts");
    assert.match(fs.readFileSync(external, "utf8"), /"imageStatusByAsin"/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('scoped readiness reads the UK catalog ASIN list, not the process-wide US catalog', () => {
 const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'uk-catalog-status-'));
 const env={...process.env,AGENT_FORMAL_WORKTREE_ROOT:repositoryRoot,AGENT_DATA_ROOT:fixture,AGENT_RUNTIME_ROOT:path.join(fixture,'runtime'),AGENT_SYNC_MARKETPLACE:'US'};
 try {
 const shared=generatedAppDataPath(repositoryRoot,'competitor-data.ts',env);
 fs.writeFileSync(shared,'export const refreshedCatalog = [{"asin":"B0US000001"}];');
 const scoped={...env,AGENT_SYNC_MARKETPLACE:'UK',AGENT_EXECUTION_ORGANIZATION_ID:'org-1',AGENT_SYNC_PROJECT_ID:'uk-1'};
 fs.writeFileSync(generatedAppDataPath(repositoryRoot,'competitor-data.ts',scoped),'export const refreshedCatalog = [{"asin":"B0UK000001"}];');
 const result=spawnSync(process.execPath,['--input-type=module','-e',`import {getScopedAsinDataStatus} from './scripts/lib/asin-data-status.mjs'; console.log(JSON.stringify(getScopedAsinDataStatus(['B0US000001','B0UK000001'],{organizationId:'org-1',projectId:'uk-1',marketplace:'UK'})));`],{cwd:repositoryRoot,env,encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 assert.deepEqual(JSON.parse(result.stdout).map(row=>[row.asin,row.inCatalog]),[['B0US000001',false],['B0UK000001',true]]);
 }finally{fs.rmSync(fixture,{recursive:true,force:true});}
});
