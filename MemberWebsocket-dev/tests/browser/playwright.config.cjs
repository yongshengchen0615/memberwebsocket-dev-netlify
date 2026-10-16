const {defineConfig}=require('playwright/test');
module.exports=defineConfig({
  testDir:__dirname,testMatch:'*.spec.cjs',timeout:20000,workers:1,fullyParallel:false,
  reporter:[['list'],['junit',{outputFile:'browser-results.xml'}]],
  use:{permissions:['clipboard-read','clipboard-write'],serviceWorkers:'block',browserName:'chromium',headless:true,trace:'retain-on-failure',screenshot:'only-on-failure',
    launchOptions:{args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']}},
});
