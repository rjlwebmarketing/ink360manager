/* ============================================================
   WPForms → ink360 lead
   WPForms Webhooks addon sends one request per form entry. The field
   names in the request body are whatever is set in the webhook's
   "Request Body" mapping; this accepts common names (see ALIASES) and
   keeps everything else as "Label: value" lines in the lead's notes.
   Rules:
   - One lead per WPForms entry: an entry_id that was already received
     is ignored (WPForms retries or a double submit never duplicates).
   - Same email with an open lead (not approved/lost): the entry is
     added to that lead's activity instead of creating a second lead.
   - The original entry is kept on the lead (lead.web.fields).
   ============================================================ */
'use strict';
const crypto = require('node:crypto');

const ALIASES = {
  entryId:  ['entry_id','entryid','entry','wpforms_entry_id','id'],
  formName: ['form','form_name','formname','form_title','form_id','formid'],
  firstName:['first_name','firstname','first','name_first'],
  lastName: ['last_name','lastname','last','name_last'],
  contact:  ['name','full_name','fullname','your_name','contact','contact_name'],
  company:  ['company','company_name','business','business_name','brand','brand_name','distillery','winery','brewery','organization','organisation'],
  email:    ['email','e_mail','email_address','your_email'],
  phone:    ['phone','phone_number','telephone','tel','mobile','cell','your_phone'],
  notes:    ['message','comments','comment','details','project_details','description','notes','how_can_we_help','tell_us_about_your_project','project'],
  street:   ['street','address','address_1','address1','street_address','address_line_1'],
  street2:  ['address_2','address2','address_line_2'],
  city:     ['city','town'],
  state:    ['state','province','region'],
  zip:      ['zip','zip_code','zipcode','postal','postal_code','postcode']
};
const LOOKUP = {};
Object.entries(ALIASES).forEach(([field, names]) => names.forEach(n => LOOKUP[n] = field));
const norm = k => String(k).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const clean = v => {
  if(v == null) return '';
  if(Array.isArray(v)) v = v.map(clean).filter(Boolean).join(', ');
  else if(typeof v === 'object') v = Object.values(v).map(clean).filter(Boolean).join(' ');
  return String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, 4000);
};
const label = k => String(k).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^./, c => c.toUpperCase());

function mapEntry(body, opts){
  const out = { entryId:'', formName: clean(opts.form), firstName:'', lastName:'', contact:'', company:'', email:'', phone:'', notes:'', street:'', street2:'', city:'', state:'', zip:'' };
  const extra = []; const fields = {};
  Object.entries(body || {}).forEach(([k, v]) => {
    let value = clean(v); if(!value) return;
    let f = LOOKUP[norm(k)];
    // WPForms joins multi-part fields with "||" (Address: line 1||line 2||city||state||zip||country)
    if(value.includes('||')){
      const parts = value.split('||').map(x => x.trim());
      if(f === 'street' && !out.street){
        [out.street, out.street2, out.city, out.state, out.zip] = [parts[0]||'', parts[1]||'', parts[2]||'', parts[3]||'', parts[4]||''];
        fields[k] = parts.filter(Boolean).join(', ');
        return;
      }
      value = parts.filter(Boolean).join(', ');
    }
    fields[k] = value;
    if(f && !out[f]) out[f] = value;
    else if(f === 'notes') out.notes += '\n' + value;
    else extra.push(`${label(k)}: ${value}`);
  });
  if(!out.contact) out.contact = [out.firstName, out.lastName].filter(Boolean).join(' ');
  if(!out.email){ const e = Object.values(fields).join(' ').match(/[\w.+-]+@[\w-]+\.[\w.-]+/); if(e) out.email = e[0]; }
  out.email = out.email.toLowerCase();
  out.notes = [out.notes.trim(), extra.join('\n')].filter(Boolean).join('\n');
  return { m: out, fields };
}

async function handleWpforms(store, body, opts = {}){
  const { m, fields } = mapEntry(body, opts);
  if(!m.email && !m.phone && !m.contact && !m.company){
    return { status:422, ok:false, action:'rejected', reason:'Entry has no name, company, email or phone' };
  }
  const now = new Date().toISOString();
  const entryKey = m.entryId ? m.entryId.replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 60)
    : crypto.createHash('sha1').update(JSON.stringify(fields)).digest('hex').slice(0, 16);
  const leadId = 'wp_' + entryKey;

  // 1) Same WPForms entry already received → ignore
  if(await store.get('leads', leadId)) return { ok:true, action:'duplicate', leadId };

  const formTag = m.formName ? ` (${m.formName})` : '';
  const leads = await store.listCollection('leads');
  const seenOn = leads.find(r => r.data && ((r.data.web && r.data.web.entryKey === entryKey) || (Array.isArray(r.data.webEntries) && r.data.webEntries.some(w => w.entryKey === entryKey))));
  if(seenOn) return { ok:true, action:'duplicate', leadId: seenOn.id };

  // 2) Same email already has an open lead → add the entry to that lead
  if(m.email){
    const open = leads.find(r => r.data && String(r.data.email || '').toLowerCase() === m.email && !['approved','lost'].includes(r.data.stage));
    if(open){
      const l = open.data;
      l.activity = Array.isArray(l.activity) ? l.activity : [];
      l.activity.unshift({ at: now, by:'Website', text: `Website form submitted again${formTag}${m.entryId ? ' — entry #' + m.entryId : ''}${m.notes ? ':\n' + m.notes : ''}` });
      l.updatedAt = now;
      if(!l.phone && m.phone) l.phone = m.phone;
      if(!l.company && m.company) l.company = m.company;
      l.webEntries = (Array.isArray(l.webEntries) ? l.webEntries : []).concat([{ entryKey, entryId: m.entryId, formName: m.formName, receivedAt: now, fields }]).slice(-20);
      await store.put('leads', open.id, l);
      return { ok:true, action:'noted', leadId: open.id };
    }
  }

  // 3) New lead, shaped exactly like a lead created in the app
  const lead = {
    id: leadId, createdAt: now, updatedAt: now, stage:'new', source:'website', priceList:'published',
    company: m.company, contact: m.contact, email: m.email, phone: m.phone, notes: m.notes,
    shipTo: { name: m.company || m.contact || '', street: [m.street, m.street2].filter(Boolean).join(', '), city: m.city, state: m.state.toUpperCase().slice(0, 30), zip: m.zip },
    lines: [], jobs: [], workflow: {}, estimateNo:'', estimateDate:'',
    activity: [{ at: now, by:'Website', text: `Lead created from the website form${formTag}${m.entryId ? ' — entry #' + m.entryId : ''}` }],
    web: { entryKey, entryId: m.entryId, formName: m.formName, receivedAt: now, fields }
  };
  await store.put('leads', leadId, lead);
  return { ok:true, action:'created', leadId };
}

module.exports = { handleWpforms, mapEntry, ALIASES };
