'use strict';
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const {handler}=require('../server/router.cjs');
const root=path.resolve(__dirname,'../dist');
const config=require('../vercel.json');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png','.mp3':'audio/mpeg'};
http.createServer(async(req,res)=>{
  if(req.url.split('?')[0].startsWith('/api/'))return handler(req,res);
  for(const h of config.headers[0].headers)res.setHeader(h.key,h.value);
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);return res.end();}
  try{
    const url=new URL(req.url,'http://localhost');
    const file=path.resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
    if(!file.startsWith(root+path.sep))throw Error();
    const stat=await fs.stat(file);if(!stat.isFile())throw Error();
    const bytes=await fs.readFile(file);
    res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Content-Length':bytes.length,'Cache-Control':'no-cache'});
    res.end(req.method==='HEAD'?undefined:bytes);
  }catch{res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});res.end('見つかりません。');}
}).listen(Number(process.env.PORT||3200),'127.0.0.1',()=>console.log('Target HTTP server ready.'));
