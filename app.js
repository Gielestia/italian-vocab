// ── CONFIG SUPABASE ──────────────────────────────────────────────
const SUPABASE_URL = 'https://qipkstvmlbjtvmboyyov.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFpcGtzdHZtbGJqdHZtYm95eW92Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUzMjQ2NDAsImV4cCI6MjA5MDkwMDY0MH0.ZWA-TlRMRXIeHMCaemv-YqmWV713hZnexHxUDHwVz5c';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ── STATE ────────────────────────────────────────────────────────
let cards = [];
let currentCard = null;
let flipped = false;
let mode = 'card';
let selectedTheme = 'all';
let selectedFilter = 'all';
let expandedId = null;
let editingCard = null;
let userId = null;

const STATUS = { unseen: 'unseen', known: 'known', acquired: 'acquired', toLearn: 'toLearn' };
const WEIGHTS = { unseen: 2, known: 1, acquired: 0, toLearn: 5 };
const STATUS_LABEL = { unseen: 'Non vu', known: 'Connu', acquired: 'Acquis', toLearn: 'À revoir' };
const STATUS_STYLE = {
    unseen:   { bg: '#f1f5f9', color: '#94a3b8' },
    known:    { bg: '#dbeafe', color: '#2563eb' },
    acquired: { bg: '#dcfce7', color: '#16a34a' },
    toLearn:  { bg: '#fee2e2', color: '#dc2626' },
};

// ── AUTH ──────────────────────────────────────────────────────────
function switchTab(tab) {
    document.getElementById('login-form').style.display = tab === 'login' ? '' : 'none';
    document.getElementById('signup-form').style.display = tab === 'signup' ? '' : 'none';
    document.querySelectorAll('.auth-tab').forEach((b, i) => {
          b.classList.toggle('active', (i === 0 && tab === 'login') || (i === 1 && tab === 'signup'));
    });
    document.getElementById('auth-msg').innerHTML = '';
}

function showAuthMsg(msg, type = 'error') {
    const el = document.getElementById('auth-msg');
    el.innerHTML = msg;
    el.className = 'auth-msg ' + type;
}

async function login() {
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    if (!email || !password) return showAuthMsg('Remplis tous les champs.');
    const btn = document.querySelector('#login-form .btn-primary');
    btn.disabled = true; btn.textContent = 'Connexion...';
    const { error } = await sb.auth.signInWithPassword({ email, password });
    btn.disabled = false; btn.textContent = 'Se connecter';
    if (error) showAuthMsg('Erreur : ' + error.message);
}

async function signup() {
    const email = document.getElementById('signup-email').value.trim();
    const password = document.getElementById('signup-password').value;
    if (!email || !password) return showAuthMsg('Remplis tous les champs.');
    if (password.length < 6) return showAuthMsg('Mot de passe trop court (min. 6 caractères).');
    const btn = document.querySelector('#signup-form .btn-primary');
    btn.disabled = true; btn.textContent = 'Création...';
    const { error } = await sb.auth.signUp({ email, password });
    btn.disabled = false; btn.textContent = 'Créer mon compte';
    if (error) showAuthMsg('Erreur : ' + error.message);
    else showAuthMsg('✅ Compte créé ! Vérifie tes emails pour confirmer.', 'success');
}

async function logout() {
    // ✅ FIX: Reset state BEFORE signOut to avoid deadlock
  cards = []; currentCard = null; userId = null;
    document.getElementById('app').style.display = 'none';
    document.getElementById('app').style.flexDirection = '';
    document.getElementById('auth-page').style.display = 'flex';
    document.getElementById('auth-msg').innerHTML = '';
    // signOut after UI is already reset
  sb.auth.signOut();
}
window.logout = logout;

// ── INIT ──────────────────────────────────────────────────────────
sb.auth.onAuthStateChange((event, session) => {
    console.log("AUTH EVENT:", event, session);
    if (session?.user) {
          userId = session.user.id;
          document.getElementById('auth-page').style.display = 'none';
          document.getElementById('app').style.display = 'flex';
          document.getElementById('app').style.flexDirection = 'column';
          // ✅ FIX: Defer loadCards out of onAuthStateChange to avoid Supabase internal lock deadlock
      setTimeout(async () => {
              await loadCards();
              pickNext();
      }, 0);
    } else {
          userId = null;
    }
});

// ── DATA ──────────────────────────────────────────────────────────
async function loadCards() {
    if (!userId) {
          console.warn("⛔ loadCards appelé sans userId");
          return;
    }
    console.log("🚀 loadCards lancé avec userId:", userId);
    const { data, error } = await sb
      .from('vocabulary')
      .select('*')
      .eq('user_id', userId)
      .order('created_at');
    if (error) {
          console.error(error);
          return;
    }
    cards = data.map(r => ({
          id: r.id,
          theme: r.theme || '',
          fr: r.fr || '',
          genre: r.genre || '',
          itSg: r.it_sg || '',
          itPl: r.it_pl || '',
          tip: r.tip || '',
          status: r.status || 'unseen',
          retryCount: r.retry_count || 0,
    }));
    console.log("📦 cartes récupérées:", cards);
    updateThemes();
    updateStats();
    renderList();
}

async function saveCardStatus(cardId, status, retryCount) {
    showSaving();
    const { error } = await sb.from('vocabulary')
      .update({ status, retry_count: retryCount })
      .eq('id', cardId).eq('user_id', userId);
    if (error) console.error(error);
    hideSaving();
}

async function saveCardEdit(cardId, fields) {
    showSaving();
    const { error } = await sb.from('vocabulary')
      .update({ theme: fields.theme, fr: fields.fr, genre: fields.genre,
                             it_sg: fields.itSg, it_pl: fields.itPl, tip: fields.tip })
      .eq('id', cardId).eq('user_id', userId);
    if (error) console.error(error);
    hideSaving();
}

async function insertCards(newCards) {
    // ✅ FIX: Use the already-available userId instead of sb.auth.getSession() which can deadlock
  if (!userId) { showImportMsg('❌ Session expirée, reconnecte-toi.', 'warn'); return 0; }
    const rows = newCards.map(c => ({
          user_id: userId, theme: c.theme || '', fr: c.fr || '', genre: c.genre || '',
          it_sg: c.itSg || '', it_pl: c.itPl || '', tip: c.tip || '',
          status: 'unseen', retry_count: 0,
    }));
    showSaving();
    const { data, error } = await sb.from('vocabulary').insert(rows).select();
    hideSaving();
    if (error) { showImportMsg('❌ Erreur Supabase : ' + error.message, 'warn'); return 0; }
    const inserted = data.map(r => ({
          id: r.id, theme: r.theme, fr: r.fr, genre: r.genre,
          itSg: r.it_sg, itPl: r.it_pl, tip: r.tip,
          status: 'unseen', retryCount: 0,
    }));
    cards = [...cards, ...inserted];
    return inserted.length;
}

// ── HELPERS ───────────────────────────────────────────────────────
function getFiltered() {
    let pool = cards;
    if (selectedTheme !== 'all') pool = pool.filter(c => c.theme === selectedTheme);
    if (selectedFilter === 'toLearn') pool = pool.filter(c => c.status === 'toLearn');
    else if (selectedFilter === 'known') pool = pool.filter(c => c.status === 'known');
    else if (selectedFilter === 'unseen') pool = pool.filter(c => c.status === 'unseen');
    else if (selectedFilter === 'acquired') pool = pool.filter(c => c.status === 'acquired');
    else pool = pool.filter(c => c.status !== 'acquired');
    return pool;
}

function weightedRandom(pool) {
    const weighted = [];
    for (const c of pool) { const w = WEIGHTS[c.status] ?? 2; for (let i = 0; i < w; i++) weighted.push(c); }
    if (!weighted.length) return null;
    return weighted[Math.floor(Math.random() * weighted.length)];
}

function updateThemes() {
    const themes = [...new Set(cards.map(c => c.theme).filter(Boolean))].sort();
    const sel = document.getElementById('theme-select');
    const current = sel.value;
    sel.innerHTML = '<option value="all">Tous les thèmes</option>' +
          themes.map(t => `<option value="${t}"${t === current ? ' selected' : ''}>${t}</option>`).join('');
}

function updateStats() {
    const pool = cards.filter(c => selectedTheme === 'all' || c.theme === selectedTheme);
    const s = { unseen: 0, known: 0, acquired: 0, toLearn: 0 };
    for (const c of pool) s[c.status]++;
    const total = pool.length;
    document.getElementById('stat-unseen').textContent = s.unseen;
    document.getElementById('stat-tolearn').textContent = s.toLearn;
    document.getElementById('stat-known').textContent = s.known;
    document.getElementById('stat-acquired').textContent = s.acquired;
    document.getElementById('stat-total').textContent = total;
    document.getElementById('progress-fill').style.width = total ? `${(s.acquired / total) * 100}%` : '0%';
}

function showSaving() { document.getElementById('saving-indicator').classList.add('visible'); }
function hideSaving() { setTimeout(() => document.getElementById('saving-indicator').classList.remove('visible'), 600); }

function speak(text, e) {
    e && e.stopPropagation();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'it-IT'; u.rate = 0.85;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
}

// ── CARD LOGIC ───────────────────────────────────────────────────
function pickNext(excludeId = null) {
    const pool = getFiltered().filter(c => c.id !== excludeId);
    const next = weightedRandom(pool);
    flipped = false;
    const cardEl = document.getElementById(mode === 'reverse' ? 'reverse-card' : 'main-card');
    if (cardEl) {
          cardEl.classList.add('animating');
          setTimeout(() => { currentCard = next; renderCard(); cardEl.classList.remove('animating'); }, 200);
    } else {
          currentCard = next;
          renderCard();
    }
}

function flipCard() { if (!currentCard) return; flipped = !flipped; renderCard(); }

function renderCard() {
    if (mode === 'card') renderCardMode();
    else if (mode === 'reverse') renderReverseMode();
    updatePoolCount();
}

function renderCardMode() {
    const pool = getFiltered();
    const cardView = document.getElementById('card-view');
    if (!currentCard || pool.length === 0) {
          cardView.innerHTML = renderEmptyState(pool);
          return;
    }
    let el = document.getElementById('card-content');
    if (!el) {
          cardView.innerHTML = `
                <div class="card-wrapper">
                        <button class="btn-edit-card" onclick="openEdit(currentCard)">✏️</button>
                                <div class="card" id="main-card" onclick="flipCard()">
                                          <div id="card-content"></div>
                                                  </div>
                                                        </div>
                                                              <div class="action-btns">
                                                                      <button class="btn-acquired" onclick="setStatus('acquired')">✅ Acquis</button>
                                                                              <button class="btn-known" onclick="setStatus('known')">👍 Connu</button>
                                                                                      <button class="btn-tolearn" onclick="setStatus('toLearn')" id="btn-tolearn-card">🔁 À revoir</button>
                                                                                            </div>
                                                                                                  <div class="pool-count" id="pool-count-card"></div>`;
          el = document.getElementById('card-content');
    }
    const c = currentCard;
    const statusStyle = STATUS_STYLE[c.status];
    if (!flipped) {
          el.innerHTML = `
                <div class="card-theme">${c.theme}</div>
                      <div class="card-word">${c.fr}</div>
                            ${c.genre ? `<div class="card-genre">(${c.genre})</div>` : ''}
                                  ${c.status !== 'unseen' ? `<div class="card-status-badge" style="background:${statusStyle.bg};color:${statusStyle.color}">${STATUS_LABEL[c.status]}</div>` : ''}
                                        <div class="card-hint">Cliquez pour voir la traduction</div>
                                              <button class="btn-sound" onclick="speak('${c.itSg.replace(/'/g, "\\'")}', event)">🔊 Écouter en italien</button>
                                                  `;
    } else {
          el.innerHTML = `
                <div class="card-theme">Traduction italienne</div>
                      <div style="display:flex;align-items:center;gap:0.75rem;justify-content:center">
                              <div class="card-word italian">${c.itSg}</div>
                                      <button class="btn-sound" style="margin:0" onclick="speak('${c.itSg.replace(/'/g, "\\'")}', event)">🔊</button>
                                            </div>
                                                  ${c.itPl && c.itPl !== c.itSg ? `<div class="card-plural">PL: <strong>${c.itPl}</strong></div>` : ''}
                                                        ${c.tip ? `<div class="card-tip">💡 ${c.tip}</div>` : ''}
                                                            `;
    }
    const retryCount = c.retryCount || 0;
    const btnToLearn = document.getElementById('btn-tolearn-card');
    if (btnToLearn) btnToLearn.textContent = `🔁 À revoir${retryCount > 0 ? ` (${retryCount})` : ''}`;
}

function renderReverseMode() {
    const pool = getFiltered();
    const reverseView = document.getElementById('reverse-view');
    if (!currentCard || pool.length === 0) {
          reverseView.innerHTML = renderEmptyState(pool);
          return;
    }
    let el = document.getElementById('reverse-content');
    if (!el) {
          reverseView.innerHTML = `
                <div class="card-wrapper">
                        <button class="btn-edit-card" onclick="openEdit(currentCard)">✏️</button>
                                <div class="card" id="reverse-card" onclick="flipCard()">
                                          <div id="reverse-content"></div>
                                                  </div>
                                                        </div>
                                                              <div class="action-btns">
                                                                      <button class="btn-acquired" onclick="setStatus('acquired')">✅ Acquis</button>
                                                                              <button class="btn-known" onclick="setStatus('known')">👍 Connu</button>
                                                                                      <button class="btn-tolearn" onclick="setStatus('toLearn')" id="btn-tolearn-reverse">🔁 À revoir</button>
                                                                                            </div>
                                                                                                  <div class="pool-count" id="pool-count-reverse"></div>`;
          el = document.getElementById('reverse-content');
    }
    const c = currentCard;
    const statusStyle = STATUS_STYLE[c.status];
    if (!flipped) {
          el.innerHTML = `
                <div class="card-theme">${c.theme}</div>
                      <div style="display:flex;align-items:center;gap:0.75rem;justify-content:center">
                              <div class="card-word italian">${c.itSg}</div>
                                      <button class="btn-sound" style="margin:0" onclick="speak('${c.itSg.replace(/'/g, "\\'")}', event)">🔊</button>
                                            </div>
                                                  ${c.itPl && c.itPl !== c.itSg ? `<div class="card-plural">PL: <strong>${c.itPl}</strong></div>` : ''}
                                                        ${c.status !== 'unseen' ? `<div class="card-status-badge" style="background:${statusStyle.bg};color:${statusStyle.color}">${STATUS_LABEL[c.status]}</div>` : ''}
                                                              <div class="card-hint">Cliquez pour voir la traduction</div>
                                                                  `;
    } else {
          el.innerHTML = `
                <div class="card-theme">Traduction française</div>
                      <div class="card-word">${c.fr}</div>
                            ${c.genre ? `<div class="card-genre">(${c.genre})</div>` : ''}
                                  ${c.tip ? `<div class="card-tip">💡 ${c.tip}</div>` : ''}
                                      `;
    }
    const retryCount = c.retryCount || 0;
    const btnToLearn = document.getElementById('btn-tolearn-reverse');
    if (btnToLearn) btnToLearn.textContent = `🔁 À revoir${retryCount > 0 ? ` (${retryCount})` : ''}`;
}

function renderEmptyState(pool) {
    const allAcquired = cards.filter(c => selectedTheme === 'all' || c.theme === selectedTheme).every(c => c.status === 'acquired');
    return `
        <div class="empty-state">
              ${allAcquired && cards.length > 0 ? '🎉 Bravo ! Tu as acquis tout le vocabulaire !' : 'Aucune carte dans ce filtre.'}
                    <br>
                          <button onclick="handleFilterChange('all');handleThemeChange('all')">Tout afficher</button>
                              </div>
                                `;
}

function updatePoolCount() {
    const pool = getFiltered();
    const el = document.getElementById(mode === 'reverse' ? 'pool-count-reverse' : 'pool-count-card');
    if (el) el.textContent = `${pool.length} cartes dans ce filtre`;
}

async function setStatus(status, cardId = null) {
    const id = cardId ?? currentCard?.id;
    if (id == null) return;
    const card = cards.find(c => c.id === id);
    if (!card) return;
    card.status = status;
    if (status === 'toLearn') card.retryCount = (card.retryCount || 0) + 1;
    await saveCardStatus(id, status, card.retryCount);
    updateStats();
    if (cardId == null) { pickNext(status === 'acquired' ? id : null); }
    else { renderList(); }
}

// ── LIST VIEW ────────────────────────────────────────────────────
function renderList() {
    if (mode !== 'list') return;
    const pool = getFiltered();
    document.getElementById('list-count').textContent = `${pool.length} mots`;
    const container = document.getElementById('list-items');
    if (!pool.length) { container.innerHTML = '<div class="empty-state">Aucun mot dans ce filtre.</div>'; return; }
    container.innerHTML = pool.map(c => {
          const st = c.status;
          const retry = c.retryCount || 0;
          const expanded = expandedId === c.id;
          const stStyle = STATUS_STYLE[st];
          return `
                <div class="list-item" id="listitem-${c.id}">
                        <div class="list-item-header" onclick="toggleExpand('${c.id}')">
                                  <div class="list-item-main">
                                              <span class="list-item-fr">${c.fr}</span>
                                                          ${c.genre ? `<span class="list-item-genre">(${c.genre})</span>` : ''}
                                                                      <span class="list-item-it">→ ${c.itSg}</span>
                                                                                </div>
                                                                                          ${retry > 0 ? `<span class="retry-badge">🔁 ${retry}</span>` : ''}
                                                                                                    <span class="status-badge" style="background:${stStyle.bg};color:${stStyle.color}">${STATUS_LABEL[st]}</span>
                                                                                                              <button class="btn-icon sound" onclick="speak('${c.itSg.replace(/'/g, "\\'")}', event)">🔊</button>
                                                                                                                        <button class="btn-icon edit" onclick="event.stopPropagation();openEdit(cards.find(x=>x.id==='${c.id}'))">✏️</button>
                                                                                                                                  <span class="chevron">${expanded ? '▲' : '▼'}</span>
                                                                                                                                          </div>
                                                                                                                                                  ${expanded ? `
                                                                                                                                                            <div class="list-item-body">
                                                                                                                                                                        ${c.itPl && c.itPl !== c.itSg ? `<div class="list-item-plural">Pluriel : <strong>${c.itPl}</strong></div>` : ''}
                                                                                                                                                                                    ${c.theme ? `<div class="list-item-theme">Thème : ${c.theme}</div>` : ''}
                                                                                                                                                                                                ${c.tip ? `<div class="list-item-tip">💡 ${c.tip}</div>` : ''}
                                                                                                                                                                                                            <div class="list-action-btns">
                                                                                                                                                                                                                          <button class="btn-acquired" onclick="setStatus('acquired','${c.id}')">✅ Acquis</button>
                                                                                                                                                                                                                                        <button class="btn-known" onclick="setStatus('known','${c.id}')">👍 Connu</button>
                                                                                                                                                                                                                                                      <button class="btn-tolearn" onclick="setStatus('toLearn','${c.id}')">🔁 À revoir${retry > 0 ? ` (${retry})` : ''}</button>
                                                                                                                                                                                                                                                                  </div>
                                                                                                                                                                                                                                                                            </div>
                                                                                                                                                                                                                                                                                    ` : ''}
                                                                                                                                                                                                                                                                                          </div>
                                                                                                                                                                                                                                                                                              `;
    }).join('');
}

function toggleExpand(id) { expandedId = expandedId === id ? null : id; renderList(); }

// ── MODES & FILTERS ──────────────────────────────────────────────
function setMode(m) {
    mode = m;
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
    document.getElementById('card-view').style.display = m === 'card' ? 'flex' : 'none';
    document.getElementById('reverse-view').style.display = m === 'reverse' ? 'flex' : 'none';
    document.getElementById('list-view').style.display = m === 'list' ? 'block' : 'none';
    if (m === 'list') renderList(); else pickNext();
}

function handleThemeChange(val) {
    selectedTheme = val; updateStats();
    if (mode === 'list') renderList(); else pickNext();
}

function handleFilterChange(val) {
    selectedFilter = val;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === val));
    if (mode === 'list') renderList(); else pickNext();
}

// ── EDIT MODAL ───────────────────────────────────────────────────
function openEdit(card) {
    if (!card) return;
    editingCard = card;
    document.getElementById('edit-theme').value = card.theme || '';
    document.getElementById('edit-fr').value = card.fr || '';
    document.getElementById('edit-genre').value = card.genre || '';
    document.getElementById('edit-itsg').value = card.itSg || '';
    document.getElementById('edit-itpl').value = card.itPl || '';
    document.getElementById('edit-tip').value = card.tip || '';
    document.getElementById('edit-modal').style.display = 'flex';
}

function closeEdit() { document.getElementById('edit-modal').style.display = 'none'; editingCard = null; }

async function saveEdit() {
    if (!editingCard) return;
    const fields = {
          theme: document.getElementById('edit-theme').value.trim(),
          fr:    document.getElementById('edit-fr').value.trim(),
          genre: document.getElementById('edit-genre').value.trim(),
          itSg:  document.getElementById('edit-itsg').value.trim(),
          itPl:  document.getElementById('edit-itpl').value.trim(),
          tip:   document.getElementById('edit-tip').value.trim(),
    };
    if (!fields.fr || !fields.itSg) return alert('Le mot français et la traduction italienne sont obligatoires.');
    Object.assign(editingCard, fields);
    await saveCardEdit(editingCard.id, fields);
    updateThemes(); updateStats();
    if (currentCard?.id === editingCard.id) Object.assign(currentCard, fields);
    renderCard(); renderList(); closeEdit();
}

// ── IMPORT ───────────────────────────────────────────────────────
function openImport() {
    document.getElementById('import-modal').style.display = 'flex';
    document.getElementById('paste-area').value = '';
    document.getElementById('import-msg').style.display = 'none';
}

function closeImport() { document.getElementById('import-modal').style.display = 'none'; }

function triggerFileInput() { document.getElementById('csv-file-input').click(); }

function parseRows(data) {
    if (!data || !data.length) return [];
    const cols = Object.keys(data[0] || {});
    const normalize = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s/g, '');
    const find = (row, ...keys) => {
          for (const k of keys) { const found = cols.find(c => normalize(c).includes(k)); if (found) return (row[found] || '').trim(); }
          return '';
    };
    const findCol = (row, ...exact) => {
          for (const k of exact) { const found = cols.find(c => c === k); if (found) return (row[found] || '').trim(); }
          return '';
    };
    return data.map(r => ({
          theme: find(r, 'theme'),
          fr:    findCol(r, 'Mot en français') || find(r, 'francais', 'fr', 'mot'),
          genre: find(r, 'genre'),
          itSg:  findCol(r, 'Italien (SG)') || find(r, 'sg'),
          itPl:  findCol(r, 'Italien (PL)') || find(r, 'pl'),
          tip:   (() => { const c = cols.find(c => c.includes('Astuce') || c.includes('astuce') || c.includes('tip')); return c ? (r[c] || '').trim() : ''; })(),
    }));
}

async function mergeImport(rows) {
    showImportMsg('⏳ Import en cours...', 'warn');
    const timeout = setTimeout(() => showImportMsg('❌ Timeout — vérifie ta connexion ou reconnecte-toi.', 'warn'), 8000);
    try {
          if (!rows.length) { clearTimeout(timeout); showImportMsg('⚠️ Aucune ligne trouvée dans le fichier.', 'warn'); return; }
          const validRows = rows.filter(r => r.fr && r.itSg);
          if (!validRows.length) { clearTimeout(timeout); showImportMsg('⚠️ Colonnes non reconnues. En-têtes attendus : Mot en français, Italien (SG).', 'warn'); return; }
          const existing = new Set(cards.map(c => c.fr.toLowerCase().trim()));
          const toAdd = validRows.filter(r => !existing.has(r.fr.toLowerCase().trim()));
          if (!toAdd.length) { clearTimeout(timeout); showImportMsg('⚠️ Aucun nouveau mot à ajouter (doublons ignorés).', 'warn'); return; }
          const count = await insertCards(toAdd);
          clearTimeout(timeout);
          if (count > 0) {
                  updateThemes(); updateStats(); renderList();
                  if (currentCard === null) pickNext();
                  showImportMsg(`✅ ${count} mot(s) ajouté(s) avec succès !`, 'success');
          }
    } catch(err) { clearTimeout(timeout); showImportMsg('❌ Erreur : ' + err.message, 'warn'); }
}

function showImportMsg(msg, type) {
    const el = document.getElementById('import-msg');
    el.textContent = msg; el.className = 'import-msg ' + type; el.style.display = 'block';
}

function handleImportFile(input) {
    const file = input.files[0];
    if (!file) return;
    document.getElementById('import-modal').style.display = 'flex';
    showImportMsg('⏳ Lecture du fichier...', 'warn');
    const reader = new FileReader();
    reader.onload = async (e) => {
          try {
                  const result = Papa.parse(e.target.result, { header: true, skipEmptyLines: true });
                  await mergeImport(parseRows(result.data));
          } catch(err) { showImportMsg('❌ Erreur : ' + err.message, 'warn'); }
    };
    reader.onerror = () => showImportMsg('❌ Impossible de lire le fichier.', 'warn');
    reader.readAsText(file);
    input.value = '';
}

async function handleImportPaste() {
    const text = document.getElementById('paste-area').value.trim();
    if (!text) return;
    let result = Papa.parse(text, { header: true, skipEmptyLines: true });
    if (!result.data.length || Object.keys(result.data[0]).length < 2) {
          result = Papa.parse(text, { header: true, skipEmptyLines: true, delimiter: '\t' });
    }
    await mergeImport(parseRows(result.data));
}

// ── EXPORT ───────────────────────────────────────────────────────
function openExport() {
    const rows = cards.map(c => ({
          'Thème': c.theme, 'Mot en français': c.fr, 'Genre': c.genre,
          'Italien (SG)': c.itSg, 'Italien (PL)': c.itPl, '🧠 Astuce mnémotechnique': c.tip,
    }));
    document.getElementById('export-textarea').value = Papa.unparse(rows);
    document.getElementById('export-modal').style.display = 'flex';
    document.getElementById('btn-copy').className = 'btn-copy';
    document.getElementById('btn-copy').textContent = '📋 Copier tout';
}

function closeExport() { document.getElementById('export-modal').style.display = 'none'; }

function copyCSV() {
    const ta = document.getElementById('export-textarea');
    navigator.clipboard.writeText(ta.value).then(() => {
          const btn = document.getElementById('btn-copy');
          btn.className = 'btn-copy copied'; btn.textContent = '✅ Copié !';
          setTimeout(() => { btn.className = 'btn-copy'; btn.textContent = '📋 Copier tout'; }, 2000);
    });
}

// ── KEYBOARD ─────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
    if (document.getElementById('edit-modal').style.display !== 'none') return;
    if (mode === 'list') return;
    if (e.key === ' ' || e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); flipCard(); }
    if (e.key === '1') setStatus('acquired');
    if (e.key === '2') setStatus('known');
    if (e.key === '3') setStatus('toLearn');
});
