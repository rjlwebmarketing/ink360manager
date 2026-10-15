/* ============================================================
   Minimal Claude (Anthropic Messages API) client — no SDK, Node's fetch.
   The API key lives only in the Railway variable ANTHROPIC_API_KEY; it is
   never sent to the browser or stored in the repo.
   ============================================================ */
'use strict';

const API_VERSION = '2023-06-01';

async function callClaude({ apiKey, baseUrl, model, system, messages, tools, toolChoice, maxTokens, timeoutMs }){
  const body = { model, max_tokens: maxTokens || 4000, system, messages };
  if(tools) body.tools = tools;
  if(toolChoice) body.tool_choice = toolChoice;
  let lastErr;
  for(let attempt = 0; attempt < 3; attempt++){
    if(attempt) await new Promise(r => setTimeout(r, attempt * 4000));
    let res;
    try{
      res = await fetch(String(baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '') + '/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': API_VERSION },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs || 90000)
      });
    }catch(e){ lastErr = new Error('Couldn’t reach the Claude API: ' + (e.name === 'TimeoutError' ? 'timed out' : e.message)); continue; }
    const text = await res.text();
    let json = null; try{ json = JSON.parse(text); }catch(e){}
    if(res.ok && json) return json;
    const msg = (json && json.error && json.error.message) || text.slice(0, 200) || ('HTTP ' + res.status);
    lastErr = Object.assign(new Error(`Claude API ${res.status}: ${msg}`), { status: res.status });
    if(![408, 409, 429, 500, 502, 503, 504, 529].includes(res.status)) break;   // 400/401/403/404: retrying won't help
  }
  throw lastErr;
}

/* The input of the first tool call named `name`, or null. */
function toolInput(resp, name){
  const block = (resp && resp.content || []).find(b => b.type === 'tool_use' && b.name === name);
  return block ? block.input : null;
}

module.exports = { callClaude, toolInput };
