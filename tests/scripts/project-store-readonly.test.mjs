import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readProjectReadonly } from "../../scripts/lib/project-store.mjs";

test("creation, legacy reads and category enrichment preserve project time; edits advance only modified time", async () => {
  const previous = process.env.AGENT_DATA_ROOT;
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "project-times-"));
  process.env.AGENT_DATA_ROOT = dataRoot;
  try {
    const store = await import(`../../scripts/lib/project-store.mjs?times=${Date.now()}`);
    const created = store.createProject({ name: "time-test", asins: ["B01M119PTN", "B00P8J6AQG", "B0FV2T2SP4"] });
    assert.equal(created.createdAt, created.updatedAt);
    const file = path.join(store.projectsDir, `${created.id}.json`);
    const start = "2026-01-01T00:00:00.000Z";
    fs.writeFileSync(file, JSON.stringify({ ...created, slug: null, createdAt: start, updatedAt: null }));
    const read = store.readProject(created.id);
    assert.equal(read.createdAt, start);
    assert.equal(read.updatedAt, start, "opening a legacy project must not mark it modified");
    store.updateProject(created.id, { majorCategory: "Home & Kitchen" }, { preserveUpdatedAt: true });
    assert.equal(store.readProject(created.id).updatedAt, start);
    const edited = store.updateProject(created.id, { name: "renamed" });
    assert.equal(edited.createdAt, start);
    assert.ok(Date.parse(edited.updatedAt) > Date.parse(start));
  } finally {
    if (previous === undefined) delete process.env.AGENT_DATA_ROOT; else process.env.AGENT_DATA_ROOT = previous;
    assert.equal(path.dirname(path.resolve(dataRoot)), path.resolve(os.tmpdir()));
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("UUID-only readonly project reads never create, enumerate, write, or resolve a slug", () => {
  const originals = {
    mkdirSync: fs.mkdirSync,
    readdirSync: fs.readdirSync,
    writeFileSync: fs.writeFileSync,
  };
  const calls = [];
  fs.mkdirSync = () => {
    calls.push("mkdir");
    throw new Error("readonly read attempted mkdir");
  };
  fs.readdirSync = () => {
    calls.push("readdir");
    throw new Error("readonly read attempted enumeration");
  };
  fs.writeFileSync = () => {
    calls.push("write");
    throw new Error("readonly read attempted write");
  };

  try {
    assert.equal(readProjectReadonly("not-a-uuid-slug"), null);
    assert.equal(readProjectReadonly("ffffffff-ffff-4fff-8fff-ffffffffffff"), null);
    assert.deepEqual(calls, []);
  } finally {
    fs.mkdirSync = originals.mkdirSync;
    fs.readdirSync = originals.readdirSync;
    fs.writeFileSync = originals.writeFileSync;
  }
});

test("project store resolves projects beneath AGENT_DATA_ROOT", async () => {
  const previous = process.env.AGENT_DATA_ROOT;
  const dataRoot = path.resolve(os.tmpdir(), `project-store-data-${process.pid}`);
  process.env.AGENT_DATA_ROOT = dataRoot;
  try {
    const projectStore = await import(`../../scripts/lib/project-store.mjs?shared-root=${Date.now()}`);
    assert.equal(projectStore.projectsDir, path.join(dataRoot, "projects"));
  } finally {
    if (previous === undefined) delete process.env.AGENT_DATA_ROOT;
    else process.env.AGENT_DATA_ROOT = previous;
  }
});

test('collection source binding survives create, reopen and explicit legacy update',async()=>{
  const previous=process.env.AGENT_DATA_ROOT;
  const dataRoot=fs.mkdtempSync(path.join(os.tmpdir(),'image-source-store-'));
  process.env.AGENT_DATA_ROOT=dataRoot;
  try{
    const store=await import(`../../scripts/lib/project-store.mjs?image-source=${Date.now()}`);
    const source='30000000-0000-4000-8000-000000000001';
    const input={name:'saved',kind:'keyword-compare',asins:['B01M119PTN','B00P8J6AQG','B0FV2T2SP4'],marketplace:'US'};
    const created=store.createProject({...input,sourceProjectId:source});
    assert.equal(store.readProjectReadonly(created.id).sourceProjectId,source);
    const old=store.createProject(input);
    assert.equal(store.readProjectReadonly(old.id).sourceProjectId,undefined);
    store.updateProject(old.id,{sourceProjectId:source});
    const reopened=await import(`../../scripts/lib/project-store.mjs?image-source-reopen=${Date.now()}`);
    assert.equal(reopened.readProjectReadonly(old.id).sourceProjectId,source);
  }finally{
    if(previous===undefined)delete process.env.AGENT_DATA_ROOT;else process.env.AGENT_DATA_ROOT=previous;
    assert.equal(path.dirname(path.resolve(dataRoot)),path.resolve(os.tmpdir()));
    fs.rmSync(dataRoot,{recursive:true,force:true});
  }
});
