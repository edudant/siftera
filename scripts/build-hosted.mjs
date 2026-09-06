import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
function run(args) { const result = spawnSync('pnpm',args,{stdio:'inherit'}); if(result.status!==0) process.exit(result.status ?? 1); }
run(['--filter','@siftera/web','build']);
run(['exec','vite','build','--config','vite.hosted.config.ts']);
rmSync('dist/client',{recursive:true,force:true});
mkdirSync('dist/client',{recursive:true});
cpSync('apps/web/dist','dist/client',{recursive:true});
