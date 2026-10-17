import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Exercise the shipped controller in a real browser without mounting another task's held scenes/routes.
const source = ts.transpileModule(readFileSync('src/lib/api/sync.ts','utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/^export /gm,'');
test('real browser revision polling honors visibility, skew, outage and focus recovery', async ({ page }) => {
  // A route that mounts no camp, reads and polls nothing of its own (the site root is the live camp since Task 13.5).
  await page.goto('/replay/'); await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.addScriptTag({ content: `${source}\nwindow.createTestSync = createSync;` });
  await page.evaluate(() => {
    const scope = window as unknown as { createTestSync: Function; sync: {start():Promise<void>}; states: unknown[]; revisionReads:number; worldReads:number; revision:string; down:boolean; hidden:boolean };
    scope.states=[]; scope.revisionReads=0;scope.worldReads=0;scope.revision='1';scope.down=false;scope.hidden=false;
    Object.defineProperty(document,'visibilityState',{get:()=>scope.hidden?'hidden':'visible',configurable:true});
    const clock=()=>({revision:scope.revision,serverNowMs:Date.now()-86_400_000,slotIndex:1});
    scope.sync=scope.createTestSync({world:async()=>{scope.worldReads++;return {...clock(),actors:[]};},revision:async()=>{
      scope.revisionReads++;if(scope.down)throw Error('outage');return clock();}},(state:unknown)=>scope.states.push(state));
    return scope.sync.start();
  });
  await page.clock.runFor(90_000);
  // One timed revision sample before the first world load, then three polls.
  expect(await page.evaluate(() => {const s=window as any;return [s.worldReads,s.revisionReads,s.states.at(-1).offsetMs];})).toEqual([1,4,-86_400_000]);
  await page.evaluate(() => { const s=window as any;s.hidden=true;document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.runFor(60_000);
  expect(await page.evaluate(() => (window as any).revisionReads)).toBe(4);
  await page.evaluate(() => {const s=window as any;s.hidden=false;s.down=true;window.dispatchEvent(new Event('focus'));});
  await expect.poll(()=>page.evaluate(()=>(window as any).states.at(-1).error)).toBe('unavailable');
  expect(await page.evaluate(()=>(window as any).states.at(-1).world.revision)).toBe('1');
  await page.evaluate(() => {const s=window as any;s.down=false;s.revision='2';window.dispatchEvent(new Event('focus'));});
  await expect.poll(()=>page.evaluate(()=>(window as any).states.at(-1).world.revision)).toBe('2');
  expect(await page.evaluate(()=>(window as any).worldReads)).toBe(2);
});
