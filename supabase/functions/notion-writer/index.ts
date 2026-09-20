// ============================================================
// Whitney Bateson DFY Funnel — notion-writer Edge Function v4
// Handles: Notion sync ONLY
// Triggered by: Supabase database webhook on the clients table
//               (trigger "notion-sync-trigger")
// Deploy to: supabase/functions/notion-writer/index.ts
// Secrets needed: NOTION_TOKEN, SUPABASE_SERVICE_ROLE_KEY
//
// The browser talks to the `notion-sync` function (AI proxy + Supabase
// save). Nothing in the page calls this one directly — the database
// webhook does, after every insert or update on `clients`.
// ============================================================

const NOTION_TOKEN = Deno.env.get('NOTION_TOKEN') || '';
const NOTION_DB_ID = 'bfdacfc5b8ee4b9cbc5dd984737a2135';
const NOTION_API   = 'https://api.notion.com/v1';
const SUPABASE_URL = 'https://rguqefwhlzehpzgljbdo.supabase.co';

// Section headings this function owns. Anything under one of these is
// rewritten on every run; anything else on the page is left alone, so
// notes the team adds survive.
const OWNED_SECTIONS = [
  '🏢 Business + Funnel Basics',
  '👤 Ideal Client Avatar',
  '🧲 Lead Magnet',
  '✍️ Voice + Email Intel',
  '📋 Platform Access',
];

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

const nHeaders = {
  'Authorization': `Bearer ${NOTION_TOKEN}`,
  'Content-Type': 'application/json',
  'Notion-Version': '2022-06-28',
};

// ── Value helpers ─────────────────────────────────────────────

// Only render a value the client actually gave. "N/A" is the intake's
// own skip answer, so it is not content.
function has(v: unknown): v is string {
  const s = String(v ?? '').trim();
  return s !== '' && s.toUpperCase() !== 'N/A';
}

// Notion validates every property in a PATCH together, so one malformed
// URL rejects the whole update — module statuses included. The intake has
// no URL validation, so normalise here and drop anything that won't parse.
function asUrl(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!has(s)) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : 'https://' + s;
  try {
    const u = new URL(withScheme);
    return u.hostname.includes('.') ? withScheme : null;
  } catch {
    return null;
  }
}

// ── Block helpers ─────────────────────────────────────────────

function rt(text: string) {
  return [{ type: 'text', text: { content: String(text || '').slice(0, 2000) } }];
}
function rtBold(label: string, text: string) {
  return [
    { type: 'text', text: { content: label }, annotations: { bold: true } },
    { type: 'text', text: { content: String(text || '').slice(0, 1900) } },
  ];
}
function bullet(text: string) {
  return { object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: rt(text) } };
}
function h2(text: string) {
  return { object: 'block', type: 'heading_2', heading_2: { rich_text: rt(text) } };
}
function h3(text: string) {
  return { object: 'block', type: 'heading_3', heading_3: { rich_text: rt(text) } };
}
function divider() {
  return { object: 'block', type: 'divider', divider: {} };
}
function callout(text: string, emoji: string, color = 'gray_background') {
  return { object: 'block', type: 'callout', callout: { rich_text: rt(text), icon: { type: 'emoji', emoji }, color } };
}
function paragraph(richText: unknown[]) {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: richText } };
}
function quote(richText: unknown[]) {
  return { object: 'block', type: 'quote', quote: { rich_text: richText } };
}
function bookmark(url: string, caption: string) {
  return { object: 'block', type: 'bookmark', bookmark: { url, caption: rt(caption) } };
}

// A saved upload, or a note that it did not make it to storage
function fileBlocks(file: unknown, label: string): unknown[] {
  const f = file as Record<string, string> | undefined | null;
  if (!f || !f.name) return [];
  const url = asUrl(f.url);
  if (url) return [bookmark(url, `${label}: ${f.name}`)];
  return [bullet(`${label}: ${f.name} — upload failed, ask the client to email it`)];
}

function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) { chunks.push(remaining); break; }
    let splitAt = remaining.lastIndexOf('. ', maxLen);
    if (splitAt < maxLen / 2) splitAt = remaining.lastIndexOf(' ', maxLen);
    if (splitAt < maxLen / 2) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt + 1));
    remaining = remaining.slice(splitAt + 1);
  }
  return chunks;
}

function conversationBlocks(history: Array<{ role: string; content: string }>): unknown[] {
  const blocks: unknown[] = [];
  for (const msg of history) {
    // Hidden priming and control messages are stored but never shown
    if (msg.role === 'user' && (
      msg.content.includes("client's name is") ||
      msg.content.includes('REFINE_MODE') ||
      msg.content.includes('WRAP_UP_NOW')
    )) continue;

    let content = msg.content;
    content = content.replace(/---ICA_SUMMARY_START---[\s\S]*?---ICA_SUMMARY_END---/g, '').trim();
    content = content.replace(/---LM_SUMMARY_START---[\s\S]*?---LM_SUMMARY_END---/g, '').trim();
    content = content.replace(/---VOICE_SUMMARY_START---[\s\S]*?---VOICE_SUMMARY_END---/g, '').trim();
    if (!content) continue;

    const chunks = splitText(content, 1900);
    for (let i = 0; i < chunks.length; i++) {
      if (msg.role === 'assistant') {
        blocks.push(i === 0 ? quote(rtBold('Sam: ', chunks[i])) : quote(rt(chunks[i])));
      } else {
        blocks.push(i === 0 ? paragraph(rtBold('Client: ', chunks[i])) : paragraph(rt(chunks[i])));
      }
    }

    if (blocks.length >= 400) {
      blocks.push(paragraph([{ type: 'text', text: { content: '... [conversation truncated — see the Supabase messages table for the full history]' }, annotations: { italic: true, color: 'gray' } }]));
      break;
    }
  }
  return blocks;
}

async function appendBlocks(pageId: string, blocks: unknown[]) {
  const BATCH_SIZE = 50;
  const total = blocks.length;
  console.log(`Appending ${total} blocks to page ${pageId}`);

  for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
    const batch = blocks.slice(i, i + BATCH_SIZE);
    const r = await fetch(`${NOTION_API}/blocks/${pageId}/children`, {
      method: 'PATCH',
      headers: nHeaders,
      body: JSON.stringify({ children: batch })
    });
    if (!r.ok) {
      console.error(`Block append failed at batch ${i}-${i + BATCH_SIZE}:`, await r.text());
    }
    if (i + BATCH_SIZE < blocks.length) {
      await new Promise(resolve => setTimeout(resolve, 400));
    }
  }
}

// ── Supabase reads ────────────────────────────────────────────

async function fetchMessages(email: string, module: string): Promise<Array<{ role: string; content: string }>> {
  const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_KEY) { console.error('SUPABASE_SERVICE_ROLE_KEY is not set'); return []; }

  const url = `${SUPABASE_URL}/rest/v1/messages?email=eq.${encodeURIComponent(email)}&module=eq.${module}&order=created_at.asc&limit=1000`;
  const r = await fetch(url, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
  });
  if (!r.ok) {
    console.error(`Failed to fetch ${module} messages:`, await r.text());
    return [];
  }
  const d = await r.json();
  return Array.isArray(d) ? d : [];
}

// ── Notion page helpers ───────────────────────────────────────

async function findClientPage(email: string): Promise<string | null> {
  const r = await fetch(`${NOTION_API}/databases/${NOTION_DB_ID}/query`, {
    method: 'POST', headers: nHeaders,
    body: JSON.stringify({ filter: { property: 'Email', email: { equals: email } } })
  });
  const d = await r.json();
  return d.results?.[0]?.id ?? null;
}

function buildProps(client: Record<string, unknown>): Record<string, unknown> {
  const m1 = (client.m1_data || {}) as Record<string, string>;
  const m3 = (client.m3_data || {}) as Record<string, string>;
  const props: Record<string, unknown> = {};

  if (has(m1.bizname))     props['Business Name']    = { rich_text: rt(m1.bizname) };
  if (has(m1.practype))    props['Practice Type']    = { select: { name: m1.practype } };
  if (has(m1.webplatform)) props['Website Platform'] = { rich_text: rt(m1.webplatform) };
  if (has(m1.esp))         props['Email Platform']   = { rich_text: rt(m1.esp) };
  if (has(m1.offer))       props['Main Offer']       = { rich_text: rt(m1.offer) };
  if (has(m1.offercta))    props['Offer CTA']        = { select: { name: m1.offercta } };
  if (has(m1.notes))       props['Notes']            = { rich_text: rt(m1.notes) };

  const website = asUrl(m1.website);
  if (website) props['Website'] = { url: website };
  const offerUrl = asUrl(m1.offerurl);
  if (offerUrl) props['Offer URL'] = { url: offerUrl };

  // The Thank You page question moved from Module 1 to the end of Module 3.
  // Older records still carry it on m1, so read either. Note the property is
  // named "Thank you Page" in Notion, lowercase "you".
  const typage = has(m3.typage) ? m3.typage : (has(m1.typage) ? m1.typage : null);
  if (typage) props['Thank you Page'] = { rich_text: rt(typage) };

  // "Years in business" was dropped from the intake. Kept here so existing
  // records still map cleanly; new ones simply won't have it.
  const yearsMap: Record<string, string> = {
    'Less than 1 year': 'Less than 1 year',
    '1–2 years': '1-2 years',
    '3–5 years': '3-5 years',
    '6–10 years': '6-10years',
    '10+ years': '10+ years',
  };
  if (m1.years && yearsMap[m1.years]) props['Years in Business'] = { select: { name: yearsMap[m1.years] } };

  // Meta access moved to a separate process. Older records still hold the
  // three yes/no answers in this column; newer ones hold "I'm stuck" flags,
  // whose keys simply won't match here.
  const fb = (client.fb_access_answers || {}) as Record<string, string>;
  if (fb.hasPage)      props['FB - Has Page']          = { select: { name: fb.hasPage } };
  if (fb.hasMeta)      props['FB - Has Meta Business'] = { select: { name: fb.hasMeta } };
  if (fb.hasAdAccount) props['FB - Has Ad Account']    = { select: { name: fb.hasAdAccount } };

  return props;
}

async function createClientPage(client: Record<string, unknown>): Promise<string> {
  const m1 = (client.m1_data || {}) as Record<string, string>;
  const name = [m1.firstname, m1.lastname].filter(Boolean).join(' ') || String(client.email);

  const props: Record<string, unknown> = {
    'Client Name': { title: rt(name) },
    'Email':       { email: client.email },
    'Status':      { select: { name: 'New' } },
    'Module 1':    { select: { name: 'Not Started' } },
    'Module 2':    { select: { name: 'Not Started' } },
    'Module 3':    { select: { name: 'Not Started' } },
    'Module 4':    { select: { name: 'Not Started' } },
    ...buildProps(client),
  };

  const r = await fetch(`${NOTION_API}/pages`, {
    method: 'POST', headers: nHeaders,
    body: JSON.stringify({ parent: { database_id: NOTION_DB_ID }, icon: { type: 'emoji', emoji: '🌿' }, properties: props })
  });
  const page = await r.json();
  if (!page.id) {
    console.error('Notion page creation failed:', JSON.stringify(page));
    throw new Error('Failed to create Notion page: ' + JSON.stringify(page));
  }
  return page.id;
}

async function updateClientProperties(pageId: string, client: Record<string, unknown>) {
  const modMap: Record<string, string> = {
    todo: 'Not Started', inprogress: 'In Progress', done: 'Complete', locked: 'Not Started',
  };

  const s1 = String(client.module_1_status || 'todo');
  const s2 = String(client.module_2_status || 'locked');
  const s3 = String(client.module_3_status || 'locked');
  const s4 = String(client.module_4_status || 'locked');

  let overall = 'New';
  if (client.submitted)                                                  overall = 'All Modules Complete';
  else if ([s1,s2,s3,s4].every(s => s === 'done'))                       overall = 'All Modules Complete';
  else if (s4 === 'done')                                               overall = 'Module 4 Complete';
  else if (s3 === 'done')                                               overall = 'Module 3 Complete';
  else if (s2 === 'done')                                               overall = 'Module 2 Complete';
  else if (s1 === 'done')                                               overall = 'Module 1 Complete';
  else if ([s1,s2,s3,s4].some(s => s === 'done' || s === 'inprogress')) overall = 'In Progress';

  const props: Record<string, unknown> = {
    'Status':   { select: { name: overall } },
    'Module 1': { select: { name: modMap[s1] || 'Not Started' } },
    'Module 2': { select: { name: modMap[s2] || 'Not Started' } },
    'Module 3': { select: { name: modMap[s3] || 'Not Started' } },
    'Module 4': { select: { name: modMap[s4] || 'Not Started' } },
    ...buildProps(client),
  };

  const r = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: 'PATCH', headers: nHeaders, body: JSON.stringify({ properties: props })
  });
  if (!r.ok) {
    console.error('Properties update FAILED:', await r.text());
  } else {
    console.log('Properties updated for page:', pageId);
  }
}

// ── Page body ─────────────────────────────────────────────────

async function listAllBlocks(pageId: string): Promise<Array<Record<string, any>>> {
  const all: Array<Record<string, any>> = [];
  let cursor: string | undefined;
  let safety = 15;
  while (safety-- > 0) {
    const url = `${NOTION_API}/blocks/${pageId}/children?page_size=100` + (cursor ? `&start_cursor=${cursor}` : '');
    const r = await fetch(url, { headers: nHeaders });
    if (!r.ok) { console.error('Could not list blocks:', await r.text()); break; }
    const d = await r.json();
    all.push(...(d.results || []));
    if (!d.has_more) break;
    cursor = d.next_cursor;
  }
  return all;
}

// Removes only the sections this function writes, so the whole page can be
// rebuilt from current data without touching anything the team added.
async function clearOwnedSections(pageId: string) {
  const blocks = await listAllBlocks(pageId);
  const toDelete: string[] = [];
  let inOwned = false;

  for (const b of blocks) {
    if (b.type === 'heading_2') {
      const heading = (b.heading_2?.rich_text || [])
        .map((t: any) => t?.plain_text || t?.text?.content || '').join('').trim();
      // Exact match only: a team heading that merely mentions "Lead Magnet"
      // is not ours to delete.
      inOwned = OWNED_SECTIONS.includes(heading);
    }
    if (inOwned) {
      toDelete.push(b.id);
      // Every section we write ends with a divider, so that closes the run.
      // Without this, anything the team added after our last section would
      // be swept up too.
      if (b.type === 'divider') inOwned = false;
    }
  }

  console.log(`Clearing ${toDelete.length} blocks from previously synced sections`);
  for (const id of toDelete) {
    const r = await fetch(`${NOTION_API}/blocks/${id}`, { method: 'DELETE', headers: nHeaders });
    if (!r.ok) console.error('Block delete failed:', id, await r.text());
  }
}

async function syncNotionContent(pageId: string, client: Record<string, unknown>) {
  await clearOwnedSections(pageId);

  const blocks: unknown[] = [];
  const m1 = (client.m1_data || {}) as Record<string, any>;
  const m2 = (client.m2_data || {}) as Record<string, any>;
  const m3 = (client.m3_data || {}) as Record<string, any>;
  const m4 = (client.m4_data || {}) as Record<string, any>;
  const email = String(client.email);

  const s1 = String(client.module_1_status || '');
  const s3 = String(client.module_3_status || '');

  // ── Module 1 ──
  if (s1 === 'done' || s1 === 'inprogress') {
    blocks.push(h2('🏢 Business + Funnel Basics'));
    if (has(m1.bizname))  blocks.push(bullet('Business: ' + m1.bizname));
    if (has(m1.practype)) blocks.push(bullet('Practice type: ' + m1.practype + (has(m1.practypeOther) ? ' — ' + m1.practypeOther : '')));
    if (has(m1.website))  blocks.push(bullet('Website: ' + m1.website));
    if (has(m1.licensed)) blocks.push(bullet('Licensed / credentialed: ' + m1.licensed));
    if (has(m1.licenseStates)) blocks.push(bullet('Licensed in: ' + m1.licenseStates));
    if (has(m1.geolimit)) {
      blocks.push(m1.geolimit === 'Anywhere'
        ? bullet('Can work with clients: Anywhere')
        : callout('Ad targeting: ' + m1.geolimit + (has(m1.licenseStates) ? ' (' + m1.licenseStates + ')' : ''), '⚠️', 'orange_background'));
    }
    if (has(m1.years))       blocks.push(bullet('In business: ' + m1.years));
    if (has(m1.offer))       blocks.push(bullet('Main offer: ' + m1.offer));
    if (has(m1.offercta))    blocks.push(bullet('Offer CTA: ' + m1.offercta));
    if (has(m1.offerurl))    blocks.push(bullet('Offer URL: ' + m1.offerurl));
    if (has(m1.esp))         blocks.push(bullet('Email platform: ' + m1.esp + (has(m1.espOther) ? ' — ' + m1.espOther : '')));
    if (has(m1.webplatform)) blocks.push(bullet('Website platform: ' + m1.webplatform + (has(m1.webplatformOther) ? ' — ' + m1.webplatformOther : '')));
    if (has(m1.notes))       blocks.push(callout(m1.notes, '💬'));

    // Brand assets
    const ba = (m1.brandAssets || {}) as Record<string, any>;
    const assets: unknown[] = [];
    assets.push(...fileBlocks(ba.logo, '🖼️ Logo'));
    assets.push(...fileBlocks(ba.brandguide, '🎨 Brand guide'));
    const photos = Array.isArray(ba.photos) ? ba.photos : (ba.photos ? [ba.photos] : []);
    for (const p of photos) assets.push(...fileBlocks(p, '📸 Photo'));
    if (assets.length) {
      blocks.push(h3('🎨 Brand Assets'));
      blocks.push(...assets);
    }
    blocks.push(divider());
  }

  // ── Module 2 ──
  const icaSummary = m2.summary as string;
  const m2Messages = await fetchMessages(email, 'm2');
  if (has(icaSummary) || m2Messages.length > 0) {
    blocks.push(h2('👤 Ideal Client Avatar'));
    if (has(icaSummary)) blocks.push(callout(icaSummary, '✨'));
    if (m2Messages.length > 0) {
      blocks.push(h3('💬 Full Conversation — Module 2'));
      blocks.push(...conversationBlocks(m2Messages));
    }
    blocks.push(divider());
  }

  // ── Module 3 ──
  const m3Messages = await fetchMessages(email, 'm3');
  if (s3 === 'done' || s3 === 'inprogress' || m3Messages.length > 0) {
    blocks.push(h2('🧲 Lead Magnet'));
    if (has(m3.hadLm))  blocks.push(bullet('Had a lead magnet before: ' + m3.hadLm));
    if (has(m3.pastLm)) blocks.push(bullet('Past lead magnet: ' + m3.pastLm));
    if (has(m3.choice)) blocks.push(bullet('Campaign choice: ' + m3.choice));

    // Creating something new
    if (has(m3.whyNotExisting))  blocks.push(bullet('Why not an existing one: ' + m3.whyNotExisting));
    if (has(m3.contentChannels)) blocks.push(bullet('📍 Content lives at: ' + m3.contentChannels));
    if (has(m3.bestContent))     blocks.push(bullet('⭐ Content that performed well: ' + m3.bestContent));
    // Retired question — still rendered so the records that answered it keep theirs
    if (has(m3.halfBuilt))       blocks.push(bullet('🔨 Already half-built: ' + m3.halfBuilt));
    // Older records
    if (has(m3.lmTopic))          blocks.push(bullet('Topic: ' + m3.lmTopic));
    if (has(m3.lmTransformation)) blocks.push(bullet('Transformation: ' + m3.lmTransformation));

    // Using an existing one
    if (has(m3.existingName))      blocks.push(bullet('Existing lead magnet: ' + m3.existingName));
    if (has(m3.existingLink))      blocks.push(bullet('Canva / hosted link: ' + m3.existingLink));
    if (has(m3.existingDownloads)) blocks.push(bullet('Downloads so far: ' + m3.existingDownloads));
    if (has(m3.existingPromoted))  blocks.push(bullet('Promoted via: ' + m3.existingPromoted));
    if (has(m3.existingReplies))   blocks.push(bullet('Replies / responses: ' + m3.existingReplies));
    if (has(m3.existingAfter))     blocks.push(bullet('What happens after download: ' + m3.existingAfter));
    if (has(m3.existingWorking))   blocks.push(bullet('What works: ' + m3.existingWorking));
    if (has(m3.existingFreshen))   blocks.push(bullet('To freshen: ' + m3.existingFreshen));
    if (has(m3.openToChanges))     blocks.push(bullet('Open to changes: ' + m3.openToChanges));

    // Improving one
    if (has(m3.improveName))      blocks.push(bullet('Improving: ' + m3.improveName));
    if (has(m3.improveLink))      blocks.push(bullet('Canva / hosted link: ' + m3.improveLink));
    if (has(m3.improveDownloads)) blocks.push(bullet('Downloads so far: ' + m3.improveDownloads));
    if (has(m3.improvePromoted))  blocks.push(bullet('Promoted via: ' + m3.improvePromoted));
    if (has(m3.improveReplies))   blocks.push(bullet('Replies / responses: ' + m3.improveReplies));
    if (has(m3.improveAfter))     blocks.push(bullet('What happens after download: ' + m3.improveAfter));
    if (has(m3.improveIssues))    blocks.push(bullet('Issues: ' + m3.improveIssues));
    if (has(m3.improveGoal))      blocks.push(bullet('New goal: ' + m3.improveGoal));
    if (has(m3.improveKeep))      blocks.push(bullet('Keep: ' + m3.improveKeep));
    if (has(m3.openToChanges2))   blocks.push(bullet('Open to changes: ' + m3.openToChanges2));

    // Thank You page (asked at the end of Module 3)
    if (has(m3.typage))  blocks.push(bullet('Thank You page points to: ' + m3.typage));
    if (has(m3.tyoffer)) blocks.push(bullet('Low-ticket offer: ' + m3.tyoffer));

    blocks.push(...fileBlocks(m3.pdfUpload, '📄 Lead Magnet PDF'));

    if (m3Messages.length > 0) {
      blocks.push(h3('💬 Lead Magnet Conversation — Module 3'));
      blocks.push(...conversationBlocks(m3Messages));
    }
    blocks.push(divider());
  }

  // ── Module 4 ──
  const m4Messages = await fetchMessages(email, 'm4');
  const hasAssets = has(m4.writingSamples) || has(m4.testimonials) || has(m4.resources);
  if (m4Messages.length > 0 || hasAssets) {
    blocks.push(h2('✍️ Voice + Email Intel'));
    if (has(m4.writingSamples)) {
      blocks.push(h3('📝 Writing Samples'));
      for (const c of splitText(m4.writingSamples, 1900)) blocks.push(paragraph(rt(c)));
    }
    if (has(m4.testimonials)) {
      blocks.push(h3('💛 Testimonials'));
      for (const c of splitText(m4.testimonials, 1900)) blocks.push(paragraph(rt(c)));
    }
    if (has(m4.resources)) {
      blocks.push(h3('🔗 Resources to Link'));
      for (const c of splitText(m4.resources, 1900)) blocks.push(paragraph(rt(c)));
    }
    if (m4Messages.length > 0) {
      blocks.push(h3('💬 Full Conversation — Module 4'));
      blocks.push(...conversationBlocks(m4Messages));
    }
    blocks.push(divider());
  }

  // ── Platform access ──
  blocks.push(h2('📋 Platform Access'));
  if (client.submitted) {
    blocks.push(callout('CLIENT HAS SUBMITTED — all four modules are finished and locked. Ready to build.', '✅', 'green_background'));
  }
  // New records store the "I'm stuck" flags here; older ones store the Meta answers.
  const stuck = (client.fb_access_answers || {}) as Record<string, boolean>;
  const accessLine = (label: string, done: unknown, isStuck: unknown) =>
    bullet(`${label}: ` + (done ? '✅ Confirmed' : (isStuck ? '🆘 CLIENT NEEDS HELP — reach out' : '⏳ Pending')));
  blocks.push(accessLine('Website access', client.access_website, stuck.website));
  blocks.push(accessLine('Email platform access', client.access_email, stuck.email));
  blocks.push(bullet('Meta / Facebook access: handled separately via the access link'));
  blocks.push(divider()); // closes the section for clearOwnedSections

  await appendBlocks(pageId, blocks);
}

// ── Main ──────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const client = body.record || body;

    if (!client?.email) return json({ error: 'Missing email' }, 400);
    if (!NOTION_TOKEN) return json({ error: 'NOTION_TOKEN secret not set' }, 500);

    console.log('notion-writer triggered for:', client.email);

    let pageId = await findClientPage(String(client.email));
    if (!pageId) {
      console.log('Creating new Notion page for:', client.email);
      pageId = await createClientPage(client);
    } else {
      console.log('Updating existing Notion page for:', client.email);
      await updateClientProperties(pageId, client);
    }

    await syncNotionContent(pageId, client);

    console.log('notion-writer complete for:', client.email);
    return json({ success: true });

  } catch (err) {
    console.error('notion-writer error:', err);
    return json({ error: String(err) }, 500);
  }
});
