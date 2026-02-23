// ─── Pro License Management ───────────────────────────────────────────────────
// Validates license keys against Polar.sh.
// Replace POLAR_ORG_ID with your actual organization ID from your Polar dashboard.
//
// To get your org ID:
//   1. Log in to polar.sh
//   2. Go to Settings → Organization
//   3. Copy the "Organization ID" value
// ─────────────────────────────────────────────────────────────────────────────

const { app } = require('electron');
const path    = require('path');
const fs      = require('fs');

const LICENSE_PATH      = path.join(app.getPath('userData'), 'pro-license.json');
const PRO_SETTINGS_PATH = path.join(app.getPath('userData'), 'pro-settings.json');

// ── Replace this with your real Polar organization ID ────────────────────────
const POLAR_ORG_ID = process.env.POLAR_ORG_ID || '';
// ─────────────────────────────────────────────────────────────────────────────

function readLicense() {
  try { return JSON.parse(fs.readFileSync(LICENSE_PATH, 'utf8')); }
  catch { return {}; }
}

function writeLicense(data) {
  try { fs.writeFileSync(LICENSE_PATH, JSON.stringify(data, null, 2)); } catch {}
}

// Validate a license key against the Polar.sh API
async function activateLicense(key) {
  if (!key || key.trim().length < 8) {
    return { success: false, error: 'Invalid license key format.' };
  }

  try {
    const res = await fetch('https://api.polar.sh/v1/customer-portal/license-keys/validate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ key: key.trim(), organization_id: POLAR_ORG_ID }),
    });

    const data = await res.json();

    if (data.status === 'granted' || data.valid === true) {
      writeLicense({
        key:         key.trim(),
        isPro:       true,
        activatedAt: Date.now(),
        email:       data.user?.email || data.email || null,
      });
      return { success: true, email: data.user?.email || data.email || null };
    }

    return { success: false, error: data.detail || data.message || 'Invalid or expired license key.' };
  } catch (err) {
    // Network error — grant offline grace period if key was previously validated
    const existing = readLicense();
    if (existing.isPro && existing.key === key.trim()) {
      return { success: true, offline: true };
    }
    return { success: false, error: 'Network error. Check your internet connection and try again.' };
  }
}

function deactivateLicense() {
  writeLicense({});
}

function isPro() {
  return readLicense().isPro === true;
}

function getLicenseInfo() {
  const d = readLicense();
  return {
    isPro:       d.isPro    || false,
    key:         d.key      || null,
    email:       d.email    || null,
    activatedAt: d.activatedAt || null,
  };
}

// Runs once at startup — re-validates any stored key against Polar.
// Wipes the local license if the key is no longer valid (revoked, expired, etc.).
// Network failures are treated as offline grace (key kept).
async function validateStoredLicense() {
  const stored = readLicense();
  if (!stored.isPro || !stored.key) return;

  try {
    const res = await fetch('https://api.polar.sh/v1/customer-portal/license-keys/validate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ key: stored.key, organization_id: POLAR_ORG_ID }),
    });
    const data = await res.json();

    if (data.status !== 'granted' && data.valid !== true) {
      writeLicense({}); // key rejected by Polar → revoke locally
    }
  } catch {
    // Network error — keep existing license (offline grace period)
  }
}

// ── Pro settings (custom theme, custom shortcuts, AI API key) ─────────────────
function getProSettings() {
  try { return JSON.parse(fs.readFileSync(PRO_SETTINGS_PATH, 'utf8')); }
  catch { return {}; }
}

function saveProSettings(settings) {
  try {
    const existing = getProSettings();
    fs.writeFileSync(PRO_SETTINGS_PATH, JSON.stringify({ ...existing, ...settings }, null, 2));
  } catch {}
}

// ── AI completion proxy ───────────────────────────────────────────────────────
// Sends a request to OpenAI, Anthropic, or Google Gemini, proxied through main
// so the renderer CSP doesn't block the external fetch.
async function aiComplete({ provider, model, apiKey, prompt, context }) {
  if (!apiKey) return { success: false, error: 'No API key set.' };

  const SYSTEM = 'You are a code completion assistant. Return ONLY the code completion, no explanation or markdown.';
  const USER   = `Complete this code:\n\nContext:\n${context}\n\nComplete from:\n${prompt}`;

  try {
    if (provider === 'anthropic') {
      const resolvedModel = model || 'claude-haiku-4-5-20251001';
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method:  'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model:      resolvedModel,
          max_tokens: 200,
          system:     SYSTEM,
          messages:   [{ role: 'user', content: USER }],
        }),
      });
      const data = await res.json();
      if (data.content?.[0]?.text) return { success: true, text: data.content[0].text };
      return { success: false, error: data.error?.message || 'AI request failed.' };

    } else if (provider === 'gemini') {
      const resolvedModel = model || 'gemini-2.0-flash';
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${resolvedModel}:generateContent?key=${apiKey}`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `${SYSTEM}\n\n${USER}` }] }],
            generationConfig: { maxOutputTokens: 200 },
          }),
        }
      );
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) return { success: true, text };
      return { success: false, error: data.error?.message || 'AI request failed.' };

    } else {
      // OpenAI (default)
      const resolvedModel = model || 'gpt-4o-mini';
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model:      resolvedModel,
          max_tokens: 200,
          messages:   [
            { role: 'system', content: SYSTEM },
            { role: 'user',   content: USER   },
          ],
        }),
      });
      const data = await res.json();
      if (data.choices?.[0]?.message?.content) return { success: true, text: data.choices[0].message.content };
      return { success: false, error: data.error?.message || 'AI request failed.' };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { validateStoredLicense, activateLicense, deactivateLicense, isPro, getLicenseInfo, getProSettings, saveProSettings, aiComplete };
