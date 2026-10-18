export function browserPairingPage() {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pair with Vivary</title>
<style>body{font:16px system-ui;background:#10151a;color:#e6edf3;margin:0;padding:24px}main{max-width:420px;margin:10vh auto}h1{font-size:28px}p{line-height:1.6;color:#abb8c3}label{display:block;margin:24px 0 8px}input,button{box-sizing:border-box;width:100%;min-height:44px;padding:12px;border-radius:8px;border:1px solid #465363;background:#1c2630;color:inherit;font:inherit}button{margin-top:16px;background:#c2edd7;color:#15271e;font-weight:600;cursor:pointer}button:disabled{opacity:.5}output{display:block;font-size:36px;letter-spacing:6px;margin:24px 0}#status{white-space:pre-wrap}a{color:#c2edd7}</style></head>
<body><main><h1>Connect to your Vivary host</h1><p>This browser uses projects, files and tools on the selected host. Keep that computer running.</p>
<form id="pair" hidden><label for="label">Name this browser</label><input id="label" maxlength="80" required autocomplete="off" placeholder="My phone"><button>Request pairing</button></form>
<output id="code" aria-label="Pairing code"></output><p id="status" role="status">Checking your browser connection…</p><button id="retry" hidden>Retry connection</button><button id="complete" hidden>Finish pairing and open Vivary</button>
<script>
const status=document.getElementById('status'), complete=document.getElementById('complete'), form=document.getElementById('pair'), retry=document.getElementById('retry');
function rootDestination(){
  const navigation=new URLSearchParams();
  if(location.pathname==='/'){
    const keys=['project','run','draft','runtime','history','thread','panel','path','line'];
    for(const [key,value] of new URLSearchParams(location.search)){
      if(keys.includes(key))navigation.append(key,value);
    }
  }
  const query=navigation.toString();
  return query?'/?'+query:'/';
}
async function checkConnection(){
  retry.hidden=true;form.hidden=true;status.textContent='Checking your browser connection…';
  try{
    const response=await fetch('/_vivary/browser/status',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(10000)});
    if(response.ok){location.replace(rootDestination());}
    else if(response.status===401){
      form.hidden=false;
      status.textContent='To pair, request a code and approve the matching code in the desktop app on your laptop. Then finish pairing here.';
    }else{throw new Error('Connection unavailable');}
  }catch{
    status.textContent='Cannot reach your Vivary host. Keep it running, then retry the connection. Your saved pairing has not been changed.';
    retry.hidden=false;
  }
}
retry.onclick=()=>void checkConnection();
void checkConnection();
async function post(path,body){const response=await fetch('/_vivary/browser/'+path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw new Error(result.error||'Could not connect.');return result;}
form.onsubmit=async event=>{event.preventDefault();form.querySelector('button').disabled=true;try{const result=await post('pair',{label:document.getElementById('label').value});document.getElementById('code').textContent=result.code;status.textContent='On '+result.label+', open Settings > Remote access and approve this matching code. It expires in five minutes. After approval on your laptop, select Finish pairing and open Vivary here.';complete.hidden=false;}catch(error){status.textContent=error.message;}finally{form.querySelector('button').disabled=false;}};
complete.onclick=async()=>{complete.disabled=true;try{const result=await post('complete',{});if(result.pending){status.textContent='Still waiting for approval on the desktop.';}else{location.replace(rootDestination());}}catch(error){status.textContent=error.message;complete.hidden=true;}finally{complete.disabled=false;}};
</script></main></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' } });
}
