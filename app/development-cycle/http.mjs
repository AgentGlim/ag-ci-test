import fs from 'node:fs';
const page = new URL('./web.html',import.meta.url), script = new URL('./web.js',import.meta.url), style = new URL('./web.css',import.meta.url);
export function cycleRoutes(service) {
  return async (req,res,route=req.url.split('?')[0]) => {
    if (!['/development-cycles','/development-cycles.js','/development-cycles.css'].includes(route) && !route.startsWith('/api/development-cycles')) return false;
    const reply=(status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
    try {
      if (req.method==='GET' && route.startsWith('/development-cycles')) {
        const asset=route.endsWith('.js')?script:route.endsWith('.css')?style:page;
        res.writeHead(200,{'content-type':asset===script?'text/javascript':asset===style?'text/css':'text/html; charset=utf-8','cache-control':'no-store'});res.end(fs.readFileSync(asset));return true;
      }
      if (req.method==='GET' && route==='/api/development-cycles') {reply(200,service.view());return true;}
      if (req.method!=='POST') {reply(405,{error:'method not allowed'});return true;}
      if (req.headers.origin!==`http://${req.headers.host}` || !/^application\/json(?:;|$)/.test(req.headers['content-type']||'')) {reply(403,{error:'same-origin JSON required'});return true;}
      let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>16384){reply(413,{error:'payload too large'});return true;}}
      let b;try{b=JSON.parse(body);}catch{reply(400,{error:'invalid JSON'});return true;}
      if (!b || typeof b!=='object' || Array.isArray(b)) {reply(422,{error:'object required'});return true;}
      if (route==='/api/development-cycles/preview') reply(200,service.preview(b));
      else if (route==='/api/development-cycles/settings') reply(202,service.store.request(b));
      // Application is the selected consumer's explicit operation. No generic browser approval/dispatch endpoint.
      else reply(404,{error:'unknown cycle operation'});
    } catch(e) { reply(/conflict|busy/.test(e.message)?409:422,{error:e.message}); }
    return true;
  };
}
