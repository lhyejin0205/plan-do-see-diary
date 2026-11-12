module.exports = async (req, res) => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    return res.status(500).json({ ok: false, error: 'missing env' });
  }

  const headers = { apikey: key };
  if (key.startsWith('eyJ')) {
    headers.Authorization = 'Bearer ' + key;
  }

  try {
    const r = await fetch(url + '/rest/v1/plans?select=id&limit=1', { headers });
    return res.status(200).json({ ok: r.ok, status: r.status });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'fetch failed' });
  }
};
