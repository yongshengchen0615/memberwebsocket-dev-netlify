import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const version=JSON.parse(readFileSync(new URL('../MemberWebsocket-dev/tests/browser/package.json',import.meta.url),'utf8')).devDependencies.playwright;
const workflows=[
 ['test-memberwebsocket-dev.yml','browser-e2e'],
 ['test-memberwebsocket-ticket-policy.yml','unit-and-regression'],
 ['publish-platform-preview.yml','publish'],
];

for(const [file,job] of workflows)test(`${file}: browser runtime matches the locked Playwright package without APT bootstrap`,()=>{
 const source=readFileSync(new URL('../.github/workflows/'+file,import.meta.url),'utf8');
 const start=source.indexOf(`  ${job}:`);
 assert.ok(start>=0);
 const section=source.slice(start).split(/\n  [\w-]+:/)[0];
 const image=section.match(/mcr\.microsoft\.com\/playwright:[^\s]+/)?.[0];
 assert.ok(image,'Browser jobs need the official preinstalled runtime instead of downloading system packages');
 assert.ok(image.startsWith(`mcr.microsoft.com/playwright:v${version}-noble@sha256:`),'The image must match the installed SDK, otherwise its browser executable cannot be found');
 assert.match(image,/@sha256:[a-f0-9]{64}$/,'Pin the tested browser and system-library bytes');
 assert.doesNotMatch(section,/playwright install --with-deps|apt-get/,'Runtime tests must not depend on the failed Ubuntu mirror bootstrap');
});
