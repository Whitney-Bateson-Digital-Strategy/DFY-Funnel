// ============================================================
// Whitney Bateson DFY Funnel — Supabase Edge Function
// Handles: AI chat proxy + Notion sync
// Deploy to: supabase/functions/notion-sync/index.ts
// Secrets needed: ANTHROPIC_API_KEY
// ============================================================

const NOTION_TOKEN = 'ntn_b98334986092CH2D9S2JVBogM6N494tzx8fLBV6r7gT47o';

// Simple in-memory debounce — prevents duplicate writes within 5 seconds
const recentWrites = new Map<string, number>();
function isDebounced(email: string): boolean {
  const last = recentWrites.get(email) || 0;
  const now = Date.now();
  if (now - last < 5000) return true;
  recentWrites.set(email, now);
  return false;
}
const NOTION_DB_ID = 'bfdacfc5b8ee4b9cbc5dd984737a2135';
const NOTION_API   = 'https://api.notion.com/v1';

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
function callout(text: string, emoji: string) {
  return { object: 'block', type: 'callout', callout: { rich_text: rt(text), icon: { type: 'emoji', emoji }, color: 'gray_background' } };
}
function paragraph(richText: unknown[]) {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: richText } };
}
function quote(richText: unknown[]) {
  return { object: 'block', type: 'quote', quote: { rich_text: richText } };
}

// Convert a conversation history array into readable Notion blocks
function conversationBlocks(history: Array<{ role: string; content: string }>): unknown[] {
  const blocks: unknown[] = [];
  for (const msg of history) {
    // Skip hidden system context messages
    if (msg.role === 'user' && (
      msg.content.includes("client's name is") ||
      msg.content.includes('REFINE_MODE') ||
      msg.content.includes('WRAP_UP_NOW')
    )) continue;

    // Strip summary markers from assistant messages for display
    let content = msg.content;
    content = content.replace(/---ICA_SUMMARY_START---[\s\S]*?---ICA_SUMMARY_END---/g, '').trim();
    content = content.replace(/---VOICE_SUMMARY_START---[\s\S]*?---VOICE_SUMMARY_END---/g, '').trim();
    if (!content) continue;

    if (msg.role === 'assistant') {
      // Sam's messages — split into 2000-char chunks if needed
      const chunks = splitText(content, 1900);
      for (let i = 0; i < chunks.length; i++) {
        if (i === 0) {
          blocks.push(quote(rtBold('Sam: ', chunks[i])));
        } else {
          blocks.push(quote(rt(chunks[i])));
        }
      }
    } else {
      // Client's messages
      const chunks = splitText(content, 1900);
      for (let i = 0; i < chunks.length; i++) {
        if (i === 0) {
          blocks.push(paragraph(rtBold('Client: ', chunks[i])));
        } else {
          blocks.push(paragraph(rt(chunks[i])));
        }
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
    // Try to split at a sentence or word boundary
    let splitAt = remaining.lastIndexOf('. ', maxLen);
    if (splitAt < maxLen / 2) splitAt = remaining.lastIndexOf(' ', maxLen);
    if (splitAt < maxLen / 2) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt + 1));
    remaining = remaining.slice(splitAt + 1);
  }
  return chunks;
}

async function findClientPage(email: string): Promise<string | null> {
  const r = await fetch(`${NOTION_API}/databases/${NOTION_DB_ID}/query`, {
    method: 'POST', headers: nHeaders,
    body: JSON.stringify({ filter: { property: 'Email', email: { equals: email } } })
  });
  const d = await r.json();
  return d.results?.[0]?.id ?? null;
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
  };
  if (m1.bizname) props['Business Name'] = { rich_text: rt(m1.bizname) };
  if (m1.practype) props['Practice Type'] = { select: { name: m1.practype } };
  if (m1.website) props['Website'] = { url: m1.website };
  if (m1.webplatform) props['Website Platform'] = { rich_text: rt(m1.webplatform) };
  if (m1.esp) props['Email Platform'] = { rich_text: rt(m1.esp) };
  if (m1.offer) props['Main Offer'] = { rich_text: rt(m1.offer) };

  const r = await fetch(`${NOTION_API}/pages`, {
    method: 'POST', headers: nHeaders,
    body: JSON.stringify({ parent: { database_id: NOTION_DB_ID }, icon: { type: 'emoji', emoji: '🌿' }, properties: props })
  });
  const page = await r.json();
  return page.id;
}

async function updateClientPage(pageId: string, client: Record<string, unknown>) {
  const m1 = (client.m1_data || {}) as Record<string, string>;
  const modMap: Record<string, string> = { todo: 'Not Started', inprogress: 'In Progress', done: 'Complete', locked: 'Not Started' };
  const s1 = String(client.module_1_status || 'todo');
  const s2 = String(client.module_2_status || 'locked');
  const s3 = String(client.module_3_status || 'locked');
  const s4 = String(client.module_4_status || 'locked');

  let overall = 'New';
  if ([s1,s2,s3,s4].every(s => s === 'done')) overall = 'All Modules Complete';
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
  };
  if (m1.bizname) props['Business Name'] = { rich_text: rt(m1.bizname) };
  if (m1.practype) props['Practice Type'] = { select: { name: m1.practype } };
  if (m1.website) props['Website'] = { url: m1.website };
  if (m1.webplatform) props['Website Platform'] = { rich_text: rt(m1.webplatform) };
  if (m1.esp) props['Email Platform'] = { rich_text: rt(m1.esp) };
  if (m1.offer) props['Main Offer'] = { rich_text: rt(m1.offer) };

  await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: 'PATCH', headers: nHeaders, body: JSON.stringify({ properties: props })
  });
}

async function rebuildPageContent(pageId: string, client: Record<string, unknown>) {
  const existing = await fetch(`${NOTION_API}/blocks/${pageId}/children`, { headers: nHeaders });
  const exData = await existing.json();
  for (const block of (exData.results || [])) {
    await fetch(`${NOTION_API}/blocks/${block.id}`, { method: 'DELETE', headers: nHeaders });
  }

  const blocks: unknown[] = [];
  const m1 = (client.m1_data || {}) as Record<string, string>;
  const m2 = (client.m2_data || {}) as Record<string, unknown>;
  const m3 = (client.m3_data || {}) as Record<string, string>;
  const m4 = (client.m4_data || {}) as Record<string, unknown>;

  const s1 = String(client.module_1_status || '');
  if (s1 === 'done' || s1 === 'inprogress') {
    blocks.push(h2('🏢 Business + Funnel Basics'));
    if (m1.bizname) blocks.push(bullet('Business: ' + m1.bizname));
    if (m1.practype) blocks.push(bullet('Practice type: ' + m1.practype));
    if (m1.website) blocks.push(bullet('Website: ' + m1.website));
    if (m1.years) blocks.push(bullet('In business: ' + m1.years));
    if (m1.offer) blocks.push(bullet('Main offer: ' + m1.offer));
    if (m1.offercta) blocks.push(bullet('Offer CTA: ' + m1.offercta));
    if (m1.typage) blocks.push(bullet('Thank You page: ' + m1.typage));
    if (m1.tyoffer) blocks.push(bullet('TY offer: ' + m1.tyoffer));
    if (m1.esp) blocks.push(bullet('Email platform: ' + m1.esp));
    if (m1.webplatform) blocks.push(bullet('Website platform: ' + m1.webplatform));
    if (m1.listsize) blocks.push(bullet('List size: ' + m1.listsize));
    if (m1.notes) blocks.push(callout(m1.notes, '💬'));
    blocks.push(divider());
  }

  // Module 2 — ICA Summary + full conversation transcript
  const icaSummary = m2.summary as string;
  const m2History = (m2.history || []) as Array<{ role: string; content: string }>;
  if (icaSummary || m2History.length > 0) {
    blocks.push(h2('👤 Ideal Client Avatar'));
    if (icaSummary) {
      blocks.push(callout(icaSummary, '✨'));
    }
    if (m2History.length > 0) {
      blocks.push(h3('💬 Full Conversation — Module 2'));
      blocks.push(...conversationBlocks(m2History));
    }
    blocks.push(divider());
  }

  const s3 = String(client.module_3_status || '');
  if (s3 === 'done' || s3 === 'inprogress') {
    blocks.push(h2('🧲 Lead Magnet'));
    if (m3.hadLm) blocks.push(bullet('Had LM before: ' + m3.hadLm));
    if (m3.pastLm) blocks.push(bullet('Past LM: ' + m3.pastLm));
    if (m3.pastLmWhy) blocks.push(bullet("Why it didn't work: " + m3.pastLmWhy));
    if (m3.choice) blocks.push(bullet('Campaign choice: ' + m3.choice));
    if (m3.lmTopic) blocks.push(bullet('Topic: ' + m3.lmTopic));
    if (m3.lmFormat) blocks.push(bullet('Format: ' + m3.lmFormat));
    if (m3.lmCta) blocks.push(bullet('CTA: ' + m3.lmCta));
    if (m3.lmTransformation) blocks.push(bullet('Transformation: ' + m3.lmTransformation));
    if (m3.existingName) blocks.push(bullet('Existing LM: ' + m3.existingName));
    if (m3.existingLink) blocks.push(bullet('Canva / hosted link: ' + m3.existingLink));
    if (m3.existingWorking) blocks.push(bullet('What works: ' + m3.existingWorking));
    if (m3.existingFreshen) blocks.push(bullet('To freshen: ' + m3.existingFreshen));
    if (m3.openToChanges) blocks.push(bullet('Open to changes: ' + m3.openToChanges));
    if (m3.improveName) blocks.push(bullet('Improving: ' + m3.improveName));
    if (m3.improveLink) blocks.push(bullet('Canva / hosted link: ' + m3.improveLink));
    if (m3.improveIssues) blocks.push(bullet('Issues: ' + m3.improveIssues));
    if (m3.improveGoal) blocks.push(bullet('New goal: ' + m3.improveGoal));
    if (m3.improveKeep) blocks.push(bullet('Keep: ' + m3.improveKeep));
    if (m3.openToChanges2) blocks.push(bullet('Open to changes: ' + m3.openToChanges2));
    // PDF upload link
    const pdf = m3.pdfUpload as Record<string, string> | undefined;
    if (pdf && pdf.url) {
      blocks.push({
        object: 'block', type: 'bookmark',
        bookmark: { url: pdf.url, caption: rt('📄 Lead Magnet PDF: ' + (pdf.name || 'download')) }
      });
    } else if (pdf && pdf.name) {
      blocks.push(bullet('📄 PDF uploaded: ' + pdf.name + ' (link unavailable — check Supabase Storage)'));
    }
    blocks.push(divider());
  }

  // Module 4 — full conversation transcript (summary is now just a brief confirmation)
  const m4History = (m4.history || []) as Array<{ role: string; content: string }>;
  if (m4History.length > 0) {
    blocks.push(h2('✍️ Voice + Email Intel'));
    blocks.push(h3('💬 Full Conversation — Module 4'));
    blocks.push(...conversationBlocks(m4History));
    blocks.push(divider());
  }

  blocks.push(h2('📋 Platform Access'));
  blocks.push(bullet('Website access: ' + (client.access_website ? '✅ Confirmed' : '⏳ Pending')));
  blocks.push(bullet('Email platform access: ' + (client.access_email ? '✅ Confirmed' : '⏳ Pending')));
  blocks.push(bullet('Facebook Ads access: ' + (client.access_fb ? '✅ Confirmed' : '⏳ Pending')));
  const fbAnswers = client.fb_access_answers as Record<string, string> | null;
  if (fbAnswers) {
    blocks.push(bullet('Has business FB page: ' + (fbAnswers.hasPage || '—')));
    blocks.push(bullet('Has Meta Business account: ' + (fbAnswers.hasMeta || '—')));
    blocks.push(bullet('Has ad account: ' + (fbAnswers.hasAdAccount || '—')));
  }

  for (let i = 0; i < blocks.length; i += 100) {
    await fetch(`${NOTION_API}/blocks/${pageId}/children`, {
      method: 'PATCH', headers: nHeaders,
      body: JSON.stringify({ children: blocks.slice(i, i + 100) })
    });
  }
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
          model: body.model || 'claude-sonnet-4-20250514',
          max_tokens: body.max_tokens || 1000,
          system: body.system || '',
          messages: body.messages
        })
      });
      const data = await r.json();
      return json(data);
    }

    // NOTION SYNC — route client record to Notion
    if (!body?.email) return json({ error: 'Missing email' }, 400);
    // Skip if this email was synced within the last 5 seconds (debounce)
    if (isDebounced(String(body.email))) {
      return json({ success: true, skipped: true, reason: 'debounced' });
    }
    let pageId = await findClientPage(String(body.email));
    if (!pageId) pageId = await createClientPage(body);
    else await updateClientPage(pageId, body);
    await rebuildPageContent(pageId, body);

    return json({ success: true, notion_page_url: 'https://notion.so/' + pageId.replace(/-/g, '') });

  } catch (err) {
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});
