// netlify/functions/sb-ping.js
exports.handler = async () => {
  try {
    // import dynamique (compatible avec require/exports.handler)
    const { createClient } = await import('@supabase/supabase-js');

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } }
    );

    // Simple requête: compte les lignes dans "orders"
    const { error } = await supabase
      .from('orders')
      .select('id', { count: 'exact', head: true });

    if (error) throw error;

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true, msg: 'Supabase OK' })
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: false, error: String(e?.message || e) })
    };
  }
};
