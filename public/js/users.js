// Staff accounts (admins only; the server checks too). A new or reset PIN is shown here once
// and never again: the server only keeps its hash.
import { $, esc, api, toast, busy, confirmDialog, renderTopbar, requireStaff, ago } from './common.js';

const me = await requireStaff(['admin']);
renderTopbar('/users.html', me);

const ROLE_LABEL = { admin: 'Admin', marshal: 'Marshal', driver: 'Driver' };
let ranks = [];
let taxis = [];
let users = [];

const rankOptions = (selected) => ranks.map((r) => `<option value="${r.id}"${r.id === selected ? ' selected' : ''}>${esc(r.name)}</option>`).join('');
const rankName = (id) => ranks.find((r) => r.id === id)?.name ?? 'No rank';
const taxiOptions = (selected) => `<option value="">Not linked yet</option>
  <option value="new"${selected === 'new' ? ' selected' : ''}>Add a new taxi</option>
  ${taxis.map((t) => `<option value="${t.id}"${t.id === selected ? ' selected' : ''}>${esc(t.plate)}</option>`).join('')}`;
/** What to send for the taxi picker: an existing taxi's id, or a new taxi's plate and seats. */
function taxiChoice(value, plate, seats) {
  if (value === 'new') return { newTaxi: { plate: plate.trim(), capacity: Number(seats) || 15 } };
  return { taxiId: value ? Number(value) : null };
}
const plateOf = (id) => taxis.find((t) => t.id === id)?.plate;

async function load() {
  try {
    const [snap, list] = await Promise.all([api('/api/snapshot'), api('/api/users')]);
    ({ ranks, taxis } = snap);
    users = list;
  } catch (err) {
    return toast(err.message, 'error');
  }
  if (!$('#add-rank').options.length) $('#add-rank').innerHTML = rankOptions(null);
  const was = $('#add-taxi').value;
  $('#add-taxi').innerHTML = taxiOptions(was === 'new' ? 'new' : Number(was) || null);
  syncRankField();
  render();
}

function render() {
  if (!users.length) {
    $('#list').innerHTML = '<li class="muted">No staff yet.</li>';
    return;
  }
  $('#list').innerHTML = users.map((u) => `
    <li class="user-row${u.active ? '' : ' is-off'}">
      <div class="user-main">
        <b>${esc(u.name)}${u.id === me.id ? ' <span class="muted small">(you)</span>' : ''}</b>
        <span class="small muted">${esc(u.phone)} · ${u.lastLoginAt ? `last signed in ${esc(ago(u.lastLoginAt))}` : 'never signed in'}</span>
      </div>
      <div class="user-tools">
        <span class="tag">${ROLE_LABEL[u.role]}</span>
        ${u.role === 'marshal' ? `<span class="tag">${esc(rankName(u.rankId))}</span>` : ''}
        ${u.role === 'driver' ? `<span class="tag${u.taxiId ? '' : ' warn'}">${u.taxiId ? esc(plateOf(u.taxiId) ?? 'Taxi') : 'No taxi linked'}</span>` : ''}
        ${u.role === 'driver' && u.locationConsentVersion ? '<span class="tag">Agreed to location sharing</span>' : ''}
        ${u.active ? '' : '<span class="tag warn">Switched off</span>'}
        ${u.lockedUntil ? '<span class="tag warn">Locked: too many wrong PINs</span>' : ''}
        ${u.mustChangePin && u.active ? '<span class="tag">Has not chosen a PIN</span>' : ''}
        <button class="btn sm" type="button" data-edit="${u.id}">Edit</button>
        <button class="btn sm" type="button" data-reset="${u.id}">New PIN</button>
      </div>
    </li>`).join('');
}

/** Shows a PIN once, in a dialog that has to be closed on purpose. */
function showPin(name, pin) {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `<form method="dialog" class="dialog-body">
      <h2>PIN for ${esc(name)}</h2>
      <p>Give it to ${esc(name)} privately, in person or by phone call. Don't send it on a group chat.
        It will not be shown again. They must choose their own PIN when they first sign in.</p>
      <div class="pin-reveal">${esc(pin)}</div>
      <div class="dialog-actions"><button class="btn primary" value="ok">I've given it to them</button></div>
    </form>`;
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('cancel', (e) => e.preventDefault()); // Esc doesn't dismiss it by accident
  dlg.showModal();
}

// ------------------------------------------------------------------ add

function syncRankField() {
  const role = $('#add-role').value;
  const newTaxi = role === 'driver' && $('#add-taxi').value === 'new';
  $('#add-rank-wrap').hidden = role !== 'marshal';
  $('#add-taxi-wrap').hidden = role !== 'driver';
  $('#add-plate-wrap').hidden = $('#add-seats-wrap').hidden = !newTaxi;
}
$('#add-role').addEventListener('change', syncRankField);
$('#add-taxi').addEventListener('change', () => {
  syncRankField();
  if ($('#add-taxi').value === 'new') $('#add-plate').focus();
});
syncRankField();

$('#add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = e.submitter ?? $('#add button[type="submit"]');
  await busy(button, async () => {
    const role = $('#add-role').value;
    const body = { name: $('#add-name').value, phone: $('#add-phone').value, role };
    if (role === 'marshal') body.rankId = Number($('#add-rank').value);
    if (role === 'driver') Object.assign(body, taxiChoice($('#add-taxi').value, $('#add-plate').value, $('#add-seats').value));
    try {
      const r = await api('/api/users', { method: 'POST', body });
      $('#add-name').value = '';
      $('#add-phone').value = '';
      $('#add-plate').value = '';
      $('#add-seats').value = '15';
      $('#add-taxi').value = '';
      await load();
      showPin(r.user.name, r.pin);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
});

// ------------------------------------------------------------------ edit and reset

function editDialog(u) {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `<form method="dialog" class="dialog-body" novalidate>
      <h2>Edit ${esc(u.name)}</h2>
      <label class="field">Name <input class="input" name="name" maxlength="60" value="${esc(u.name)}" required></label>
      <label class="field">Role
        <select class="input" name="role">
          ${Object.entries(ROLE_LABEL).map(([v, l]) => `<option value="${v}"${v === u.role ? ' selected' : ''}>${l}</option>`).join('')}
        </select>
      </label>
      <label class="field" data-rank>Rank <select class="input" name="rankId">${rankOptions(u.rankId)}</select></label>
      <label class="field" data-taxi>Taxi they drive <select class="input" name="taxiId">${taxiOptions(u.taxiId)}</select></label>
      <label class="field" data-newtaxi>Number plate <input class="input" name="plate" maxlength="20" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="JB 21 MN GP"></label>
      <label class="field" data-newtaxi>Seats <input class="input" name="seats" type="number" inputmode="numeric" min="4" max="35" value="15"></label>
      <label class="check"><input type="checkbox" name="active"${u.active ? ' checked' : ''}> Can sign in</label>
      <p class="small muted">Switching someone off or changing their role signs them out on every phone straight away.</p>
      <div class="dialog-actions">
        <button class="btn quiet" value="cancel" formnovalidate>Cancel</button>
        <button class="btn primary" value="save">Save</button>
      </div>
    </form>`;
  document.body.append(dlg);
  const form = dlg.querySelector('form');
  const field = (n) => form.elements.namedItem(n); // not form.name: that is the form's own name
  const sync = () => {
    form.querySelector('[data-rank]').hidden = field('role').value !== 'marshal';
    form.querySelector('[data-taxi]').hidden = field('role').value !== 'driver';
    const newTaxi = field('role').value === 'driver' && field('taxiId').value === 'new';
    for (const el of form.querySelectorAll('[data-newtaxi]')) el.hidden = !newTaxi;
  };
  field('role').addEventListener('change', sync);
  field('taxiId').addEventListener('change', () => {
    sync();
    if (field('taxiId').value === 'new') field('plate').focus();
  });
  sync();
  form.addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'save') return;
    e.preventDefault(); // keep the dialog open until the server agrees
    const body = { name: field('name').value, role: field('role').value, active: field('active').checked };
    if (body.role === 'marshal') body.rankId = Number(field('rankId').value);
    if (body.role === 'driver') Object.assign(body, taxiChoice(field('taxiId').value, field('plate').value, field('seats').value));
    try {
      toast((await api(`/api/users/${u.id}`, { method: 'PUT', body })).message);
      dlg.close();
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
}

$('#list').addEventListener('click', async (e) => {
  const edit = e.target.closest('[data-edit]');
  if (edit) return editDialog(users.find((u) => u.id === Number(edit.dataset.edit)));
  const reset = e.target.closest('[data-reset]');
  if (!reset) return;
  const u = users.find((x) => x.id === Number(reset.dataset.reset));
  const ok = await confirmDialog(`New PIN for ${u.name}?`, `Their old PIN stops working and they are signed out on every phone. They choose their own PIN when they next sign in.`, 'Make a new PIN', { danger: true });
  if (!ok) return;
  await busy(reset, async () => {
    try {
      const r = await api(`/api/users/${u.id}/pin`, { method: 'POST', body: {} });
      await load();
      showPin(u.name, r.pin);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
});

load();
