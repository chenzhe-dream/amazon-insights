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

import { imageRemarkFailureReason } from '../../app/lib/image-remark-outcome-presentation';
import { ImageRemarkOutcomeSchema } from '../../shared/agent-contracts';
test('frozen image diagnostic strips injected secrets and renders distinct safe reasons',()=>{
  const outcome=ImageRemarkOutcomeSchema.parse({status:'connector-failed',diagnostic:{stage:'http-response',httpStatus:429,errorClass:'http',apiKey:'secret',url:'secret'}});
  assert.equal(JSON.stringify(outcome).includes('secret'),false);
  assert.match(imageRemarkFailureReason(outcome),/429/);
  assert.match(imageRemarkFailureReason({status:'connector-failed'}),/历史原因未记录/);
  assert.match(imageRemarkFailureReason({status:'timeout'}),/120/);
});
