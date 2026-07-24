// Netlify Function: proxies RSVP reads/writes to jsonbin.io so the
// jsonbin.io master key never ships to the browser.
//
// Required environment variables — set these in Netlify's dashboard under
// Site settings -> Environment variables (NOT in a committed .env file):
//   JSONBIN_API_KEY  - your jsonbin.io X-Master-Key
//   JSONBIN_BIN_ID   - the bin ID that stores { rsvps: [...] }
//
// The browser calls /api/rsvp (see netlify.toml redirect) with:
//   GET  -> returns { rsvps: [...] }
//   POST -> body { nama, konfirmasi, pesan }, appends a new RSVP entry and
//           returns the updated { rsvps: [...] }
//
// NOTE: the previous version of this project put the jsonbin.io master key
// directly in metatah.html's CONFIG object, which means it was exposed to
// anyone viewing the page source. That key should be treated as compromised
// — revoke/regenerate it at https://jsonbin.io/api-keys and put the NEW key
// only in Netlify's env vars, never in the HTML.

const JSONBIN_BASE = "https://api.jsonbin.io/v3/b";
const REV_KEY = "__rev"; // internal optimistic-concurrency counter, stored inside the bin
const VALID_ATTENDANCE = ["Hadir", "Tidak Hadir", "Masih Ragu"];

function jsonbinHeaders(extra = {}) {
  return {
    "Content-Type": "application/json",
    "X-Master-Key": process.env.JSONBIN_API_KEY,
    ...extra,
  };
}

async function readBin(binId) {
  const res = await fetch(`${JSONBIN_BASE}/${binId}`, { headers: jsonbinHeaders() });
  if (!res.ok) throw new Error(`jsonbin read failed: ${res.status}`);
  return res.json();
}

async function writeBin(binId, data) {
  const res = await fetch(`${JSONBIN_BASE}/${binId}`, {
    method: "PUT",
    headers: jsonbinHeaders({ "X-Bin-Versioning": "false" }),
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`jsonbin write failed: ${res.status}`);
  return res.json();
}

exports.handler = async (event) => {
  const binId = process.env.JSONBIN_BIN_ID;
  const jsonHeaders = { "Content-Type": "application/json" };

  if (!process.env.JSONBIN_API_KEY || !binId) {
    return {
      statusCode: 500,
      headers: jsonHeaders,
      body: JSON.stringify({ error: "Server not configured: set JSONBIN_API_KEY and JSONBIN_BIN_ID in Netlify env vars" }),
    };
  }

  // ---- GET: return current RSVPs ----
  if (event.httpMethod === "GET") {
    try {
      const current = await readBin(binId);
      const rsvps = Array.isArray(current.record && current.record.rsvps) ? current.record.rsvps : [];
      return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ rsvps }) };
    } catch (err) {
      return { statusCode: 502, headers: jsonHeaders, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ---- POST: append a new RSVP entry, with optimistic-concurrency retry ----
  if (event.httpMethod === "POST") {
    let payload;
    try {
      payload = JSON.parse(event.body || "{}");
    } catch {
      return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: "Invalid JSON body" }) };
    }

    const nama = (payload.nama || "").toString().trim().slice(0, 100);
    const pesan = (payload.pesan || "").toString().trim().slice(0, 500);
    const konfirmasi = VALID_ATTENDANCE.includes(payload.konfirmasi) ? payload.konfirmasi : "Masih Ragu";

    if (!nama) {
      return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: "nama is required" }) };
    }

    // waktu/waktuISO come from the browser (local-time display string) so the
    // timestamp shown in the list matches the guest's own clock. Fall back to
    // server time only if the client didn't send one.
    const waktuISO = (payload.waktuISO && !isNaN(Date.parse(payload.waktuISO)))
      ? payload.waktuISO
      : new Date().toISOString();
    const waktu = (payload.waktu || "").toString().trim().slice(0, 100) ||
      new Date(waktuISO).toLocaleString('id-ID', { dateStyle: 'long', timeStyle: 'short' });

    const newEntry = { nama, pesan, konfirmasi, waktu, waktuISO };

    const maxRetries = 5;
    let lastErr = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(4000, 400 * 2 ** (attempt - 1)) + Math.random() * 300;
        await new Promise((r) => setTimeout(r, delay));
      }
      try {
        const current = await readBin(binId);
        const record = current.record || {};
        const baseRev = typeof record[REV_KEY] === "number" ? record[REV_KEY] : 0;
        const rsvps = Array.isArray(record.rsvps) ? record.rsvps.slice() : [];
        rsvps.push(newEntry);
        const newRecord = { rsvps, [REV_KEY]: baseRev + 1 };

        await writeBin(binId, newRecord);

        const verify = await readBin(binId);
        if (verify.record && verify.record[REV_KEY] === baseRev + 1) {
          return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ rsvps: verify.record.rsvps }) };
        }
        // someone else wrote in between — loop and retry with fresh data
      } catch (err) {
        lastErr = err;
      }
    }

    return {
      statusCode: 502,
      headers: jsonHeaders,
      body: JSON.stringify({ error: lastErr ? lastErr.message : "Too much contention, please try again" }),
    };
  }

  return { statusCode: 405, headers: jsonHeaders, body: JSON.stringify({ error: "Method not allowed" }) };
};