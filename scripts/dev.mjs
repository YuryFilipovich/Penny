import { spawn } from 'node:child_process';
const children = [
  spawn(process.execPath,['server/index.ts'],{stdio:'inherit'}),
  spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1',...process.argv.slice(2)],{stdio:'inherit'})
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const child of children) {
  child.on('error',error=>{console.error(error.message);stop(1);});
  child.on('exit',code=>stop(code || 0));
}
process.once('SIGINT',()=>stop());process.once('SIGTERM',()=>stop());
