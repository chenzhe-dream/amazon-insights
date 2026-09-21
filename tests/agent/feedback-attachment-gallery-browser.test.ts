import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import sharp from 'sharp';

test('feedback thumbnails, retry and modal work on desktop and mobile without opening another tab', {timeout:60000},async t=>{
 const cache=mkdtempSync(join(tmpdir(),'feedback-gallery-vite-'));
 const server=await createServer({configFile:false,cacheDir:cache,plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});
 await server.listen();
 const browser=await chromium.launch({headless:true});
 t.after(async()=>{await browser.close();await server.close();rmSync(cache,{recursive:true,force:true});});
 const origin=new URL(server.resolvedUrls!.local[0]).origin;
 const png=await sharp({create:{width:1600,height:1200,channels:3,background:'#edf2f7'}}).png().toBuffer();
 for(const mode of ['mine','admin']){
  const page=await browser.newPage({viewport:{width:1280,height:800}});page.setDefaultTimeout(10000);
  const requests:string[]=[];const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();
   if(req.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<html><body style="padding:20px"><div style="max-width:480px" id="root"></div><script type="module">
    import React from 'react';import {createRoot} from 'react-dom/client';import {FeedbackAttachmentGallery} from '/app/help-feedback/feedback-attachment-gallery.tsx';import '/app/globals.css';
    window.parentEsc=0;window.addEventListener('keydown',event=>{if(event.key==='Escape')window.parentEsc++});
    const attachments=['one','two'].map(id=>({id,feedbackId:'feedback',fileName:id+'.png',mediaType:'image/png',byteSize:2048,sha256:'a'.repeat(64),createdAt:'2026-09-15T00:00:00.000Z'}));
    createRoot(document.getElementById('root')).render(React.createElement(FeedbackAttachmentGallery,{attachments,attachmentPrefix:'/v1/feedback/'+new URL(location.href).searchParams.get('mode')+'/feedback'}));
   </script></body></html>`)});
   if(url.pathname.includes('/attachments/')){
    requests.push(url.pathname+url.search);assert.equal(req.method(),'GET');
    if(url.pathname.endsWith('/two')&&!url.search)return route.fulfill({status:503});
    return route.fulfill({contentType:'image/png',body:png});
   }
   return route.continue();
  });
  await page.goto(origin+'/?mode='+mode);
  await page.waitForFunction(()=>{const img=document.querySelector('.feedback-attachments img');return img instanceof HTMLImageElement&&img.complete&&img.naturalWidth===1600;});
  await page.getByRole('button',{name:'重试加载 two.png'}).click();
  await page.waitForFunction(()=>[...document.querySelectorAll('.feedback-attachments img')].length===2&&[...document.querySelectorAll('.feedback-attachments img')].every(img=>img instanceof HTMLImageElement&&img.naturalWidth===1600));
  assert.ok(requests.some(path=>path.endsWith('/two?previewRetry=1')));
  const thumb=page.getByRole('button',{name:'放大查看 one.png'});await thumb.click();
  const dialog=page.getByRole('dialog',{name:'图片预览：one.png'});await dialog.waitFor();
  assert.equal(page.context().pages().length,1);
  await page.getByRole('button',{name:'原始大小'}).click();
  await page.waitForFunction(()=>document.querySelector('.feedback-image-preview-body img')?.getBoundingClientRect().width===1600);
  assert.ok(await page.locator('.feedback-image-preview-body').evaluate(el=>el.scrollWidth>el.clientWidth&&el.scrollHeight>el.clientHeight));
  await page.getByRole('button',{name:'缩小图片'}).click();
  await page.waitForFunction(()=>document.querySelector('.feedback-image-preview-body img')?.getBoundingClientRect().width===1200);
  await page.getByRole('button',{name:'放大图片'}).click();
  await page.waitForFunction(()=>document.querySelector('.feedback-image-preview-body img')?.getBoundingClientRect().width===1600);
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>(window as any).parentEsc),0);
  assert.equal(await thumb.evaluate(el=>el===document.activeElement),true);
  await page.setViewportSize({width:390,height:844});await thumb.click();await dialog.waitFor();
  assert.ok(await dialog.evaluate(el=>el.getBoundingClientRect().width<=innerWidth));
  await page.waitForFunction(()=>{const el=document.querySelector('.feedback-image-preview-body');return el&&el.scrollWidth<=el.clientWidth&&el.scrollHeight<=el.clientHeight;});
  await page.getByRole('button',{name:'放大图片'}).click();
  assert.ok(await page.locator('.feedback-image-preview-body').evaluate(el=>el.scrollWidth>el.clientWidth));
  await page.getByRole('button',{name:'适应窗口'}).click();
  await page.waitForFunction(()=>{const el=document.querySelector('.feedback-image-preview-body');return el&&el.scrollWidth<=el.clientWidth&&el.scrollHeight<=el.clientHeight;});
  await page.getByRole('button',{name:'关闭图片预览'}).click();await dialog.waitFor({state:'hidden'});
  await thumb.click();await dialog.waitFor();await page.mouse.click(3,3);await dialog.waitFor({state:'hidden'});
  assert.deepEqual(errors,[]);assert.ok(requests.every(path=>path.startsWith(`/api/agent/v1/feedback/${mode}/`)));
  await page.close();
 }
});
