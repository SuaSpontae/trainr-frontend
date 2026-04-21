const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ limit: '10mb' }));

app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey, x-api-key');
  res.sendStatus(200);
});

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey, x-api-key');
  next();
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const WHOOP_CLIENT_ID = 'becc7571-7164-42ff-b3ed-d01c2f300e46';
const WHOOP_CLIENT_SECRET = '75bc0939c0cad3e6f8ab05d92b69fc5de8d78b83ac566a528294ea8dd9903b26';
const WHOOP_REDIRECT_URI = 'https://health-receiver-production.up.railway.app/whoop/callback';
const WHOOP_SCOPES = 'read:recovery read:sleep read:workout read:body_measurement read:cycles offline';

app.get('/', (req, res) => {
  res.json({ status: 'health-receiver running', whoop: 'enabled', claude: 'enabled' });
});

// Claude API proxy
app.post('/claude', async (req, res) => {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.json(data);
  } catch(err) {
    console.error('Claude proxy error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Whoop OAuth
app.get('/whoop/auth', (req, res) => {
  const state = require('crypto').randomBytes(16).toString('hex');
  const url = `https://api.prod.whoop.com/oauth/oauth2/auth` +
    `?client_id=${WHOOP_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(WHOOP_REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(WHOOP_SCOPES)}` +
    `&state=${state}`;
  res.redirect(url);
});

app.get('/whoop/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code received');
  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: WHOOP_CLIENT_ID,
      client_secret: WHOOP_CLIENT_SECRET,
      redirect_uri: WHOOP_REDIRECT_URI,
    });
    const tokenRes = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) return res.status(500).send('Failed to get token: ' + JSON.stringify(tokens));

    await supabase.from('whoop_tokens').upsert({
      id: 1,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    }, { onConflict: 'id' });

    res.send(`<html><body style="font-family:sans-serif;padding:40px;max-width:500px;margin:auto">
      <h2>Whoop connected</h2><p>Data will sync daily. You can close this window.</p>
    </body></html>`);
    await syncWhoopData(tokens.access_token);
  } catch (err) {
    res.status(500).send('OAuth error: ' + err.message);
  }
});

async function getWhoopToken() {
  const { data } = await supabase.from('whoop_tokens').select('*').eq('id', 1).single();
  if (!data) return null;
  if (new Date(data.expires_at) < new Date(Date.now() + 5 * 60 * 1000)) {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: data.refresh_token,
      client_id: WHOOP_CLIENT_ID,
      client_secret: WHOOP_CLIENT_SECRET,
    });
    const tokenRes = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const tokens = await tokenRes.json();
    if (tokens.access_token) {
      await supabase.from('whoop_tokens').upsert({
        id: 1,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      }, { onConflict: 'id' });
      return tokens.access_token;
    }
  }
  return data.access_token;
}

async function syncWhoopData(token) {
  try {
    const headers = { 'Authorization': `Bearer ${token}` };
    const days = parseInt(process.env.WHOOP_SYNC_DAYS || '7');
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceStr = since.toISOString();

    const [recoveryRes, sleepRes, cycleRes] = await Promise.all([
      fetch(`https://api.prod.whoop.com/developer/v2/recovery?start=${sinceStr}&limit=25`, { headers }),
      fetch(`https://api.prod.whoop.com/developer/v2/activity/sleep?start=${sinceStr}&limit=25`, { headers }),
      fetch(`https://api.prod.whoop.com/developer/v2/cycle?start=${sinceStr}&limit=25`, { headers }),
    ]);

    console.log('Whoop API:', recoveryRes.status, sleepRes.status, cycleRes.status);

    const safeJson = async (r) => { try { return await r.json(); } catch(e) { return { records: [] }; } };
    const [recoveries, sleeps, cycles] = await Promise.all([safeJson(recoveryRes), safeJson(sleepRes), safeJson(cycleRes)]);

    const recoveryByDate = {};
    for (const r of (recoveries.records || [])) {
      const date = (r.created_at || r.start)?.split('T')[0];
      if (date) recoveryByDate[date] = r;
    }
    const sleepByDate = {};
    for (const s of (sleeps.records || [])) {
      if (s.nap) continue;
      const date = s.start?.split('T')[0];
      if (date) sleepByDate[date] = s;
    }
    const strainByDate = {};
    for (const c of (cycles.records || [])) {
      const date = c.start?.split('T')[0];
      if (date) strainByDate[date] = c;
    }

    const allDates = new Set([...Object.keys(recoveryByDate), ...Object.keys(sleepByDate), ...Object.keys(strainByDate)]);
    const toHrs = (ms) => ms ? Math.round(ms / 1000 / 36) / 100 : null;

    for (const date of allDates) {
      const r = recoveryByDate[date];
      const s = sleepByDate[date];
      const c = strainByDate[date];
      const ss = s?.score?.stage_summary || {};
      const sn = s?.score?.sleep_needed || {};

      const update = {
        date,
        // Recovery
        whoop_recovery_score: r?.score?.recovery_score ?? null,
        hrv_ms: r?.score?.hrv_rmssd_milli ?? null,
        resting_hr: r?.score?.resting_heart_rate ?? null,
        spo2_percentage: r?.score?.spo2_percentage ?? null,
        skin_temp_celsius: r?.score?.skin_temp_celsius ?? null,
        user_calibrating: r?.score?.user_calibrating ?? null,
        // Cycle
        whoop_strain: c?.score?.strain ?? null,
        whoop_kilojoules: c?.score?.kilojoule ?? null,
        whoop_avg_hr: c?.score?.average_heart_rate ?? null,
        whoop_max_hr: c?.score?.max_heart_rate ?? null,
        // Sleep stages
        sleep_total_hrs: toHrs(ss.total_in_bed_time_milli),
        sleep_deep_hrs: toHrs(ss.total_slow_wave_sleep_time_milli),
        sleep_rem_hrs: toHrs(ss.total_rem_sleep_time_milli),
        sleep_light_hrs: toHrs(ss.total_light_sleep_time_milli),
        sleep_awake_hrs: toHrs(ss.total_awake_time_milli),
        sleep_cycles: ss.sleep_cycle_count ?? null,
        sleep_disturbances: ss.disturbance_count ?? null,
        // Sleep scores
        whoop_sleep_performance: s?.score?.sleep_performance_percentage ?? null,
        sleep_consistency_pct: s?.score?.sleep_consistency_percentage ?? null,
        sleep_efficiency_pct: s?.score?.sleep_efficiency_percentage ?? null,
        sleep_respiratory_rate: s?.score?.respiratory_rate ?? null,
        // Sleep needed
        sleep_needed_baseline_hrs: toHrs(sn.baseline_milli),
        sleep_needed_from_debt_hrs: toHrs(sn.need_from_sleep_debt_milli),
        sleep_needed_from_strain_hrs: toHrs(sn.need_from_recent_strain_milli),
      };

      const clean = Object.fromEntries(Object.entries(update).filter(([_, v]) => v !== null && v !== undefined));
      if (Object.keys(clean).length > 1) {
        await supabase.from('health_history').upsert(clean, { onConflict: 'date' });
        console.log(`Whoop synced ${date}: HRV=${update.hrv_ms} recovery=${update.whoop_recovery_score} SpO2=${update.spo2_percentage} skin=${update.skin_temp_celsius}`);
      }
    }
  } catch (err) {
    console.error('Whoop sync error:', err.message);
  }
}

app.get('/whoop/sync', async (req, res) => {
  const token = await getWhoopToken();
  if (!token) return res.status(400).json({ error: 'Whoop not connected. Visit /whoop/auth first.' });
  await syncWhoopData(token);
  res.json({ success: true, message: 'Whoop sync complete' });
});

// Apple Health Auto Export receiver
app.post('/health', async (req, res) => {
  try {
    const payload = req.body;
    const receivedAt = new Date().toISOString();
    const metrics = payload?.data?.metrics || [];
    const workouts = payload?.data?.workouts || [];

    const metricRows = [];
    for (const metric of metrics) {
      for (const point of (metric.data || [])) {
        metricRows.push({
          received_at: receivedAt,
          metric_name: metric.name,
          unit: metric.units,
          date: point.date || null,
          qty: point.qty ?? null,
          min: point.Min ?? null,
          max: point.Max ?? null,
          avg: point.Avg ?? null,
          source: point.source || null,
        });
      }
    }

    const workoutMap = new Map();
    for (const w of workouts) {
      const existing = workoutMap.get(w.start);
      if (!existing || (w.distance?.qty && !existing.distance?.qty)) workoutMap.set(w.start, w);
    }

    const workoutRows = Array.from(workoutMap.values()).map(w => ({
      received_at: receivedAt,
      workout_type: w.name || null,
      start: w.start || null,
      end: w.end || null,
      duration_minutes: w.duration ? Math.round(w.duration / 60) : null,
      distance_miles: w.distance?.qty ?? null,
      distance_km: w.distance?.qty ? w.distance.qty * 1.60934 : null,
      energy_burned_kcal: w.activeEnergyBurned?.qty ?? null,
      heart_rate_avg: w.heartRate?.avg?.qty ?? null,
      heart_rate_min: w.heartRate?.min?.qty ?? null,
      heart_rate_max: w.heartRate?.max?.qty ?? null,
      max_heart_rate: w.maxHeartRate?.qty ?? null,
    }));

    const historyByDate = new Map();
    const metricMap = {
      resting_heart_rate: 'resting_hr',
      respiratory_rate: 'respiratory_rate',
      blood_oxygen_saturation: 'blood_oxygen_pct',
      active_energy: 'active_energy_kcal',
      step_count: 'step_count',
      flights_climbed: 'flights_climbed',
      walking_running_distance: 'total_distance_miles',
    };

    for (const metric of metrics) {
      const field = metricMap[metric.name];
      if (!field) continue;
      for (const point of (metric.data || [])) {
        const date = point.date?.split(' ')[0];
        if (!date || !point.qty) continue;
        if (!historyByDate.has(date)) historyByDate.set(date, { date });
        const entry = historyByDate.get(date);
        entry[field] = (field === 'step_count' || field === 'flights_climbed') ? Math.round(point.qty) : point.qty;
      }
    }

    const sleepMetric = metrics.find(m => m.name === 'sleep_analysis');
    if (sleepMetric) {
      for (const point of (sleepMetric.data || [])) {
        const date = point.date?.split(' ')[0];
        if (!date || !point.qty) continue;
        if (!historyByDate.has(date)) historyByDate.set(date, { date });
        historyByDate.get(date).sleep_total_hrs = point.qty;
      }
    }

    for (const w of workoutMap.values()) {
      if (!w.name?.toLowerCase().includes('run') || !w.distance?.qty) continue;
      const date = (w.start || '').split('T')[0].split(' ')[0];
      if (!date) continue;
      if (!historyByDate.has(date)) historyByDate.set(date, { date });
      const entry = historyByDate.get(date);
      entry.run_distance_miles = Math.round(((entry.run_distance_miles || 0) + w.distance.qty) * 100) / 100;
    }

    if (metricRows.length > 0) {
      const { error } = await supabase.from('health_metrics').insert(metricRows);
      if (error) console.error('Metrics error:', error.message);
    }
    if (workoutRows.length > 0) {
      const { error } = await supabase.from('health_workouts').insert(workoutRows);
      if (error) console.error('Workouts error:', error.message);
    }
    for (const entry of historyByDate.values()) {
      const { error } = await supabase.from('health_history').upsert(entry, { onConflict: 'date' });
      if (error) console.error('History error:', error.message);
    }

    getWhoopToken().then(token => { if (token) syncWhoopData(token).catch(console.error); });

    console.log(`Stored: ${metricRows.length} metrics, ${workoutRows.length} workouts, ${historyByDate.size} history rows`);
    res.json({ success: true, metrics_stored: metricRows.length, workouts_stored: workoutRows.length, history_rows: historyByDate.size });

  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Health receiver listening on port ${PORT}`));
