import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

test('feedback images render immediately using the authenticated attachment endpoint', async()=>{
 const {FeedbackAttachmentGallery}=await import('../../app/help-feedback/feedback-attachment-gallery');
 const attachment={id:'image-1',feedbackId:'feedback-1',fileName:'screenshot.png',mediaType:'image/png' as const,byteSize:2048,sha256:'a'.repeat(64),createdAt:'2026-09-15T00:00:00.000Z'};
 for(const role of ['mine','admin']){
  const html=renderToStaticMarkup(createElement(FeedbackAttachmentGallery,{attachments:[attachment],attachmentPrefix:`/v1/feedback/${role}/feedback-1`}));
  assert.match(html,/<img /);
  assert.ok(html.includes(`/api/agent/v1/feedback/${role}/feedback-1/attachments/image-1`));
  assert.match(html,/screenshot.png/);assert.match(html,/2 KB/);
  assert.doesNotMatch(html,/target="_blank"/);
 }
});
