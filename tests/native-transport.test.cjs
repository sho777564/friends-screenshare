'use strict';
const test=require('node:test');
test('native UTF-8 transport, grant lifecycle and error recovery',{skip:process.platform!=='win32',timeout:20000},async()=>{const report=await require('./native-transport-checks.cjs').runChecks();if(!report.passed)throw new Error('Native transport failed');});
