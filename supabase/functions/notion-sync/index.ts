// ============================================================
// Whitney Bateson DFY Funnel — notion-sync Edge Function
// Handles: AI chat proxy + Supabase save ONLY
// Notion sync is handled separately by the notion-writer function,
// which fires from a database webhook on the clients table.
// Deploy to: supabase/functions/notion-sync/index.ts
// Secrets needed: ANTHROPIC_API_KEY, SUPABASE_SERVICE_ROLE_KEY
//
// This file mirrors what is deployed. It was previously out of sync with
// production — the repo held an older single-function design that also
// wrote to Notion, which had not run for a long time.
// ============================================================

const SUPABASE_URL = 'https://rguqefwhlzehpzgljbdo.supabase.co';

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

async function saveToSupabase(client: Record<string, unknown>) {
  const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_KEY) {
    console.error('SUPABASE_SERVICE_ROLE_KEY secret is not set');
    return false;
  }

  const r = await fetch(`${SUPABASE_URL}/rest/v1/clients?on_conflict=email`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates',
    },
    body: JSON.stringify({
      email:             client.email,
      module_1_status:   client.module_1_status  || 'todo',
      module_2_status:   client.module_2_status  || 'locked',
      module_3_status:   client.module_3_status  || 'locked',
      module_4_status:   client.module_4_status  || 'locked',
      access_website:    client.access_website   || false,
      access_email:      client.access_email     || false,
      access_fb:         client.access_fb        || false,
      submitted:         client.submitted         || false,
      m1_data:           client.m1_data           || {},
      m2_data:           client.m2_data           || {},
      m3_data:           client.m3_data           || {},
      m4_data:           client.m4_data           || {},
      fb_access_answers: client.fb_access_answers || null,
      updated_at:        new Date().toISOString(),
    })
  });

  if (!r.ok) {
    const err = await r.text();
    console.error('Supabase save failed:', r.status, err);
    return false;
  }

  console.log('Supabase save successful for:', client.email);
  return true;
}

// ── Main ──────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const body = await req.json();

    // ── AI PROXY ── if request has 'messages', route to Anthropic
    if (body.messages) {
      const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY');
      if (!ANTHROPIC_KEY) return json({ error: 'ANTHROPIC_API_KEY secret not set' }, 500);

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model:      body.model      || 'claude-sonnet-4-20250514',
          max_tokens: body.max_tokens || 1000,
          system:     body.system     || '',
          messages:   body.messages
        })
      });
      const data = await r.json();
      return json(data);
    }

    // ── SUPABASE SAVE ──
    if (!body?.email) return json({ error: 'Missing email' }, 400);

    const saved = await saveToSupabase(body);
    if (!saved) {
      return json({ error: 'Failed to save to Supabase' }, 500);
    }

    // Notion sync is handled automatically by the database webhook,
    // which triggers the notion-writer function after every save.
    return json({ success: true, message: 'Saved' });

  } catch (err) {
    console.error('notion-sync error:', err);
    return json({ error: String(err) }, 500);
  }
});
