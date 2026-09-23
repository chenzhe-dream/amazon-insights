import assert from "node:assert/strict";
import test from "node:test";
import { resolveRemarkForGalleryImage } from "../../app/lib/listing-image-remark-resolution";
test("a refreshed gallery maps legacy remarks by the previous URL, never the slot",()=>{
  const notes=[{remark:"A"},{remark:"B"}];
  assert.equal(resolveRemarkForGalleryImage("B",1,["A","B"],i=>notes[i]??null)?.remark,"B");
  assert.equal(resolveRemarkForGalleryImage("C",1,["A","B"],i=>notes[i]??null),null);
});
test("URL-bound remarks take priority after analysis and mismatched results stay hidden",()=>{
  const notes=[{remark:"B",imageUrl:"B"},{remark:"C",imageUrl:"C"}];
  assert.equal(resolveRemarkForGalleryImage("C",1,["A","B"],i=>notes[i]??null)?.remark,"C");
  assert.equal(resolveRemarkForGalleryImage("A",0,["A","B"],i=>notes[i]??null),null);
});
test("legacy unchanged galleries retain their notes; duplicate previous URLs are ambiguous",()=>{
  const read=()=>({remark:"A"});
  assert.equal(resolveRemarkForGalleryImage("A",0,undefined,read)?.remark,"A");
  assert.equal(resolveRemarkForGalleryImage("A",0,["A","A"],read),null);
});

test("an empty previous gallery keeps unbound remarks on the current image slots",()=>{
  const notes=[{remark:"main",imageUrl:"A"},{remark:"secondary"}];
  assert.equal(resolveRemarkForGalleryImage("B",1,[],index=>notes[index]??null)?.remark,"secondary");
  assert.equal(resolveRemarkForGalleryImage("C",1,[],index=>notes[index]??null)?.remark,"secondary");
  assert.equal(resolveRemarkForGalleryImage("C",0,[],index=>notes[index]??null),null);
});
