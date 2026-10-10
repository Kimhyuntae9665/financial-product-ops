import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
export const here=dirname(fileURLToPath(import.meta.url));
let local={};try{local=JSON.parse(readFileSync(resolve(here,'.runtime.json'),'utf8'));}catch{}
export const runtime=resolve(process.env.FINANCE_RUNTIME_DIR||local.runtimeDir||resolve(here,'../work/openclaw-runtime'));
