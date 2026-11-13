// The desktop app's first-run screen (decisions 52 and 54): the API key, the project folders and Claude Code.
// Plain ES module, no build step. Everything goes through the hub's /api/setup routes, which only this PC may use.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mb = n => `${Math.round(n / 1048576)} MB`;

let st = null;            // the hub's view (GET /api/setup)
let folders = null;       // the folder list as edited here, saved by Start
let keyEditing = false;
let pollTimer = null;

async function get() {
  const r = await fetch('/api/setup', { cache: 'no-store' });
  if (!r.ok) throw new Error('The hub did not answer.');
  return r.json();
}
async function post(path, body = {}) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'The hub refused that.');
  return j;
}
const showErr = (id, msg) => { const el = $(id); el.textContent = msg || ''; el.hidden = !msg; };
const keyReady = () => !!st?.key.saved;
const claudeReady = () => !!st?.claude.source;
const same = (a, b) => a.length === b.length && a.every((x, i) => x.toLowerCase().replace(/\\/g, '/') === String(b[i]).toLowerCase().replace(/\\/g, '/'));

function render() {
  if (!st) return;
  if (!st.local) { $('#su').classList.add('closed'); $('#su-remote').hidden = false; return; }

  // 1. The key
  const kr = keyReady() && !keyEditing;
  $('#st-key').classList.toggle('ready', keyReady());
  $('#key-done').hidden = !kr;
  $('#key-form').hidden = kr;
  $('#key-done-text').innerHTML = st.key.from === 'environment'
    ? 'Using the key set in this PC\'s environment'
    : `Key saved <span class="faint">· ends ${esc(st.key.end)}</span>`;
  $('#key-change').hidden = st.key.from === 'environment';

  // 2. The folders
  folders ??= [...(st.configFolders?.length ? st.configFolders : st.folders)];
  $('#st-folders').classList.toggle('ready', folders.length > 0);
  $('#folder-list').innerHTML = folders.map((f, i) => `<li><svg class="icon"><use href="#i-folder"/></svg><span class="path" title="${esc(f)}">${esc(f)}</span>
    <button class="btn ghost icon-only" type="button" data-rm="${i}" aria-label="Remove ${esc(f)}" title="Remove this folder"><svg class="icon"><use href="#i-minus"/></svg></button></li>`).join('');

  // 3. Claude Code
  const c = st.claude, d = c.download;
  $('#st-claude').classList.toggle('ready', claudeReady());
  const busy = d.state === 'downloading' || d.state === 'checking';
  $('#cc-done').hidden = !claudeReady() || c.source === 'installed';
  $('#cc-done-text').textContent = c.source === 'sdk' ? 'Claude Code is ready (it came with this hub).' : `Claude Code ${c.version} is ready.`;
  $('#cc-get').hidden = (claudeReady() && c.source !== 'installed') || busy;
  $('#cc-note').innerHTML = c.source === 'installed'
    ? `Using the Claude Code already on this PC. For the best match, download version <b>${esc(c.version)}</b> (once, about ${esc(c.sizeMB)} MB on disk).`
    : `Download Claude Code <b>${esc(c.version || '')}</b> from Anthropic, once (about ${esc(c.sizeMB)} MB on disk).`;
  $('#cc-btn-text').textContent = d.state === 'error' ? 'Try again' : 'Download';
  $('#cc-prog').hidden = !busy;
  const pct = d.total ? Math.min(100, Math.round(d.received / d.total * 100)) : 0;
  $('#cc-bar').classList.toggle('busy', d.state === 'checking' || (busy && !d.total));
  $('#cc-fill').style.width = `${pct}%`;
  $('#cc-bar').setAttribute('aria-valuenow', String(pct));
  $('#cc-prog-text').textContent = d.state === 'checking' ? 'Checking…' : d.total ? `${mb(d.received)} / ${mb(d.total)}` : mb(d.received);
  showErr('#cc-err', d.state === 'error' ? d.error : '');

  // Start
  const ready = keyReady() && folders.length > 0 && claudeReady();
  $('#su-start').disabled = !ready;
  $('#foot-note').textContent = ready ? 'All set. Start opens Crux with your projects.' : `Still to do: ${[!keyReady() && 'the API key', !folders.length && 'a project folder', !claudeReady() && 'Claude Code'].filter(Boolean).join(', ')}.`;

  clearTimeout(pollTimer);
  if (busy) pollTimer = setTimeout(refresh, 600);
}

async function refresh() {
  try { st = await get(); } catch (e) { showErr('#cc-err', e.message); return; }
  if (!st.bundled) { location.replace('/'); return; }
  render();
}

// ---------- the key ----------
$('#key-form').addEventListener('submit', async e => {
  e.preventDefault();
  const v = $('#key-in').value.trim();
  if (!v) { showErr('#key-err', 'Paste your API key first.'); return; }
  const btn = $('#key-save'); btn.disabled = true; btn.textContent = 'Checking…';
  try {
    const r = await post('/api/setup/key', { apiKey: v });
    $('#key-in').value = ''; keyEditing = false; showErr('#key-err', '');
    st = r.setup; render();
    if (r.check === 'unchecked' && !st.testHub) $('#key-done-text').innerHTML += ' <span class="faint">· saved; Anthropic could not be reached to check it</span>';
  } catch (err) { showErr('#key-err', err.message); }
  finally { btn.disabled = false; btn.textContent = 'Save key'; }
});
$('#key-change').addEventListener('click', () => { keyEditing = true; render(); $('#key-in').focus(); });

// ---------- folders ----------
function addFolder(p) {
  const s = String(p || '').trim().replace(/^"(.*)"$/, '$1');
  if (!s) return;
  if (!/^([A-Za-z]:[\\/]|\\\\|\/)/.test(s)) { showErr('#folder-err', 'Give the full path, like C:\\Users\\you\\Documents\\my-project.'); return; }
  if (!folders.some(f => f.toLowerCase() === s.toLowerCase())) folders.push(s);
  showErr('#folder-err', ''); render();
}
$('#folder-form').addEventListener('submit', e => { e.preventDefault(); addFolder($('#folder-in').value); $('#folder-in').value = ''; });
$('#folder-list').addEventListener('click', e => {
  const b = e.target.closest('[data-rm]'); if (!b) return;
  folders.splice(Number(b.dataset.rm), 1); render();
});
$('#folder-browse').addEventListener('click', async () => {
  const btn = $('#folder-browse'); btn.disabled = true;
  const label = btn.lastChild; const was = label.textContent; label.textContent = 'Picker open…';
  try { const { path } = await post('/api/setup/browse'); if (path) addFolder(path); }
  catch (err) { showErr('#folder-err', err.message); }
  finally { btn.disabled = false; label.textContent = was; }
});

// ---------- Claude Code ----------
$('#cc-btn').addEventListener('click', async () => {
  showErr('#cc-err', '');
  try { st = await post('/api/setup/claude'); render(); } catch (err) { showErr('#cc-err', err.message); }
});

// ---------- start and close ----------
const ping = () => fetch('/api/ping', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null);
$('#su-start').addEventListener('click', async () => {
  showErr('#folder-err', '');
  if (same(folders, st.folders)) { location.replace('/'); return; }
  const before = (await ping())?.boot;
  try { await post('/api/setup/folders', { folders }); }
  catch (err) { showErr('#folder-err', err.message); return; }
  $('#su-starting').hidden = false;
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    await new Promise(r => setTimeout(r, 500));
    const p = await ping();
    if (p?.boot && p.boot !== before) { location.replace('/'); return; }
  }
  $('#su-starting').hidden = true;
  showErr('#folder-err', 'The hub did not come back. Use Restart hub from the Crux icon in the tray, then open Crux again.');
});

// The X and Escape close without changing anything: back to the hub when it has projects, else a calm note.
function close() {
  if (st?.folders?.length) { try { sessionStorage.setItem('crux-hub:setup-closed', '1'); } catch { } location.replace('/'); return; }
  $('#su').classList.add('closed'); $('#su-closed').hidden = false;
}
$('#su-x').addEventListener('click', close);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#su').classList.contains('closed')) close(); });
$('#su-reopen').addEventListener('click', () => { $('#su').classList.remove('closed'); $('#su-closed').hidden = true; });

refresh();
