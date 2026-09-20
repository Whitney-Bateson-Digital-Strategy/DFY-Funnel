// ============================================================
// Whitney Bateson DFY Funnel — Supabase Edge Function
// Handles: AI chat proxy + Notion sync
// Deploy to: supabase/functions/notion-sync/index.ts
// Secrets needed: ANTHROPIC_API_KEY, NOTION_TOKEN
// ============================================================

const NOTION_TOKEN = Deno.env.get('NOTION_TOKEN') ?? '';
const NOTION_DB_ID = 'bfdacfc5b8ee4b9cbc5dd984737a2135';
const NOTION_API   = 'https://api.notion.com/v1';

// Supabase injects these into every edge function — used to read chat transcripts
const SB_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SB_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY') ?? '';

// Everything below this marker on a client's Notion page is rewritten on each
// sync. Anything the team adds ABOVE it is left alone.
const SYNC_MARKER = 'Everything below is synced automatically from the intake form';

// One sync at a time per client, so a rapid second save can't race the first
// or get silently dropped.
const inFlight = new Map<string, Promise<void>>();

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
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

// Only render a value if the client actually gave one
function has(v: unknown): v is string {
  const s = String(v ?? '').trim();
  return s !== '' && s.toUpperCase() !== 'N/A';
}

// ── Chat transcripts ────────────────────────────────────────
// Transcripts live in the `messages` table, not in the client record, so the
// sync reads them back out here. (They used to be sent in the payload; when
// that changed, module 4 stopped reaching Notion entirely.)
async function fetchTranscript(email: string, module: string): Promise<Array<{ role: string; content: string }>> {
  if (!SB_URL || !SB_SERVICE_KEY) return [];
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/messages?email=eq.${encodeURIComponent(email)}&module=eq.${module}&order=created_at.asc&limit=1000`,
      { headers: { 'apikey': SB_SERVICE_KEY, 'Authorization': `Bearer ${SB_SERVICE_KEY}` } }
    );
    if (!r.ok) {
      console.error(`Transcript fetch failed for ${module}:`, r.status, await r.text());
      return [];
    }
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  } catch (err) {
    console.error(`Transcript fetch threw for ${module}:`, err);
    return [];
  }
}

// Convert a conversation history array into readable Notion blocks
function conversationBlocks(history: Array<{ role: string; content: string }>): unknown[] {
  const blocks: unknown[] = [];
  for (const msg of history) {
    // Skip hidden priming/control messages
    if (msg.role === 'user' && (
      msg.content.includes("client's name is") ||
      msg.content.includes('REFINE_MODE') ||
      msg.content.includes('WRAP_UP_NOW')
    )) continue;

    // Strip summary markers from assistant messages for display
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
  }
  return blocks;
}

// Split long text into chunks that fit Notion's 2000-char limit
function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('. ', maxLen);
    if (splitAt < maxLen / 2) splitAt = remaining.lastIndexOf(' ', maxLen);
    if (splitAt < maxLen / 2) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt + 1));
    remaining = remaining.slice(splitAt + 1);
  }
  return chunks;
}

// ── Notion page properties ──────────────────────────────────

async function findClientPage(email: string): Promise<string | null> {
  const r = await fetch(`${NOTION_API}/databases/${NOTION_DB_ID}/query`, {
    method: 'POST', headers: nHeaders,
    body: JSON.stringify({ filter: { property: 'Email', email: { equals: email } } })
  });
  const d = await r.json();
  return d.results?.[0]?.id ?? null;
}

// Properties shared by create and update
function buildProps(client: Record<string, unknown>): Record<string, unknown> {
  const m1 = (client.m1_data || {}) as Record<string, string>;
  const props: Record<string, unknown> = {};
  if (has(m1.bizname)) props['Business Name'] = { rich_text: rt(m1.bizname) };
  if (has(m1.practype)) props['Practice Type'] = { select: { name: m1.practype } };
  if (has(m1.website)) props['Website'] = { url: m1.website };
  if (has(m1.webplatform)) props['Website Platform'] = { rich_text: rt(m1.webplatform) };
  if (has(m1.esp)) props['Email Platform'] = { rich_text: rt(m1.esp) };
  if (has(m1.offer)) props['Main Offer'] = { rich_text: rt(m1.offer) };
  if (has(m1.offercta)) props['Offer CTA'] = { select: { name: m1.offercta } };
  if (has(m1.offerurl)) props['Offer URL'] = { url: m1.offerurl };
  const m3 = (client.m3_data || {}) as Record<string, string>;
  if (has(m3.typage)) props['Thank You Page'] = { rich_text: rt(m3.typage) };
  return props;
}

async function createClientPage(client: Record<string, unknown>): Promise<string> {
  const m1 = (client.m1_data || {}) as Record<string, string>;
  const name = [m1.firstname, m1.lastname].filter(Boolean).join(' ') || String(client.email);
  const props: Record<string, unknown> = {
    'Client Name': { title: rt(name) },
    'Email': { email: client.email },
    'Status': { select: { name: 'New' } },
    'Module 1': { select: { name: 'Not Started' } },
    'Module 2': { select: { name: 'Not Started' } },
    'Module 3': { select: { name: 'Not Started' } },
    'Module 4': { select: { name: 'Not Started' } },
    ...buildProps(client),
  };

  const r = await fetch(`${NOTION_API}/pages`, {
    method: 'POST', headers: nHeaders,
    body: JSON.stringify({ parent: { database_id: NOTION_DB_ID }, icon: { type: 'emoji', emoji: '🌿' }, properties: props })
  });
  const page = await r.json();
  if (!page.id) {
    console.error('Notion page create failed:', JSON.stringify(page));
    throw new Error(page?.message || 'Could not create Notion page');
  }
  return page.id;
}

async function updateClientPage(pageId: string, client: Record<string, unknown>) {
  const modMap: Record<string, string> = { todo: 'Not Started', inprogress: 'In Progress', done: 'Complete', locked: 'Not Started' };
  const s1 = String(client.module_1_status || 'todo');
  const s2 = String(client.module_2_status || 'locked');
  const s3 = String(client.module_3_status || 'locked');
  const s4 = String(client.module_4_status || 'locked');

  let overall = 'New';
  if (client.submitted) overall = 'All Modules Complete';
  else if ([s1,s2,s3,s4].every(s => s === 'done')) overall = 'All Modules Complete';
  else if (s3 === 'done' || s4 === 'done') overall = 'Module 3 Complete';
  else if (s2 === 'done') overall = 'Module 2 Complete';
  else if (s1 === 'done') overall = 'Module 1 Complete';
  else if ([s1,s2,s3,s4].some(s => s === 'done' || s === 'inprogress')) overall = 'In Progress';

  const props: Record<string, unknown> = {
    'Status': { select: { name: overall } },
    'Module 1': { select: { name: modMap[s1] || 'Not Started' } },
    'Module 2': { select: { name: modMap[s2] || 'Not Started' } },
    'Module 3': { select: { name: modMap[s3] || 'Not Started' } },
    'Module 4': { select: { name: modMap[s4] || 'Not Started' } },
    ...buildProps(client),
  };

  const r = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: 'PATCH', headers: nHeaders, body: JSON.stringify({ properties: props })
  });
  if (!r.ok) console.error('Notion property update failed:', r.status, await r.text());
}

// ── Page body ───────────────────────────────────────────────

// Reads the page's existing blocks and deletes only the ones at or below the
// sync marker, so notes the team added above it survive.
async function clearSyncedBlocks(pageId: string) {
  const existing = await fetch(`${NOTION_API}/blocks/${pageId}/children?page_size=100`, { headers: nHeaders });
  if (!existing.ok) { console.error('Could not list page blocks:', existing.status); return; }
  const exData = await existing.json();
  const results = (exData.results || []) as Array<Record<string, any>>;

  let markerIndex = results.findIndex((b) => {
    const texts = b?.callout?.rich_text || b?.paragraph?.rich_text || [];
    return texts.some((t: any) => String(t?.plain_text || t?.text?.content || '').includes(SYNC_MARKER));
  });
  // No marker yet (first sync since this change) — the old code rewrote the
  // whole page every time, so there are no hand-written notes to preserve.
  if (markerIndex === -1) markerIndex = 0;

  for (const block of results.slice(markerIndex)) {
    const d = await fetch(`${NOTION_API}/blocks/${block.id}`, { method: 'DELETE', headers: nHeaders });
    if (!d.ok) console.error('Block delete failed:', block.id, d.status);
  }
}

async function rebuildPageContent(pageId: string, client: Record<string, unknown>) {
  await clearSyncedBlocks(pageId);

  const blocks: unknown[] = [];
  const m1 = (client.m1_data || {}) as Record<string, any>;
  const m2 = (client.m2_data || {}) as Record<string, unknown>;
  const m3 = (client.m3_data || {}) as Record<string, any>;
  const m4 = (client.m4_data || {}) as Record<string, any>;
  const email = String(client.email);

  blocks.push(callout(SYNC_MARKER + ' — add your own notes above this line, not below it.', '🔄', 'blue_background'));

  if (client.submitted) {
    blocks.push(callout('CLIENT HAS SUBMITTED — all four modules are finished and locked. Ready to build.', '✅', 'green_background'));
  }

  // ── Module 1 ──
  const s1 = String(client.module_1_status || '');
  if (s1 === 'done' || s1 === 'inprogress') {
    blocks.push(h2('🏢 Business + Funnel Basics'));
    if (has(m1.bizname)) blocks.push(bullet('Business: ' + m1.bizname));
    if (has(m1.practype)) blocks.push(bullet('Practice type: ' + m1.practype + (has(m1.practypeOther) ? ' — ' + m1.practypeOther : '')));
    if (has(m1.website)) blocks.push(bullet('Website: ' + m1.website));
    if (has(m1.licensed)) blocks.push(bullet('Licensed / credentialed: ' + m1.licensed));
    if (has(m1.licenseStates)) blocks.push(bullet('Licensed in: ' + m1.licenseStates));
    if (has(m1.geolimit)) blocks.push(bullet('⚠️ Can work with clients: ' + m1.geolimit));
    if (has(m1.offer)) blocks.push(bullet('Main offer: ' + m1.offer));
    if (has(m1.offercta)) blocks.push(bullet('Offer CTA: ' + m1.offercta));
    if (has(m1.offerurl)) blocks.push(bullet('Offer URL: ' + m1.offerurl));
    if (has(m1.esp)) blocks.push(bullet('Email platform: ' + m1.esp + (has(m1.espOther) ? ' — ' + m1.espOther : '')));
    if (has(m1.webplatform)) blocks.push(bullet('Website platform: ' + m1.webplatform + (has(m1.webplatformOther) ? ' — ' + m1.webplatformOther : '')));
    if (has(m1.notes)) blocks.push(callout(m1.notes, '💬'));

    // Brand assets
    const ba = (m1.brandAssets || {}) as Record<string, any>;
    const assetBlocks: unknown[] = [];
    if (ba.logo?.url) assetBlocks.push(bookmark(ba.logo.url, '🖼️ Logo: ' + (ba.logo.name || 'download')));
    else if (ba.logo?.name) assetBlocks.push(bullet('🖼️ Logo uploaded: ' + ba.logo.name + ' (link unavailable — check Supabase Storage)'));
    if (ba.brandguide?.url) assetBlocks.push(bookmark(ba.brandguide.url, '🎨 Brand guide: ' + (ba.brandguide.name || 'download')));
    else if (ba.brandguide?.name) assetBlocks.push(bullet('🎨 Brand guide uploaded: ' + ba.brandguide.name + ' (link unavailable)'));
    const photos = Array.isArray(ba.photos) ? ba.photos : (ba.photos ? [ba.photos] : []);
    for (const p of photos) {
      if (p?.url) assetBlocks.push(bookmark(p.url, '📸 Photo: ' + (p.name || 'download')));
      else if (p?.name) assetBlocks.push(bullet('📸 Photo uploaded: ' + p.name + ' (link unavailable)'));
    }
    if (assetBlocks.length) {
      blocks.push(h3('🎨 Brand Assets'));
      blocks.push(...assetBlocks);
    }
    blocks.push(divider());
  }

  // ── Module 2 — ICA summary + full transcript ──
  const icaSummary = m2.summary as string;
  const m2History = await fetchTranscript(email, 'm2');
  if (has(icaSummary) || m2History.length > 0) {
    blocks.push(h2('👤 Ideal Client Avatar'));
    if (has(icaSummary)) blocks.push(callout(icaSummary, '✨'));
    if (m2History.length > 0) {
      blocks.push(h3('💬 Full Conversation — Module 2'));
      blocks.push(...conversationBlocks(m2History));
    }
    blocks.push(divider());
  }

  // ── Module 3 — lead magnet ──
  const s3 = String(client.module_3_status || '');
  const m3History = await fetchTranscript(email, 'm3');
  if (s3 === 'done' || s3 === 'inprogress' || m3History.length > 0) {
    blocks.push(h2('🧲 Lead Magnet'));
    if (has(m3.hadLm)) blocks.push(bullet('Had a lead magnet before: ' + m3.hadLm));
    if (has(m3.pastLm)) blocks.push(bullet('Past lead magnet: ' + m3.pastLm));
    if (has(m3.choice)) blocks.push(bullet('Campaign choice: ' + m3.choice));

    // Create-new branch
    if (has(m3.whyNotExisting)) blocks.push(bullet('Why not an existing one: ' + m3.whyNotExisting));
    if (has(m3.contentChannels)) blocks.push(bullet('📍 Content lives at: ' + m3.contentChannels));
    if (has(m3.bestContent)) blocks.push(bullet('⭐ Content that performed well: ' + m3.bestContent));
    if (has(m3.halfBuilt)) blocks.push(bullet('🔨 Already half-built: ' + m3.halfBuilt));

    // Use-existing branch
    if (has(m3.existingName)) blocks.push(bullet('Existing lead magnet: ' + m3.existingName));
    if (has(m3.existingLink)) blocks.push(bullet('Canva / hosted link: ' + m3.existingLink));
    if (has(m3.existingDownloads)) blocks.push(bullet('Downloads so far: ' + m3.existingDownloads));
    if (has(m3.existingPromoted)) blocks.push(bullet('Promoted via: ' + m3.existingPromoted));
    if (has(m3.existingReplies)) blocks.push(bullet('Replies / responses: ' + m3.existingReplies));
    if (has(m3.existingAfter)) blocks.push(bullet('What happens after download: ' + m3.existingAfter));
    if (has(m3.existingFreshen)) blocks.push(bullet('To freshen: ' + m3.existingFreshen));
    if (has(m3.openToChanges)) blocks.push(bullet('Open to changes: ' + m3.openToChanges));

    // Improve branch
    if (has(m3.improveName)) blocks.push(bullet('Improving: ' + m3.improveName));
    if (has(m3.improveLink)) blocks.push(bullet('Canva / hosted link: ' + m3.improveLink));
    if (has(m3.improveDownloads)) blocks.push(bullet('Downloads so far: ' + m3.improveDownloads));
    if (has(m3.improvePromoted)) blocks.push(bullet('Promoted via: ' + m3.improvePromoted));
    if (has(m3.improveReplies)) blocks.push(bullet('Replies / responses: ' + m3.improveReplies));
    if (has(m3.improveAfter)) blocks.push(bullet('What happens after download: ' + m3.improveAfter));
    if (has(m3.improveGoal)) blocks.push(bullet('New goal: ' + m3.improveGoal));
    if (has(m3.improveKeep)) blocks.push(bullet('Keep: ' + m3.improveKeep));
    if (has(m3.openToChanges2)) blocks.push(bullet('Open to changes: ' + m3.openToChanges2));

    // Thank You page (moved here from Module 1)
    if (has(m3.typage)) blocks.push(bullet('Thank You page points to: ' + m3.typage));
    if (has(m3.tyoffer)) blocks.push(bullet('Low-ticket offer: ' + m3.tyoffer));

    const pdf = m3.pdfUpload as Record<string, string> | undefined;
    if (pdf?.url) blocks.push(bookmark(pdf.url, '📄 Lead Magnet PDF: ' + (pdf.name || 'download')));
    else if (pdf?.name) blocks.push(bullet('📄 PDF uploaded: ' + pdf.name + ' (link unavailable — check Supabase Storage)'));

    if (m3History.length > 0) {
      blocks.push(h3('💬 Lead Magnet Conversation — Module 3'));
      blocks.push(...conversationBlocks(m3History));
    }
    blocks.push(divider());
  }

  // ── Module 4 — voice, assets + full transcript ──
  const m4History = await fetchTranscript(email, 'm4');
  const hasM4Assets = has(m4.writingSamples) || has(m4.testimonials) || has(m4.resources);
  if (m4History.length > 0 || hasM4Assets) {
    blocks.push(h2('✍️ Voice + Email Intel'));
    if (has(m4.writingSamples)) {
      blocks.push(h3('📝 Writing Samples'));
      for (const chunk of splitText(m4.writingSamples, 1900)) blocks.push(paragraph(rt(chunk)));
    }
    if (has(m4.testimonials)) {
      blocks.push(h3('💛 Testimonials'));
      for (const chunk of splitText(m4.testimonials, 1900)) blocks.push(paragraph(rt(chunk)));
    }
    if (has(m4.resources)) {
      blocks.push(h3('🔗 Resources to Link'));
      for (const chunk of splitText(m4.resources, 1900)) blocks.push(paragraph(rt(chunk)));
    }
    if (m4History.length > 0) {
      blocks.push(h3('💬 Full Conversation — Module 4'));
      blocks.push(...conversationBlocks(m4History));
    }
    blocks.push(divider());
  }

  // ── Platform access ──
  blocks.push(h2('📋 Platform Access'));
  const stuck = (client.fb_access_answers || {}) as Record<string, boolean>;
  blocks.push(bullet('Website access: ' + (client.access_website ? '✅ Confirmed' : (stuck.website ? '🆘 CLIENT NEEDS HELP — reach out' : '⏳ Pending'))));
  blocks.push(bullet('Email platform access: ' + (client.access_email ? '✅ Confirmed' : (stuck.email ? '🆘 CLIENT NEEDS HELP — reach out' : '⏳ Pending'))));
  blocks.push(bullet('Meta / Facebook access: handled separately via the access link'));

  for (let i = 0; i < blocks.length; i += 100) {
    const r = await fetch(`${NOTION_API}/blocks/${pageId}/children`, {
      method: 'PATCH', headers: nHeaders,
      body: JSON.stringify({ children: blocks.slice(i, i + 100) })
    });
    if (!r.ok) console.error('Block append failed:', r.status, await r.text());
  }
}

async function syncToNotion(body: Record<string, unknown>): Promise<string> {
  let pageId = await findClientPage(String(body.email));
  if (!pageId) pageId = await createClientPage(body);
  else await updateClientPage(pageId, body);
  await rebuildPageContent(pageId, body);
  return pageId;
}

// ── Main ──────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const body = await req.json();

    // AI PROXY — if request has 'messages', route to Anthropic
    if (body.messages) {
      const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY');
      if (!ANTHROPIC_KEY) return json({ error: 'ANTHROPIC_API_KEY secret not set in Supabase' }, 500);

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: body.model || 'claude-sonnet-4-6',
          max_tokens: body.max_tokens || 1000,
          system: body.system || '',
          messages: body.messages
        })
      });
      const data = await r.json();
      if (!r.ok) {
        console.error('Anthropic error:', r.status, data);
        return json({ error: data?.error?.message || 'Anthropic request failed', detail: data }, r.status);
      }
      return json(data);
    }

    // NOTION SYNC — route client record to Notion
    if (!body?.email) return json({ error: 'Missing email' }, 400);
    if (!NOTION_TOKEN) return json({ error: 'NOTION_TOKEN secret not set in Supabase' }, 500);

    const key = String(body.email);
    // Wait for any sync already running for this client rather than skipping
    // this one — a dropped write used to leave Notion permanently stale.
    const previous = inFlight.get(key);
    if (previous) { try { await previous; } catch (_) { /* its own error is already logged */ } }

    let pageId = '';
    const run = (async () => { pageId = await syncToNotion(body); })();
    inFlight.set(key, run);
    try { await run; } finally { if (inFlight.get(key) === run) inFlight.delete(key); }

    return json({ success: true, notion_page_url: 'https://notion.so/' + pageId.replace(/-/g, '') });

  } catch (err) {
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});
