// netlify/functions/scheduled-cleanup-pending.js
// Cron toutes les 5 minutes pour nettoyer les orders pending coincés

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

exports.handler = async (event) => {
  try {
    if (!SUPABASE_URL || !SUPA_SERVICE_KEY) {
      console.error('[cleanup] Missing Supabase config');
      return { statusCode: 500, body: 'CONFIG_MISSING' };
    }

    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL, SUPA_SERVICE_KEY, { auth: { persistSession: false } });

    const now = new Date();
    const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000);

    console.log('[cleanup] Starting cleanup at', now.toISOString());

    // 1) Trouver tous les pending > 30 min
    const { data: staleOrders, error: fetchErr } = await supabase
      .from('orders')
      .select('order_id, region_id, blocks, created_at, expires_at')
      .eq('status', 'pending')
      .lt('created_at', thirtyMinAgo.toISOString());

    if (fetchErr) {
      console.error('[cleanup] Fetch error:', fetchErr);
      return { statusCode: 500, body: 'FETCH_ERROR' };
    }

    if (!staleOrders || staleOrders.length === 0) {
      console.log('[cleanup] No stale orders found');
      return { statusCode: 200, body: JSON.stringify({ cleaned: 0 }) };
    }

    console.log(`[cleanup] Found ${staleOrders.length} stale pending orders`);

    let expired = 0;
    let completed = 0;
    let failed = 0;

    for (const order of staleOrders) {
      const orderId = order.order_id;
      const regionId = order.region_id;

      // Si region_id existe, vérifier si cells sont vendues
      if (regionId) {
        const { count: soldCount } = await supabase
          .from('cells')
          .select('idx', { count: 'exact', head: true })
          .eq('region_id', regionId)
          .not('sold_at', 'is', null);

        if ((soldCount || 0) > 0) {
          // Des cells sont vendues → marquer completed
          await supabase.from('orders').update({
            status: 'completed',
            updated_at: now.toISOString()
          }).eq('order_id', orderId);
          
          console.log(`[cleanup] Marked ${orderId} as completed (${soldCount} cells sold)`);
          completed++;
          continue;
        }
      }

      // Vérifier si expires_at dépassé → expired
      if (order.expires_at && new Date(order.expires_at) < now) {
        await supabase.from('orders').update({
          status: 'expired',
          fail_reason: 'TIMEOUT_EXPIRED',
          updated_at: now.toISOString()
        }).eq('order_id', orderId);
        
        console.log(`[cleanup] Marked ${orderId} as expired`);
        expired++;
        continue;
      }

      // Sinon → failed (abandon sans expiration explicite)
      await supabase.from('orders').update({
        status: 'failed',
        fail_reason: 'TIMEOUT_ABANDONED',
        updated_at: now.toISOString()
      }).eq('order_id', orderId);
      
      console.log(`[cleanup] Marked ${orderId} as failed (abandoned)`);
      failed++;
    }

    const summary = { 
      total: staleOrders.length,
      expired,
      completed,
      failed,
      timestamp: now.toISOString()
    };

    console.log('[cleanup] Summary:', summary);

    return {
      statusCode: 200,
      body: JSON.stringify(summary)
    };

  } catch (e) {
    console.error('[cleanup] Error:', e);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: String(e.message || e) })
    };
  }
};