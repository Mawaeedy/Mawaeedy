const config = require('../config');

function supabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase server configuration is missing.');
  return { url: url.replace(/\/$/, ''), key };
}

async function request(table, options = {}) {
  const { url, key } = supabaseConfig();
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(options.headers || {}) };
  const response = await fetch(`${url}/rest/v1/${table}${options.query || ''}`, { ...options, headers });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${body?.message || body?.hint || body || 'request failed'}`);
  return body;
}

const list = (table, query = '?select=*') => request(table, { query });
const insert = (table, values) => request(table, { method: 'POST', query: '?select=*', headers: { Prefer: 'return=representation' }, body: JSON.stringify(values) });
const update = (table, values, query) => request(table, { method: 'PATCH', query, headers: { Prefer: 'return=representation' }, body: JSON.stringify(values) });
const remove = (table, query) => request(table, { method: 'DELETE', query, headers: { Prefer: 'return=representation' } });

module.exports = { request, list, insert, update, remove };
