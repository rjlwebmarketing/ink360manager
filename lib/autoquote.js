/* ============================================================
   Draft quotes: Claude reads a lead and the server turns what it found
   into quote lines, ready for Ken to check.
   - Runs automatically for each new website lead (when ANTHROPIC_API_KEY is set),
     and on demand from the app ("Draft with Claude", e.g. for an emailed request).
   - Claude only extracts facts (flavors, quantities, bottle, colors, repeat?).
     Prices are NOT decided here: the app prices every line from the 2026 matrix,
     adds the standard charges and checks the QuickBooks items, live.
   - Anything the lead didn't say gets a stated default (e.g. 1,000 bottles,
     1 pass, 750ml round) and is marked as an assumption, with a question for
     the customer, so a ballpark can still go out.
   - Only what's needed to read the request is sent to Claude: company, first
     name and the message/form answers — not the email, phone or address.
   ============================================================ */
'use strict';
const { callClaude, toolInput } = require('./claude');
const { bottleItems } = require('./qb-items');

const env = process.env;
const settings = () => ({
  apiKey: env.ANTHROPIC_API_KEY || '',
  model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
  baseUrl: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  auto: !/^(0|false|off|no)$/i.test(env.AUTO_QUOTE || '')
});
function status(){ const s = settings(); return { enabled: !!s.apiKey, auto: !!s.apiKey && s.auto, model: s.model }; }

const INDUSTRIES = ['spirits', 'wine', 'craft beer', 'health & beauty', 'perfume & oils', 'candles', 'food', 'other'];
const FIELDS = ['quantity', 'passes', 'bottle', 'repeat'];
const DEFAULTS = { qty: 1000, passes: 1, shape: 'round', taper: false, ml: 750 };
const STANDARD_QUESTIONS = {
  quantity: 'How many bottles of each flavor do you need?',
  passes: 'How many ink colors is the design, and is it printed on the front only, or also on the back or sides?',
  bottle: 'Which bottle are you using (brand/model and size)? A link or a photo works too.',
  repeat: 'Is this a design we’ve printed for you before? If so, the control number or a past order number helps.'
};

const TOOL = {
  name: 'record_quote_request',
  description: 'Record what this lead is asking ink360 to quote. Call exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      is_quote_request: { type: 'boolean', description: 'false for spam, job applications, vendors selling to ink360, or anything that is not a request for printing.' },
      summary: { type: 'string', description: 'One sentence for the owner: who wants what.' },
      industry: { type: 'string', enum: INDUSTRIES.concat(['unknown']) },
      items: {
        type: 'array',
        description: 'One item per flavor / label design. Same design on two bottle sizes = two items. If it is a quote request but no product details are given, return one item with nulls.',
        items: {
          type: 'object',
          properties: {
            flavor: { type: 'string', description: 'Flavor, product or design name as the customer calls it; "Product 1" if not named.' },
            quantity: { type: ['integer', 'null'], description: 'Bottles of THIS flavor. null if not stated. If only a total across flavors is given, split it evenly and list "quantity" in guessed.' },
            passes: { type: ['integer', 'null'], description: 'Print passes (see rules). null if colors/sides are not stated.' },
            print_description: { type: ['string', 'null'], description: 'What they said about colors and print areas, e.g. "2 colors front, 1 color back".' },
            shape: { type: ['string', 'null'], enum: ['round', 'oval', 'square', null] },
            tapered: { type: ['boolean', 'null'], description: 'Whether the print area is on a tapered (cone-shaped) section. null if unknown.' },
            size_ml: { type: ['number', 'null'], description: 'Bottle size in ml (1 L = 1000, 1.75 L = 1750, 50 ml mini = 50). null if unknown.' },
            bottle_name: { type: ['string', 'null'], description: 'Bottle brand/model as the customer named it.' },
            bottle_code: { type: ['string', 'null'], description: 'Code from the bottle catalog, ONLY if the named bottle clearly matches one entry. Otherwise null.' },
            repeat: { type: ['boolean', 'null'], description: 'true if they say ink360 printed this design before (reorder, same as last time). null if not said.' },
            control_no: { type: ['string', 'null'], description: 'ink360 control number if given or if it clearly matches one of the customer\'s existing products listed.' },
            guessed: { type: 'array', items: { type: 'string', enum: FIELDS }, description: 'Fields you inferred rather than read directly.' },
            notes: { type: ['string', 'null'], description: 'Anything else about this item (colors named, finish, artwork status).' }
          },
          required: ['flavor', 'quantity', 'passes', 'shape', 'tapered', 'size_ml', 'bottle_code', 'repeat', 'guessed']
        }
      },
      questions: {
        type: 'array',
        description: 'Questions for the customer about missing information that changes the price or is needed to print. Friendly, plain language, one sentence each. Empty if nothing is missing.',
        items: { type: 'object', properties: { about: { type: 'string', enum: FIELDS.concat(['other']) }, question: { type: 'string' } }, required: ['about', 'question'] }
      },
      other_requests: { type: ['string', 'null'], description: 'Other things they asked about: artwork/design help, deadline, shipping, samples, bottle sourcing.' },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'], description: 'How complete and clear the request is.' }
    },
    required: ['is_quote_request', 'summary', 'industry', 'items', 'questions', 'confidence']
  }
};

function systemPrompt(bottles){
  return [
    { type: 'text', text:
`You read incoming sales leads for ink360, a contract screen printer in the US that prints directly onto glass bottles ("Making Spirits Bright"). Most customers are distilleries; some are wineries, breweries, health & beauty, perfume & oils, candle and food brands. Turn the lead into the facts needed for a quote by calling record_quote_request exactly once.

Never invent facts. If the lead doesn't say something, use null and ask about it in questions. Put a field in "guessed" when you inferred it rather than read it (e.g. "our 750 bottle" → size 750 is read; a vodka brand assumed to use 750ml is guessed).

How ink360 quotes:
- One item per flavor / label design (each product the customer sells). Quantity is per flavor. Minimum order is 250 bottles per flavor.
- Bottle: shape is round, oval or square (flasks count as oval); tapered = the print area is on a cone-shaped/tapering part; size in ml.
- Passes: one ink color on one continuous side = 1 pass. Round bottles have one side (a wrap is one side). Oval bottles have 2 sides, square bottles 4. Example: 2 colors on the front only = 2 passes; 1 color front + 1 color back = 2 passes; 2 colors front and back = 4 passes. The price matrix goes up to 5 passes; if it is more, give the real number.
- A repeat is a design ink360 printed before (reorder, "same as last time", a control number like 136.112).
- The bottle catalog below lists bottles ink360 knows. If the customer names a bottle that clearly matches one entry (name and size), give its code as bottle_code and use it for shape, tapered and size. Do not pick a code on a vague match.
- Questions: ask only for what's missing that changes the price or is needed to print (quantity per flavor, number of colors and print sides, which bottle, repeat or new). Don't ask what they already told you. Write them so the customer can answer quickly.`},
    { type: 'text', text: 'Bottle catalog (code | description):\n' + bottles.map(b => `${b.code} | ${b.desc}`).join('\n'), cache_control: { type: 'ephemeral' } }
  ];
}

function leadPrompt(lead, products, extraText){
  const first = String(lead.contact || '').trim().split(/\s+/)[0] || '';
  const skip = /^(e_?mail|email_address|your_email|phone|phone_number|telephone|tel|mobile|cell|your_phone|address|street|address_?[12]|street_address|city|state|zip|zip_code|postal_code|first_?name|last_?name|name|full_?name|your_name|entry_?id|wpforms_entry_id)$/i;
  const fields = lead.web && lead.web.fields ? Object.entries(lead.web.fields).filter(([k]) => !skip.test(String(k).replace(/[^a-z0-9_]+/gi, '_'))).map(([k, v]) => `${k}: ${v}`) : [];
  const parts = [
    `Company: ${lead.company || '(not given)'}`,
    `Contact first name: ${first || '(not given)'}`,
    lead.web && lead.web.formName ? `Website form: ${lead.web.formName}` : '',
    fields.length ? `Form answers:\n${fields.join('\n')}` : (lead.notes ? `Message:\n${lead.notes}` : ''),
    extraText ? `Additional text from the customer (pasted by ink360):\n${extraText}` : '',
    products.length ? `This customer's existing products at ink360 (control # | name | bottle | passes):\n${products.map(p => `${p.controlNo} | ${p.project || ''} | ${p.bottleType || ''} ${p.size || ''}ml ${p.shape || ''}${p.taper ? ' tapered' : ''} | ${p.passes || ''}`).join('\n')}` : ''
  ].filter(Boolean);
  return `Here is the lead:\n\n${parts.join('\n\n')}`;
}

/* ---------- Claude's answer → quote lines ---------- */
function sizeBucket(ml){ ml = Number(ml) || 0; return ml <= 375 ? '375' : ml <= 750 ? '750' : ml <= 1000 ? '1000' : '1750'; }
function mlFromDesc(desc){
  const m = String(desc).match(/(\d+(?:\.\d+)?)\s?ml\b/i); if(m) return Number(m[1]);
  const l = String(desc).match(/(\d+(?:\.\d+)?)\s?(?:l|ltr|liter|litre)\b/i); if(l) return Math.round(Number(l[1]) * 1000);
  return null;
}
function bottleFacts(desc){
  const d = String(desc || '');
  return {
    shape: /square/i.test(d) ? 'square' : /\b(oval|oblong|flask)\b/i.test(d) ? 'oval' : /\bround\b/i.test(d) ? 'round' : null,
    taper: /non[- ]?taper/i.test(d) ? false : /taper/i.test(d) ? true : null,
    ml: mlFromDesc(d)
  };
}
const rid = p => p + '_' + Math.random().toString(36).slice(2, 9);
const int = v => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : null; };

function toLines(found, catalog, products){
  const items = Array.isArray(found.items) ? found.items : [];
  return items.map((it, i) => {
    const assumed = [];
    const code = it.bottle_code && catalog && catalog.items && catalog.items[it.bottle_code] ? it.bottle_code : '';
    const fromCat = code ? bottleFacts(catalog.items[code][1]) : { shape: null, taper: null, ml: null };
    const guessed = new Set(Array.isArray(it.guessed) ? it.guessed : []);
    let qty = int(it.quantity); if(!qty){ qty = DEFAULTS.qty; assumed.push('quantity'); } else if(guessed.has('quantity')) assumed.push('quantity');
    let passes = int(it.passes); if(!passes){ passes = DEFAULTS.passes; assumed.push('passes'); } else if(guessed.has('passes')) assumed.push('passes');
    let shape = fromCat.shape || (['round', 'oval', 'square'].includes(it.shape) ? it.shape : null);
    let taper = fromCat.taper != null ? fromCat.taper : (typeof it.tapered === 'boolean' ? it.tapered : null);
    let ml = fromCat.ml || (Number(it.size_ml) > 0 ? Number(it.size_ml) : null);
    const bottleUnknown = !shape || taper == null || !ml;
    if(!shape) shape = DEFAULTS.shape;
    if(taper == null) taper = DEFAULTS.taper;
    if(!ml) ml = DEFAULTS.ml;
    if(bottleUnknown || guessed.has('bottle')) assumed.push('bottle');
    let controlNo = String(it.control_no || '').trim();
    const known = controlNo && products.find(p => String(p.controlNo) === controlNo);
    if(controlNo && !known) controlNo = '';
    if(it.repeat === true && !known) assumed.push('repeat');
    const bottleName = String(it.bottle_name || '').trim();
    return {
      id: rid('ln'), flavor: String(it.flavor || `Product ${i + 1}`).slice(0, 120),
      shape, taper, size: sizeBucket(ml), ml, passes, qty,
      notes: [it.print_description, it.notes].filter(Boolean).join(' · ').slice(0, 500),
      controlNo, bottleType: (code ? code : bottleName.toUpperCase()).slice(0, 80), bottleSku: code,
      overrideUnit: '', tooling: '', assumed, draft: true
    };
  });
}

function questionsFor(found, lines){
  const out = []; const seen = new Set();
  (Array.isArray(found.questions) ? found.questions : []).forEach(q => {
    const text = String(q.question || '').trim(); if(!text) return;
    out.push({ about: FIELDS.includes(q.about) ? q.about : 'other', question: text.slice(0, 300) }); seen.add(q.about);
  });
  // Every assumption gets a question, even if Claude didn't write one
  FIELDS.forEach(f => {
    const which = lines.filter(ln => ln.assumed.includes(f));
    if(seen.has(f) || !which.length) return;
    const q = STANDARD_QUESTIONS[f];
    // Name the flavor(s) when the question doesn't apply to the whole request
    out.push({ about: f, question: which.length < lines.length ? `For the ${which.map(ln => ln.flavor).join(' and ')}: ${q.charAt(0).toLowerCase()}${q.slice(1)}` : q });
  });
  return out;
}

/* ---------- Run ---------- */
const running = new Set();
const pending = new Set();   // promises, so tests can wait for background drafts

function customerProducts(lead, products){
  const name = String(lead.company || lead.contact || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if(!name) return [];
  return products.filter(p => { const c = String(p.customer || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); return c && (c === name || c.includes(name) || name.includes(c)); }).slice(0, 60);
}

async function draftQuote(store, leadId, opts = {}){
  const s = settings();
  if(!s.apiKey) return { ok: false, status: 503, error: 'Claude isn’t connected: add ANTHROPIC_API_KEY in Railway (app service → Variables).' };
  if(running.has(leadId)) return { ok: false, status: 409, error: 'A draft for this lead is already being written.' };
  running.add(leadId);
  const p = (async () => {
    const doc = await store.get('leads', leadId);
    if(!doc) return { ok: false, status: 404, error: 'Lead not found.' };
    const lead = doc.data;
    const [catDoc, prodRows] = await Promise.all([store.get('app', 'qbitems'), store.listCollection('products')]);
    const catalog = catDoc ? catDoc.data : null;
    const products = customerProducts(lead, prodRows.map(r => Object.assign({}, r.data, { id: r.id })).filter(Boolean));
    const startedAt = new Date().toISOString();
    await patchLead(store, leadId, l => { l.autoQuote = Object.assign({}, l.autoQuote || {}, { status: 'working', startedAt, error: '' }); });

    let found, usage = null;
    try{
      const resp = await callClaude({
        apiKey: s.apiKey, baseUrl: s.baseUrl, model: s.model, maxTokens: 4000,
        system: systemPrompt(bottleItems(catalog)),
        messages: [{ role: 'user', content: leadPrompt(lead, products, String(opts.text || '').slice(0, 20000)) }],
        tools: [TOOL], toolChoice: { type: 'tool', name: TOOL.name }
      });
      usage = resp.usage || null;
      found = toolInput(resp, TOOL.name);
      if(!found) throw new Error('Claude didn’t return the quote details.');
    }catch(err){
      console.warn(`[autoquote] ${leadId}: ${err.message}`);
      await patchLead(store, leadId, l => { l.autoQuote = Object.assign({}, l.autoQuote || {}, { status: 'failed', error: err.message.slice(0, 300), finishedAt: new Date().toISOString() }); });
      return { ok: false, status: 502, error: err.message };
    }

    const isQuote = found.is_quote_request !== false;
    const lines = isQuote ? toLines(found, catalog, products) : [];
    const questions = isQuote ? questionsFor(found, lines) : [];
    const draft = {
      status: isQuote ? 'ready' : 'not-a-quote', startedAt, finishedAt: new Date().toISOString(), model: s.model, by: opts.by || 'website',
      summary: String(found.summary || '').slice(0, 400), industry: INDUSTRIES.includes(found.industry) ? found.industry : '',
      confidence: ['low', 'medium', 'high'].includes(found.confidence) ? found.confidence : '',
      otherRequests: String(found.other_requests || '').slice(0, 600), questions, lines,
      applied: false, reviewed: false, error: '', usedText: !!opts.text, usage
    };
    let applied = false;
    await patchLead(store, leadId, l => {
      const empty = !Array.isArray(l.lines) || !l.lines.length;
      const locked = ['sent', 'approved'].includes(l.stage);
      applied = isQuote && lines.length > 0 && !locked && (empty || opts.replace === true);
      if(applied) l.lines = lines.map(x => Object.assign({}, x));
      l.autoQuote = Object.assign({}, draft, { applied, appliedAt: applied ? draft.finishedAt : '' });
      if(draft.industry && !l.industry) l.industry = draft.industry;
      l.activity = Array.isArray(l.activity) ? l.activity : [];
      l.activity.unshift({ at: draft.finishedAt, by: 'Claude', text: !isQuote
        ? `Claude read this lead: not a quote request (${draft.summary || 'no details'}).`
        : `Claude drafted a quote: ${lines.length} flavor${lines.length === 1 ? '' : 's'}${questions.length ? `, ${questions.length} question${questions.length === 1 ? '' : 's'} for the customer` : ''}${applied ? '' : ' (not applied — the quote already had lines)'}. Needs Ken’s check.` });
      l.updatedAt = draft.finishedAt;
    });
    console.log(`[autoquote] ${leadId}: ${draft.status}, ${lines.length} line(s), ${questions.length} question(s)${applied ? ', applied' : ''}`);
    return { ok: true, autoQuote: Object.assign({}, draft, { applied }) };
  })().finally(() => { running.delete(leadId); pending.delete(p); });
  pending.add(p);
  return p;
}

/* Read-modify-write on the freshest copy, so a change made in the app meanwhile isn't lost. */
async function patchLead(store, id, fn){
  const doc = await store.get('leads', id); if(!doc) return;
  const l = doc.data; fn(l); await store.put('leads', id, l);
}

/* After a new website lead: draft in the background (the webhook answers WPForms right away). */
function draftInBackground(store, leadId){
  if(!status().auto) return false;
  draftQuote(store, leadId, { by: 'website' }).catch(err => console.error('[autoquote]', err));
  return true;
}
const idle = () => Promise.all([...pending]);

module.exports = { draftQuote, draftInBackground, status, idle, toLines, questionsFor, bottleFacts, sizeBucket, TOOL, systemPrompt, leadPrompt, STANDARD_QUESTIONS };
