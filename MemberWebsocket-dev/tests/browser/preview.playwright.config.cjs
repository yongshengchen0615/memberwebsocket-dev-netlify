'use strict';
const baseline = require('./playwright.config.cjs');
module.exports = {
  ...baseline,
  testMatch: 'preview-smoke.test.cjs',
  reporter: [
    ['list'],
    ['junit', { outputFile: 'preview-browser-results.xml' }],
    ['html', { outputFolder: 'preview-browser-report', open: 'never' }],
  ],
};
