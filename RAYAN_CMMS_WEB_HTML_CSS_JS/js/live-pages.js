const LIVE_PAGES = new Set(['dashboard', 'work-orders', 'pm-schedule', 'plants', 'new-equipment', 'equipment', 'sop', 'machine-records', 'lubrication', 'daily-reports', 'motor-condition', 'iso', 'spare-parts']);
const DEFAULT_TAB = {
  dashboard: 'All',
  'work-orders': 'All Work Orders',
  'pm-schedule': 'Annual plan',
  plants: 'All Plants',
  'new-equipment': 'Pending',
  equipment: 'All Equipment',
  sop: 'All SOPs',
  'machine-records': 'All',
  lubrication: 'Report',
  'daily-reports': 'My Reports',
  'motor-condition': 'Sheet',
  iso: 'All',
  'spare-parts': 'All',
};
const shellRender = render;
const ui = { page: 'dashboard', tab: 'All', rowKey: '', mode: 'view', plantId: '', plantIds: [], lineId: '', sectionId: '', equipmentId: '', spareEquipment: '', technicianId: '', dateFrom: '', dateTo: '', annualPlant: '', annualYear: new Date().getFullYear(), annualItems: [], annualWeek: '', annualCopy: null, weekTasks: [], lubeId: '', dailyId: '', dailyFilter: '' };
const ANNUAL_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_MAINTENANCE_TYPES = ['Preventive', 'Corrective', 'Emergency', 'Routine', 'Inspection', 'Lubrication'];
let store = null;
let isoForms = null;
let paintToken = 0;
const FORM_DEFAULTS = {
  daily: 'DR',
  job_order: 'PMF 17-04',
  lubrication: 'PMF 17-05 rev.a',
  motor: 'PMF 25-6',
  equipment_log: '',
  annual_plan: '',
};
function formNo(key) {
  const value = isoForms && Object.prototype.hasOwnProperty.call(isoForms, key) ? isoForms[key] : FORM_DEFAULTS[key];
  return value == null ? '' : String(value);
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

const CRITICALITY_LEVELS = ['Critical', 'Very important', 'Important'];

function criticalityLabel(value) {
  return { A: 'Critical', B: 'Very important', C: 'Important' }[value] || value || '—';
}

function isCriticalAsset(item) {
  const level = criticalityLabel(item?.criticality);
  return level === 'Critical';
}

function liveBadge(text) {
  const value = text == null || text === '' ? '—' : String(text);
  let tone = 'blue';
  if (/Completed|Operational|Published|Good|Running|Closed|Active|Approved/i.test(value)) tone = 'green';
  else if (/Overdue|Out of|High|Rejected|Cancelled|^Critical$/i.test(value)) tone = 'red';
  else if (/Progress|Maintenance|Due|Medium|Upcoming|Returned|Submitted|Very important/i.test(value)) tone = 'orange';
  else if (/Draft|Approval|Hold|Inactive|Low/i.test(value)) tone = 'purple';
  return `<span class="badge ${tone}">${esc(t(value))}</span>`;
}

function fmtDate(value) {
  if (!value) return '—';
  const [year, month, day] = String(value).slice(0, 10).split('-');
  return day ? `${day}/${month}/${year}` : esc(value);
}

function todayStamp() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now;
}

function dayDiff(value) {
  if (!value) return null;
  const due = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  return Math.round((due - todayStamp()) / 86400000);
}

function matchEquipment(text) {
  const raw = String(text || '').trim().toLowerCase();
  if (!raw || !store?.equipment) return null;
  const byId = store.equipment.find((item) => String(item.equipment_id).toLowerCase() === raw);
  if (byId) return byId;
  const labeled = store.equipment.find((item) => `${item.equipment_id} — ${item.name}`.toLowerCase() === raw || `${item.equipment_id} - ${item.name}`.toLowerCase() === raw);
  if (labeled) return labeled;
  const byName = store.equipment.filter((item) => String(item.name || '').trim().toLowerCase() === raw);
  return byName.length === 1 ? byName[0] : null;
}

function equipmentLineNumber(found) {
  if (!found?.line_id || !store?.lines) return '';
  const line = store.lines.find((row) => row.line_id === found.line_id);
  return line?.line_number != null && line.line_number !== '' ? String(line.line_number) : '';
}

function equipmentByCode(code) {
  const needle = String(code || '').trim().toLowerCase();
  if (!needle) return null;
  const rows = store.equipment.filter((item) => String(item.equipment_id).toLowerCase() === needle);
  return rows.find((item) => item.plant_id === ui.annualPlant) || rows[0] || null;
}

function bindEquipmentCode(codeInput, nameInput) {
  let timer = 0;
  const applyKnown = (found) => {
    if (!found) return false;
    nameInput.value = found.name || found.equipment_name || '';
    if (found.equipment_id) codeInput.value = found.equipment_id;
    const row = codeInput.closest('tr');
    const lineInput = row?.querySelector('[data-field="line"]');
    const lineNumber = equipmentLineNumber(found);
    if (lineInput && lineNumber) {
      lineInput.dataset.resolved = '';
      lineInput.value = lineNumber;
    }
    if (row) {
      showDailyLineName(row);
      fillLubePlace(row, found.plant_id || '', found.line_id || '');
    }
    if (found.plant_id) {
      const rowPlant = row?.querySelector('[data-field="plant"]');
      if (rowPlant) rowPlant.value = found.plant_id;
    }
    return true;
  };
  const run = async () => {
    const code = codeInput.value.trim();
    if (!code) return;
    if (applyKnown(equipmentByCode(code))) return;
    try {
      const data = await apiRequest(`/equipment/lookup?code=${encodeURIComponent(code)}${ui.annualPlant ? `&plant_id=${encodeURIComponent(ui.annualPlant)}` : ''}`);
      if (codeInput.value.trim().toLowerCase() !== code.toLowerCase()) return;
      const match = (data.matches || [])[0];
      if (!match) return;
      applyKnown(match);
      if (!equipmentByCode(match.equipment_id)) store.equipment.push({ equipment_id: match.equipment_id, name: match.equipment_name, plant_id: match.plant_id, line_id: match.line_id });
    } catch (exception) {
      /* an unknown number keeps the name typed on the task */
    }
  };
  codeInput.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(run, 250);
  });
  codeInput.addEventListener('change', run);
}

function lubeLineOptions(plantId, selected = '') {
  const lines = (store.lines || []).filter((line) => !plantId || line.plant_id === plantId);
  return `<option value="">${esc(t(plantId ? 'Select line number' : 'Select a plant first'))}</option>${lines.map((line) => `<option value="${esc(line.line_id)}"${line.line_id === selected ? ' selected' : ''}>${esc(jobLineLabel(line))}</option>`).join('')}`;
}

function fillLubePlace(row, plantId = '', lineId = '') {
  const plantSelect = row?.querySelector('[data-field="plant_id"]');
  const lineSelect = row?.querySelector('[data-field="line_id"]');
  if (!plantSelect || !lineSelect) return;
  if (plantId) plantSelect.value = plantId;
  lineSelect.innerHTML = lubeLineOptions(plantSelect.value, lineId || lineSelect.value);
  if (lineId) lineSelect.value = lineId;
}

function lubeQtyUnit(workType) {
  if (workType === 'Oil change') return t('Litre');
  if (workType === 'Grease change') return t('Gram');
  return '';
}

function syncLubeQtyUnit(row) {
  const unit = row?.querySelector('[data-qty-unit]');
  if (!unit) return;
  unit.textContent = lubeQtyUnit(row.querySelector('[data-field="work_type"]')?.value);
}

function bindLubeRow(row) {
  const code = row.querySelector('[data-field="equipment_code"]');
  const name = row.querySelector('[data-field="equipment_name"]');
  if (code && name) bindEquipmentCode(code, name);
  const plantSelect = row.querySelector('[data-field="plant_id"]');
  const lineSelect = row.querySelector('[data-field="line_id"]');
  plantSelect?.addEventListener('change', () => {
    lineSelect.innerHTML = lubeLineOptions(plantSelect.value, '');
  });
  const found = matchEquipment(code?.value) || equipmentByCode(code?.value);
  if (found) fillLubePlace(row, found.plant_id || plantSelect?.value || '', found.line_id || lineSelect?.value || '');
  else if (plantSelect) lineSelect.innerHTML = lubeLineOptions(plantSelect.value, lineSelect.value);
  row.querySelector('[data-field="work_type"]')?.addEventListener('change', () => syncLubeQtyUnit(row));
  syncLubeQtyUnit(row);
}

function toast(message) {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.classList.add('show');
  setTimeout(() => node.classList.remove('show'), 2800);
}

let screenNoticeTimer = 0;
function screenNotice(message, kind = 'ok') {
  let node = document.getElementById('screen-notice');
  if (!node) {
    node = document.createElement('div');
    node.id = 'screen-notice';
    node.setAttribute('role', 'status');
    document.body.appendChild(node);
  }
  node.textContent = message;
  node.classList.toggle('error', kind === 'error');
  node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  node.classList.add('show');
  window.clearTimeout(screenNoticeTimer);
  screenNoticeTimer = window.setTimeout(() => {
    node.classList.remove('show');
    node.classList.remove('error');
  }, kind === 'error' ? 7000 : 4500);
}

function showReportAlert(message, formId = 'daily') {
  const text = t(message || '');
  const alert = document.getElementById(`${formId}-alert`);
  if (alert) {
    alert.hidden = !text;
    alert.textContent = text;
    if (text) {
      alert.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      const paper = alert.closest('.lube-paper');
      if (paper) paper.scrollTop = 0;
    }
  }
  if (text) screenNotice(text, 'error');
}

function clearReportAlert(formId = 'daily') {
  const alert = document.getElementById(`${formId}-alert`);
  if (!alert) return;
  alert.hidden = true;
  alert.textContent = '';
}

function canMaintain() {
  const user = getSavedUser();
  return Boolean(user && (user.role === 'SYSTEM_DEVELOPER' || user.role === 'MAINTENANCE_ENGINEER'));
}

function isLubricationTechnician() {
  return getSavedUser()?.role === 'LUBRICATION_TECHNICIAN';
}

function canSeeMotor() {
  const role = getSavedUser()?.role;
  return role === 'SYSTEM_DEVELOPER' || role === 'MAINTENANCE_ENGINEER' || role === 'LUBRICATION_TECHNICIAN';
}

function isTechnician() {
  const role = getSavedUser()?.role;
  return role === 'TECHNICIAN' || role === 'LUBRICATION_TECHNICIAN';
}

function equipmentOf(code) {
  return store.equipment.find((item) => item.equipment_id === code) || null;
}

function technicianName(code) {
  return store.technicians.find((item) => item.technician_id === code)?.name || code || '—';
}

function assigneeIds(order) {
  const listed = Array.isArray(order?.assigned_technician_ids) ? order.assigned_technician_ids.filter(Boolean) : [];
  if (listed.length) return listed;
  return order?.assigned_technician_id ? [order.assigned_technician_id] : [];
}

function assigneeNames(order) {
  const states = new Map((order?.assignment_states || []).map((row) => [row.technician_id, row.response]));
  const names = assigneeIds(order).map((id) => {
    const name = technicianName(id);
    const response = states.get(id);
    return response && name !== '—' ? `${name} (${response})` : name;
  }).filter((name) => name && name !== '—');
  return names.length ? names.join(', ') : '—';
}

function myResponse(order) {
  const me = getSavedUser()?.technician_id;
  if (!me || !order || !assigneeIds(order).includes(me)) return '';
  return (order.assignment_states || []).find((row) => row.technician_id === me)?.response || 'Pending';
}

function technicianChecks(selectedIds) {
  const chosen = new Set(selectedIds || []);
  const boxes = store.technicians.map((item) => `<label><input type="checkbox" name="assigned_technician_ids" value="${esc(item.technician_id)}"${chosen.has(item.technician_id) ? ' checked' : ''}> ${esc(item.name)}</label>`).join('');
  return `<div class="assignee-list">${boxes || `<span>${esc(t('No technicians'))}</span>`}</div>`;
}

function lineText(line) {
  if (!line) return '';
  if (line.line_number != null && line.line_number !== '') return `Line ${line.line_number}`;
  return line.name || line.line_id || '';
}

function lineSections(lineId) {
  return (store.sections || []).filter((section) => section.line_id === lineId).sort((a, b) => Number(a.sort_order) - Number(b.sort_order) || String(a.name).localeCompare(String(b.name)));
}

function sectionName(sectionId) {
  return (store.sections || []).find((section) => section.section_id === sectionId)?.name || '';
}

function sectionOptions(lineId, selected = '', emptyLabel = 'No section') {
  return `<option value="">${esc(t(emptyLabel))}</option>${lineSections(lineId).map((section) => `<option value="${esc(section.section_id)}"${section.section_id === selected ? ' selected' : ''}>${esc(section.name)}</option>`).join('')}`;
}

function placeOf(item) {
  if (!item) return '—';
  const plant = store.plants.find((row) => row.plant_id === item.plant_id)?.name || item.plant_id;
  const line = lineText(store.lines.find((row) => row.line_id === item.line_id));
  const section = sectionName(item.section_id);
  return [plant, line, section].filter(Boolean).join(' / ') || '—';
}

function equipmentText(row) {
  const code = row.equipment_id || row.manual_equipment_code;
  const known = equipmentOf(code);
  const name = known?.name || row.manual_equipment_name || row.equipment_name;
  if (!code && !name) return '—';
  return name ? `${name} (${code || 'manual'})` : code;
}

function visibleEquipment() {
  const plants = selectedPlantIds();
  return store.equipment.filter((item) => {
    if (plants.length && !plants.includes(item.plant_id)) return false;
    if (!plants.length && ui.plantId && item.plant_id !== ui.plantId) return false;
    if (ui.lineId && item.line_id !== ui.lineId) return false;
    if (ui.sectionId && item.section_id !== ui.sectionId) return false;
    if (ui.equipmentId && item.equipment_id !== ui.equipmentId) return false;
    return true;
  });
}

function scoped(rows) {
  if (!(ui.plantIds || []).length && !ui.plantId && !ui.lineId && !ui.sectionId && !ui.equipmentId) return rows;
  const ids = new Set(visibleEquipment().map((item) => item.equipment_id));
  return rows.filter((row) => ids.has(row.equipment_id || row.manual_equipment_code));
}

function closed(order) {
  return order.status === 'Closed' || order.status === 'Completed';
}

function overdue(order) {
  if (order.status === 'Overdue') return true;
  const diff = dayDiff(order.planned_date);
  return diff !== null && diff < 0 && !closed(order) && order.status !== 'Cancelled';
}

function pmStatus(plan) {
  if (!plan.active) return 'Inactive';
  const diff = dayDiff(plan.next_due_date);
  if (diff === null) return 'Unscheduled';
  if (diff < 0) return 'Overdue';
  if (diff === 0) return 'Due Today';
  if (diff <= 7) return 'Due This Week';
  if (diff <= 31) return 'Due This Month';
  return 'Upcoming';
}

function numberText(value, digits = 0) {
  const amount = Number(value) || 0;
  return digits ? amount.toFixed(digits) : String(Math.round(amount));
}

function sum(rows, field) {
  return rows.reduce((total, row) => total + (Number(row[field]) || 0), 0);
}

async function loadStore() {
  const [plants, lines, sections, equipment, orders, plans, sops, records, technicians, pending, forms] = await Promise.all([
    apiRequest('/plants'),
    apiRequest('/lines'),
    apiRequest('/sections'),
    apiRequest('/equipment'),
    apiRequest('/work-orders'),
    apiRequest('/pm'),
    apiRequest('/sops'),
    apiRequest('/machine-records'),
    apiRequest('/technicians'),
    canMaintain() ? apiRequest('/pending-equipment') : Promise.resolve([]),
    apiRequest('/form-numbers'),
  ]);
  isoForms = forms;
  store = { plants, lines, sections, equipment, orders, plans, sops, records, technicians, pending };
}

function setHeader(page) {
  const spec = pages[page] || pages.dashboard;
  document.getElementById('page-title').textContent = t(spec.title);
  const subtitle = spec.sub;
  document.getElementById('page-subtitle').textContent = t(subtitle);
  const action = document.getElementById('primary-action');
  const draft = document.getElementById('draft-action');
  if (draft) {
    draft.hidden = !(page === 'daily-reports' && isTechnician());
    draft.textContent = t('Save draft');
  }
  if (page === 'daily-reports' && isTechnician()) {
    action.hidden = false;
    action.textContent = t('Send report');
  } else if (page === 'lubrication' || page === 'motor-condition') {
    action.hidden = true;
  } else if (page === 'sop') {
    action.hidden = true;
  } else if (isTechnician()) {
    action.hidden = true;
    action.textContent = t('+ Add Equipment');
  } else {
    action.hidden = false;
    action.textContent = t(page === 'machine-records' ? 'Export' : spec.action);
  }
  document.querySelectorAll('.engineer-only').forEach((link) => {
    link.hidden = !canMaintain();
  });
  document.querySelectorAll('.motor-nav').forEach((link) => {
    link.hidden = !canSeeMotor();
  });
  document.querySelectorAll('.nav-link').forEach((link) => link.classList.toggle('active', link.dataset.page === page));
  if (location.hash !== `#${page}`) location.hash = page;
}

function dateLabel(dates) {
  const button = document.querySelector('.date-button span');
  if (!button) return;
  const valid = dates.filter(Boolean).map((value) => String(value).slice(0, 10)).sort();
  button.textContent = valid.length ? `${fmtDate(valid[0])} - ${fmtDate(valid[valid.length - 1])}` : t('No dated records');
}

function openPlants(keepId = '') {
  return (store?.plants || []).filter((plant) => plant.active !== false || (keepId && plant.plant_id === keepId));
}

function currentFilters() {
  return {
    plantId: ui.plantId || '',
    lineId: ui.lineId || '',
    sectionId: ui.sectionId || '',
    equipmentId: ui.equipmentId || '',
  };
}

function selectedPlantIds() {
  const openIds = new Set((store.plants || []).filter((plant) => plant.active !== false).map((plant) => plant.plant_id));
  const chosen = (ui.plantIds || []).filter((id) => openIds.has(id));
  if (chosen.length !== (ui.plantIds || []).length) ui.plantIds = chosen;
  if (ui.plantId && !chosen.includes(ui.plantId)) {
    if (chosen.length === 1) ui.plantId = chosen[0];
    else if (!chosen.length) ui.plantId = '';
  }
  return chosen;
}

function syncPlantSelection(ids) {
  const unique = [...new Set((ids || []).filter(Boolean))];
  ui.plantIds = unique;
  ui.plantId = unique.length === 1 ? unique[0] : '';
}

function equipmentIdsWithSopFile() {
  return new Set(
    oneSopPerEquipment(store.sops || [])
      .filter((sop) => sop.equipment_id && (/Published|Approved/i.test(sop.status || '') || sop.document_path))
      .map((sop) => sop.equipment_id),
  );
}

function filtersHtml(options = {}) {
  const multiPlant = Boolean(options.multiPlant);
  const sopOnly = Boolean(options.sopOnly);
  const openIds = new Set((store.plants || []).filter((plant) => plant.active !== false).map((plant) => plant.plant_id));
  const plants = selectedPlantIds();
  if (ui.plantId && !openIds.has(ui.plantId) && !plants.length) {
    ui.plantId = '';
    ui.plantIds = [];
    ui.lineId = '';
    ui.sectionId = '';
    ui.equipmentId = '';
  }
  const plantScope = plants.length ? new Set(plants) : openIds;
  const scopedLines = plants.length > 1
    ? store.lines.filter((line) => plantScope.has(line.plant_id))
    : store.lines.filter((line) => openIds.has(line.plant_id) && (!ui.plantId || line.plant_id === ui.plantId));
  const lineIds = new Set(scopedLines.map((line) => line.line_id));
  const sections = (store.sections || []).filter((section) => lineIds.has(section.line_id) && (!ui.lineId || section.line_id === ui.lineId));
  if (ui.sectionId && !sections.some((section) => section.section_id === ui.sectionId)) ui.sectionId = '';
  if (ui.lineId && !lineIds.has(ui.lineId)) ui.lineId = '';
  const withSop = sopOnly ? equipmentIdsWithSopFile() : null;
  const equipment = store.equipment.filter((item) => (!item.plant_id || openIds.has(item.plant_id)) && (!plants.length || plantScope.has(item.plant_id)) && (!ui.lineId || item.line_id === ui.lineId) && (!ui.sectionId || item.section_id === ui.sectionId) && (!withSop || withSop.has(item.equipment_id)));
  if (ui.equipmentId && !equipment.some((item) => item.equipment_id === ui.equipmentId)) ui.equipmentId = '';
  const option = (value, label, selected) => `<option value="${esc(value)}"${selected === value ? ' selected' : ''}>${esc(label)}</option>`;
  const plantSummary = plants.length
    ? (plants.length === 1
      ? (openPlants().find((plant) => plant.plant_id === plants[0])?.name || plants[0])
      : `${plants.length} ${t('plants selected')}`)
    : t('All plants');
  const plantFilter = multiPlant
    ? `<div class="plant-menu">
        <span class="plant-menu-label">${esc(t('Plants'))}</span>
        <button type="button" class="plant-menu-toggle" id="plant-menu-toggle" aria-expanded="false" aria-haspopup="listbox">
          <span class="plant-menu-summary" id="plant-menu-summary">${esc(plantSummary)}</span>
          <span class="plant-menu-caret" aria-hidden="true">▾</span>
        </button>
        <div class="plant-menu-panel" id="plant-menu-panel" data-filter="plants" hidden role="listbox" aria-label="${esc(t('Plants'))}">
          ${openPlants().map((plant) => `<label class="plant-menu-item"><input type="checkbox" value="${esc(plant.plant_id)}"${plants.includes(plant.plant_id) ? ' checked' : ''}><span>${esc(plant.name)}</span></label>`).join('') || `<p class="plant-menu-empty">${esc(t('No plants'))}</p>`}
          <button type="button" class="plant-menu-clear" id="plant-menu-clear">${esc(t('All plants'))}</button>
        </div>
      </div>`
    : `<label>${t('Plant')}<select data-filter="plant">${option('', t('All plants'), ui.plantId)}${openPlants().map((plant) => option(plant.plant_id, plant.name, ui.plantId)).join('')}</select></label>`;
  return `<div class="live-filters">
    ${plantFilter}
    <label>${t('Line')}<select data-filter="line">${option('', t('All lines'), ui.lineId)}${scopedLines.map((line) => option(line.line_id, line.name, ui.lineId)).join('')}</select></label>
    <label>${t('Section')}<select data-filter="section">${option('', t('All sections'), ui.sectionId)}${sections.map((section) => option(section.section_id, section.name, ui.sectionId)).join('')}</select></label>
    <label>${t('Equipment')}<select data-filter="equipment">${option('', t('All equipment'), ui.equipmentId)}${equipment.map((item) => option(item.equipment_id, `${item.equipment_id} — ${item.name}`, ui.equipmentId)).join('')}</select></label>
  </div>`;
}

function tableShell(columns, rows, footer) {
  const body = rows.length ? rows.join('') : `<tr><td class="live-note" colspan="${columns.length}">${esc(t('No records yet'))}</td></tr>`;
  return `<div class="table-wrap"><table class="data-table"><thead><tr>${columns.map((column) => `<th>${esc(t(column))}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div><footer class="pagination"><span>${footer}</span></footer>`;
}

function cell(value, code = false) {
  return `<td${code ? ' class="code"' : ''}>${value}</td>`;
}

function detailRows(pairs) {
  return pairs.map(([label, value]) => `<div><b>${esc(t(label))}</b><span>${esc(value == null || value === '' ? '—' : t(value))}</span></div>`).join('');
}

function detailPanel(title, badgeText, heading, sub, pairs) {
  return `<aside class="panel detail"><h2>${esc(t(title))}</h2><div class="detail-top"><div class="machine">⚙</div>${liveBadge(badgeText)}<h3>${esc(heading || '—')}</h3><p>${esc(sub || '')}</p></div><div class="detail-list">${detailRows(pairs)}</div></aside>`;
}

function formPanel(title, fields) {
  return `<aside class="panel detail"><h2>${esc(t(title))}</h2><form class="live-form" id="live-form">${fields}<p id="live-form-error" class="form-error"></p><button class="detail-button primary" type="submit">${esc(t('Save'))}</button></form></aside>`;
}

function field(label, html) {
  return `<label>${esc(t(label))}${html}</label>`;
}

function selectField(name, options, required = true) {
  return `<select name="${name}"${required ? ' required' : ''}><option value="">${esc(t('Select'))}</option>${options}</select>`;
}

function equipmentOptions() {
  return store.equipment.map((item) => `<option value="${esc(item.equipment_id)}">${esc(item.equipment_id)} — ${esc(item.name)}</option>`).join('');
}

function areaChart(series, unit = 'h', options = {}) {
  const settings = options && typeof options === 'object' ? options : {};
  const palette = ['#075cf5', '#009c63', '#ff710d', '#7439f5', '#fa3038', '#17adae', '#0b2558', '#d4a017', '#0ea5e9', '#c026d3'];
  const rows = (series || []).filter((row) => row.points?.length);
  if (!rows.length) return '';
  const width = 320;
  const height = 168;
  const pad = { left: 28, right: 8, top: 12, bottom: 28 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const dates = rows[0].points.map((point) => point.date);
  const count = dates.length;
  const limit = Number(settings.limit);
  const hasLimit = Number.isFinite(limit) && limit > 0;
  const max = Math.max(...rows.flatMap((row) => row.points.map((point) => Number(point.hours) || 0)), hasLimit ? limit : 0, 1);
  const chartId = `area${Math.random().toString(36).slice(2, 8)}`;
  const xAt = (index) => pad.left + (count === 1 ? innerW / 2 : (index / (count - 1)) * innerW);
  const yAt = (value) => pad.top + innerH - ((Number(value) || 0) / max) * innerH;
  const base = (pad.top + innerH).toFixed(1);
  const grid = [0, 0.5, 1].map((step) => {
    const value = max * (1 - step);
    const y = yAt(value);
    return `<line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${width - pad.right}" y2="${y.toFixed(1)}"></line><text x="${pad.left - 4}" y="${(y + 3).toFixed(1)}" text-anchor="end">${numberText(value, max >= 10 ? 0 : 1)}</text>`;
  }).join('');
  const labels = dates.map((day, index) => {
    if (count > 6 && index !== 0 && index !== count - 1 && index !== Math.floor((count - 1) / 2)) return '';
    return `<text x="${xAt(index).toFixed(1)}" y="${height - 6}" text-anchor="middle">${esc(fmtDate(day).slice(0, 5))}</text>`;
  }).join('');
  const shapes = rows.map((row, seriesIndex) => {
    const color = palette[seriesIndex % palette.length];
    const coords = row.points.map((point, index) => [
      xAt(index),
      point.hours == null || point.hours === '' ? null : yAt(point.hours),
    ]);
    let line = '';
    let drawing = false;
    coords.forEach((coord) => {
      if (coord[1] == null) {
        drawing = false;
        return;
      }
      line += `${drawing ? 'L' : 'M'}${coord[0].toFixed(1)},${coord[1].toFixed(1)}`;
      drawing = true;
    });
    const missing = coords.some((coord) => coord[1] == null);
    const area = missing || !line ? '' : `${line} L${coords[count - 1][0].toFixed(1)},${base} L${coords[0][0].toFixed(1)},${base} Z`;
    const dots = coords.map((coord, index) => {
      if (coord[1] == null) return '';
      const point = row.points[index];
      const hours = Number(point.hours) || 0;
      if (!hours) return '';
      const hot = point.high === true;
      const stroke = hot ? '#fa3038' : color;
      const title = point.status
        ? `${esc(t(row.name))} · ${esc(fmtDate(point.date))}: ${esc(t(point.status))}`
        : `${esc(t(row.name))} · ${esc(fmtDate(point.date))}: ${numberText(hours, 1)} ${esc(unit)}`;
      return `<circle cx="${coord[0].toFixed(1)}" cy="${coord[1].toFixed(1)}" r="3.2" fill="${hot ? '#fa3038' : '#fff'}" stroke="${stroke}"><title>${title}</title></circle>`;
    }).join('');
    const fill = area ? `<path class="area-fill" d="${area}" style="fill:url(#${chartId}${seriesIndex})"></path>` : '';
    return `${fill}<path class="area-line" d="${line}" style="stroke:${color}"></path>${dots}`;
  }).join('');
  const gradients = rows.map((row, seriesIndex) => {
    const color = palette[seriesIndex % palette.length];
    return `<linearGradient id="${chartId}${seriesIndex}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity="0.34"></stop><stop offset="100%" stop-color="${color}" stop-opacity="0.03"></stop></linearGradient>`;
  }).join('');
  const legend = rows.map((row, seriesIndex) => `<li><i style="background:${palette[seriesIndex % palette.length]}"></i><span>${esc(t(row.name))}</span></li>`).join('');
  const limitLine = hasLimit
    ? `<line x1="${pad.left}" y1="${yAt(limit).toFixed(1)}" x2="${width - pad.right}" y2="${yAt(limit).toFixed(1)}" stroke="#fa3038" stroke-width="1.4" stroke-dasharray="4 3"><title>${esc(t('Allowed temperature (°C)'))}: ${numberText(limit, 1)}</title></line>`
    : '';
  return `<svg class="area-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(settings.label || 'Downtime trend')}"><defs>${gradients}</defs><g class="area-grid">${grid}</g>${limitLine}${shapes}${labels}</svg><ul class="area-legend">${legend}</ul>`;
}

function donut(parts, total, digits = 1) {
  const active = parts.filter((part) => part.value > 0);
  let cursor = 0;
  const stops = active.map((part) => {
    const start = cursor;
    cursor += (part.value / total) * 100;
    return `${part.color} ${start}% ${cursor}%`;
  });
  const style = total ? `background:conic-gradient(${stops.join(',')})` : 'background:#e7ebf3';
  const legend = active.map((part) => `<li><i style="background:${part.color}"></i><span>${esc(t(part.name))}${digits ? '' : ` ${esc(numberText(part.value, 0))}`}</span></li>`).join('');
  return `<div class="donut live" data-label="${esc(numberText(total, digits))}&#10;${esc(t('Total'))}" style="${style}"></div><ul class="area-legend">${legend}</ul>`;
}

function bumpChart(series, title) {
  const rows = (series || []).filter((row) => (row.points || []).some((point) => point.score != null));
  if (!rows.length) return '';
  const dates = rows[0].points.map((point) => point.date);
  const count = dates.length;
  const ranks = dates.map(() => ({}));
  dates.forEach((day, index) => {
    rows
      .map((row) => ({ name: row.name, score: row.points[index]?.score }))
      .filter((item) => item.score != null)
      .sort((left, right) => right.score - left.score || String(left.name).localeCompare(String(right.name)))
      .forEach((item, order) => { ranks[index][item.name] = order + 1; });
  });
  const maxRank = Math.max(1, ...ranks.flatMap((day) => Object.values(day)));
  const width = 640;
  const rowH = 28;
  const pad = { left: 132, right: 148, top: 14, bottom: 28 };
  const innerW = width - pad.left - pad.right;
  const innerH = maxRank * rowH;
  const height = pad.top + innerH + pad.bottom;
  const xAt = (index) => pad.left + (count === 1 ? innerW / 2 : (index / (count - 1)) * innerW);
  const yAt = (rank) => pad.top + (rank - 0.5) * rowH;
  const shortName = (value) => {
    const text = String(value || '');
    return text.length > 18 ? `${text.slice(0, 17)}…` : text;
  };
  const lastRank = rows.map((row) => {
    let rank = 0;
    row.points.forEach((point, index) => {
      if (ranks[index][row.name]) rank = ranks[index][row.name];
    });
    return { name: row.name, rank };
  }).sort((left, right) => right.rank - left.rank || String(left.name).localeCompare(String(right.name)));
  const focus = lastRank[0]?.name || '';
  const grid = Array.from({ length: maxRank }, (_, index) => {
    const y = yAt(index + 1);
    const badge = width - 22;
    return `<line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}"></line><circle cx="${badge}" cy="${y}" r="9"></circle><text class="bump-rank" x="${badge}" y="${y + 3}" text-anchor="middle">${index + 1}</text>`;
  }).join('');
  const labels = dates.map((day, index) => {
    if (count > 6 && index !== 0 && index !== count - 1 && index !== Math.floor((count - 1) / 2)) return '';
    return `<text class="bump-date" x="${xAt(index)}" y="${height - 8}" text-anchor="middle">${esc(fmtDate(day).slice(0, 5))}</text>`;
  }).join('');
  const shapes = rows.map((row) => {
    const coords = row.points.map((point, index) => {
      const rank = ranks[index][row.name];
      return rank ? [xAt(index), yAt(rank), rank, point] : null;
    });
    let line = '';
    let drawing = false;
    coords.forEach((coord) => {
      if (!coord) {
        drawing = false;
        return;
      }
      line += `${drawing ? 'L' : 'M'}${coord[0].toFixed(1)},${coord[1].toFixed(1)}`;
      drawing = true;
    });
    const dots = coords.map((coord) => {
      if (!coord) return '';
      const point = coord[3];
      return `<circle cx="${coord[0].toFixed(1)}" cy="${coord[1].toFixed(1)}" r="4.5"><title>${esc(t(row.name))} · ${esc(fmtDate(point.date))}: ${esc(t(point.status || ''))} · ${coord[2]}</title></circle>`;
    }).join('');
    const left = coords[0];
    const right = coords[count - 1];
    const start = left ? `<text class="bump-name" x="${pad.left - 12}" y="${(left[1] + 4).toFixed(1)}" text-anchor="end">${esc(shortName(t(row.name)))}</text>` : '';
    const end = right ? `<text class="bump-name" x="${width - pad.right + 12}" y="${(right[1] + 4).toFixed(1)}" text-anchor="start">${esc(shortName(t(row.name)))}</text>` : '';
    return `<g class="bump-series${row.name === focus ? ' focus' : ''}">${line ? `<path d="${line}"></path>` : ''}${dots}${start}${end}</g>`;
  }).join('');
  return `<svg class="bump-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(t(title || 'Oil level'))}"><g class="bump-grid">${grid}</g>${labels}${shapes}</svg>`;
}

function motorScopeNote() {
  if (ui.equipmentId) return 'Selected equipment';
  if (ui.lineId) return 'Each equipment';
  if ((ui.plantIds || []).length > 1) return 'Each plant';
  if (ui.plantId) return 'Each line';
  return 'Each plant';
}

function kpiText(value, digits = 1, suffix = '') {
  if (value == null || value === '') return '—';
  return `${numberText(value, digits)}${suffix}`;
}

function kpiMove(actual, previous, higher) {
  if (actual == null || previous == null) return '';
  const delta = Number(actual) - Number(previous);
  if (!delta) return t('Same as the previous period');
  return `${delta > 0 ? '▲' : '▼'} ${numberText(Math.abs(delta), 1)} ${t('vs previous period')}`;
}

function kpiTargetText(actual, target, higher) {
  if (target == null) return t('Target not set for this level');
  if (actual == null) return `${t('Target')} ${numberText(target, 1)}`;
  const variance = higher ? Number(actual) - Number(target) : Number(target) - Number(actual);
  return `${t('Target')} ${numberText(target, 1)} · ${t('variance')} ${variance > 0 ? '+' : ''}${numberText(variance, 1)}`;
}

function shown(count, total, noun) {
  return `${t('Showing')} ${count} ${t('of')} ${total} ${t(noun)}`;
}

async function drawDashboard() {
  const params = new URLSearchParams();
  const plants = selectedPlantIds();
  plants.forEach((id) => params.append('plant_id', id));
  if (ui.lineId) params.set('line_id', ui.lineId);
  if (ui.equipmentId) params.set('equipment_id', ui.equipmentId);
  if (ui.technicianId) params.set('technician_id', ui.technicianId);
  if (ui.dateFrom) params.set('date_from', ui.dateFrom);
  if (ui.dateTo) params.set('date_to', ui.dateTo);
  const kpi = await apiRequest(`/kpi${params.toString() ? `?${params}` : ''}`);
  const previous = kpi.previous || {};
  const targets = kpi.targets || {};
  const hours = kpi.hours || {};
  document.getElementById('metric-grid').innerHTML = metrics([
    ['Availability', kpiText(kpi.availability, 1, '%'), '✓', 'green', kpiMove(kpi.availability, previous.availability, true)],
    ['MTBF (Hours)', kpiText(kpi.mtbf, 1), '▥', 'blue', kpiMove(kpi.mtbf, previous.mtbf, true)],
    ['MTTR (Hours)', kpiText(kpi.mttr, 2), '⚒', 'orange', kpiMove(kpi.mttr, previous.mttr, false)],
    ['PM Compliance', kpiText(kpi.pm_compliance, 1, '%'), '◷', 'blue', kpiMove(kpi.pm_compliance, previous.pm_compliance, true)],
    ['Downtime (Hours)', kpiText(kpi.downtime_h, 1), '◉', 'red', kpiMove(kpi.downtime_h, previous.downtime_h, false)],
    ['WO Completion', kpiText(kpi.wo_completion, 1, '%'), '▣', 'purple', kpiMove(kpi.wo_completion, previous.wo_completion, true)],
  ]);
  dateLabel([kpi.period?.from, kpi.period?.to]);
  const hourParts = [
    { name: 'Preventive', value: hours.Preventive || 0, color: '#1269f3' },
    { name: 'Corrective', value: hours.Corrective || 0, color: '#ff710d' },
    { name: 'Emergency', value: hours.Emergency || 0, color: '#fa3038' },
    { name: 'Routine', value: hours.Routine || 0, color: '#7439f5' },
    { name: 'Inspection', value: hours.Inspection || 0, color: '#009c63' },
  ];
  const counts = kpi.order_counts || {};
  const orderParts = [
    { name: 'Preventive', value: counts.Preventive || 0, color: '#1269f3' },
    { name: 'Corrective', value: counts.Corrective || 0, color: '#ff710d' },
    { name: 'Emergency', value: counts.Emergency || 0, color: '#fa3038' },
    { name: 'Routine', value: counts.Routine || 0, color: '#7439f5' },
    { name: 'Inspection', value: counts.Inspection || 0, color: '#009c63' },
    { name: 'Lubrication', value: counts.Lubrication || 0, color: '#008d9c' },
  ];
  const orderTotal = orderParts.reduce((sum, part) => sum + part.value, 0);
  const technicianOptions = store.technicians.map((row) => `<option value="${esc(row.technician_id)}"${ui.technicianId === row.technician_id ? ' selected' : ''}>${esc(row.name)}</option>`).join('');
  const extraFilters = `<label>${t('Technician')}<select data-filter="technician"><option value="">${esc(t('All technicians'))}</option>${technicianOptions}</select></label><label>${t('From')}<input data-filter="from" type="date" value="${esc(ui.dateFrom)}"></label><label>${t('To')}<input data-filter="to" type="date" value="${esc(ui.dateTo)}"></label>`;
  const card = (title, value, detail, note) => `<article class="kpi-card"><h3>${esc(t(title))}</h3><b>${value}</b><small>${esc(detail)}</small><small>${esc(note)}</small></article>`;
  const metricOption = (value, label) => `<option value="${value}">${esc(t(label))}</option>`;
  const targetForm = canMaintain() && plants.length <= 1 ? `<form id="kpi-target" class="live-form kpi-target"><b>${esc(t('KPI target for this plant / line / equipment'))}</b><label>${t('Metric')}<select name="metric">${metricOption('availability', 'Availability %')}${metricOption('utilization', 'Utilization %')}${metricOption('reliability', 'Reliability %')}${metricOption('mtbf', 'MTBF hours')}${metricOption('mttr', 'MTTR hours')}${metricOption('pm_compliance', 'PM compliance %')}${metricOption('downtime_h', 'Downtime hours')}${metricOption('planned_pm_pct', 'Planned PM %')}${metricOption('preventive_pct', 'Preventive %')}${metricOption('emergency_to_routine', 'Emergency to routine %')}${metricOption('emergency_to_preventive', 'Emergency to preventive %')}${metricOption('corrective_pct', 'Corrective %')}${metricOption('wo_schedule', 'Schedule compliance %')}${metricOption('wo_completion', 'WO completion %')}${metricOption('backlog', 'Backlog %')}${metricOption('failure_rate_1000h', 'Failures / 1,000 h')}</select></label><label>${t('Target')}<input name="target_value" type="number" min="0" step="0.1" required></label><button class="detail-button primary" type="submit">${esc(t('Save target'))}</button><p id="kpi-target-error" class="form-error"></p></form>` : '';
  const components = (kpi.components || []).map((row) => `<div class="summary-row"><span>${esc(row.component_id)} · ${esc(row.name)}</span><b>${row.life_days} ${t('days')}${row.in_service ? '' : ` ${t('removed')}`}</b></div>`).join('') || `<p class="chart-empty">${esc(t('No component installation dates yet'))}</p>`;
  const workspace = document.getElementById('workspace');
  workspace.className = 'workspace kpi-layout';
  workspace.innerHTML = `${filtersHtml({ multiPlant: true }).replace('</div>', `${extraFilters}</div>`)}
    <p class="kpi-period">${esc(t('Period'))} ${esc(fmtDate(kpi.period?.from))} – ${esc(fmtDate(kpi.period?.to))} · ${kpi.period?.days || 0} ${esc(t('days'))} · ${kpi.equipment_count || 0} ${esc(t('equipment'))} · ${esc(t('idle time is 0 because it is not recorded'))}</p>
    <section class="kpi-board">
      ${card('PM overdue', String(kpi.pm_overdue ?? 0), kpiTargetText(kpi.pm_overdue_pct, null, false), `${kpiText(kpi.pm_overdue_pct, 1, '%')} ${t('of')} ${kpi.pm_due || 0} ${t('due PM plans')}`)}
      ${card('Planned PM', kpiText(kpi.planned_pm_pct, 1, '%'), kpiTargetText(kpi.planned_pm_pct, targets.planned_pm_pct, true), `${kpi.planned_pm || 0} ${t('planned of')} ${kpi.pm_total || 0}`)}
      ${card('Unplanned PM', kpiText(kpi.unplanned_pm_pct, 1, '%'), t('Added from an identified need'), `${kpi.unplanned_pm || 0} ${t('unplanned of')} ${kpi.pm_total || 0}`)}
      ${card('Corrective maintenance', kpiText(kpi.corrective_pct, 1, '%'), kpiTargetText(kpi.corrective_pct, targets.corrective_pct, false), `${kpiText(hours.Corrective, 1)} ${t('h of')} ${kpiText(kpi.total_hours, 1)}`)}
      ${card('Preventive maintenance', kpiText(kpi.preventive_pct, 1, '%'), kpiTargetText(kpi.preventive_pct, targets.preventive_pct, true), `${kpiText(hours.Preventive, 1)} ${t('h of')} ${kpiText(kpi.total_hours, 1)}`)}
      ${card('Utilization', kpiText(kpi.utilization, 1, '%'), kpiTargetText(kpi.utilization, targets.utilization, true), `${kpiText(kpi.utilization_operating_h, 1)} ${t('h operating of')} ${kpiText(kpi.utilization_available_h, 1)} · ${kpi.utilization_reports || 0} ${t('reports × 8 h')}`)}
      ${card('Reliability', kpiText(kpi.reliability, 1, '%'), kpiTargetText(kpi.reliability, targets.reliability, true), kpi.mtbf == null ? t('No failures in this operating time') : `e^(− ${kpiText(kpi.operating_h, 1)} / ${kpiText(kpi.mtbf, 1)})`)}
      ${card('Emergency to routine', kpiText(kpi.emergency_to_routine, 1, '%'), kpiTargetText(kpi.emergency_to_routine, targets.emergency_to_routine, false), `${kpiText(hours.Emergency, 1)} ${t('h emergency /')} ${kpiText(hours.Routine, 1)} ${t('h routine')}`)}
      ${card('Emergency to preventive', kpiText(kpi.emergency_to_preventive, 1, '%'), kpiTargetText(kpi.emergency_to_preventive, targets.emergency_to_preventive, false), `${kpiText(hours.Emergency, 1)} ${t('h emergency /')} ${kpiText(hours.Preventive, 1)} ${t('h preventive')}`)}
      ${card('Schedule compliance', kpiText(kpi.wo_schedule, 1, '%'), kpiTargetText(kpi.wo_schedule, targets.wo_schedule, true), `${kpi.wo_scheduled_done || 0} ${t('completed of')} ${kpi.wo_scheduled || 0} ${t('scheduled')} · ${t('emergency excluded')}`)}
      ${card('Overdue work orders', String(kpi.wo_overdue ?? 0), `${kpiText(kpi.wo_overdue_pct, 1, '%')} ${t('of issued orders')}`, `${t('Aging')} 1–7: ${kpi.wo_aging?.['1-7'] || 0} · 8–30: ${kpi.wo_aging?.['8-30'] || 0} · 31+: ${kpi.wo_aging?.['31+'] || 0}`)}
      ${card('Backlog', kpiText(kpi.backlog, 1, '%'), kpiTargetText(kpi.backlog, targets.backlog, false), `${kpi.wo_open || 0} ${t('unexecuted of')} ${kpi.wo_issued || 0}`)}
      ${card('Failure count', String(kpi.failures ?? 0), t('Corrective and emergency events only'), t('PM, inspection and lubrication are not counted'))}
      ${card('Failure rate', kpiText(kpi.failure_rate_1000h, 2), kpiTargetText(kpi.failure_rate_1000h, targets.failure_rate_1000h, false), t('Failures per 1,000 operating hours'))}
    </section>
    <div class="kpi-pair">
    <section class="panel chart-panel"><h2>${esc(t('Maintenance hours'))}</h2><p class="kpi-note">${esc(t('Total'))} ${kpiText(kpi.total_hours, 1)} ${esc(t('from daily reports and work orders.'))}</p>${kpi.total_hours ? donut(hourParts, kpi.total_hours) : `<p class="chart-empty">${esc(t('No maintenance hours yet'))}</p>`}</section>
    <section class="panel chart-panel"><h2>${esc(t('Work orders by type'))}</h2><p class="kpi-note">${esc(t('Total'))} ${numberText(orderTotal, 0)} ${esc(t('work orders in this period.'))}</p>${orderTotal ? donut(orderParts, orderTotal, 0) : `<p class="chart-empty">${esc(t('No work orders in this period'))}</p>`}</section>
    </div>
    <section class="panel chart-panel chart-wide"><h2>${esc(t('Downtime trend'))}</h2><p class="kpi-note">${esc(t(kpi.trend_by === 'line' ? 'Each line' : kpi.trend_by === 'equipment' ? 'Selected equipment' : 'Each plant'))} · ${esc(t('scheduled'))} ${kpiText(kpi.scheduled_downtime_h, 1)} · ${esc(t('unscheduled'))} ${kpiText(kpi.unscheduled_downtime_h, 1)}</p>${kpi.trend_series?.length ? areaChart(kpi.trend_series) : `<p class="chart-empty">${esc(t('No downtime in this period'))}</p>`}</section>
    <section class="panel chart-panel chart-wide"><h2>${esc(t('Motor temperature'))}</h2><p class="kpi-note">${esc(t(ui.equipmentId ? 'Temperature of the selected equipment.' : 'Average of the recorded readings on each measurement day.'))}</p>${(kpi.motor?.temperature || []).some((row) => (row.points || []).some((point) => point.hours != null)) ? areaChart(kpi.motor.temperature, '°C') : `<p class="chart-empty">${esc(t('No motor readings in this period.'))}</p>`}</section>
    <section class="panel chart-panel chart-wide"><h2>${esc(t('Oil level'))}</h2><p class="kpi-note">${esc(t(motorScopeNote()))} · ${esc(t('Rank 1 is the best reading on that day.'))}</p>${bumpChart(kpi.motor?.oil_level, 'Oil level') || `<p class="chart-empty">${esc(t('No motor readings in this period.'))}</p>`}</section>
    <section class="panel chart-panel chart-wide"><h2>${esc(t('Oil condition'))}</h2><p class="kpi-note">${esc(t(motorScopeNote()))} · ${esc(t('Rank 1 is the best reading on that day.'))}</p>${bumpChart(kpi.motor?.oil_condition, 'Oil condition') || `<p class="chart-empty">${esc(t('No motor readings in this period.'))}</p>`}</section>
    <section class="panel chart-panel"><h2>${esc(t('Availability basis'))}</h2><div class="summary-row"><span>${esc(t('Uptime'))}</span><b>${kpiText(kpi.uptime_h, 1)} ${esc(t('h'))}</b></div><div class="summary-row"><span>${esc(t('Available time'))}</span><b>${kpiText(kpi.available_h, 1)} ${esc(t('h'))}</b></div><div class="summary-row"><span>${esc(t('Idle time'))}</span><b>${kpiText(kpi.idle_h, 1)} ${esc(t('h'))}</b></div><div class="summary-row"><span>${esc(t('Operating time'))}</span><b>${kpiText(kpi.operating_h, 1)} ${esc(t('h'))}</b></div><small class="kpi-note">${esc(t('Availability = uptime ÷ (available − idle). MTBF = operating time ÷ failures. MTTR = corrective hours ÷ corrective events.'))}</small></section>
    <section class="panel chart-panel"><h2>${esc(t('Work orders and PM'))}</h2><div class="summary-row"><span>${esc(t('Issued / completed'))}</span><b>${kpi.wo_issued || 0} / ${kpi.wo_completed || 0}</b></div><div class="summary-row"><span>${esc(t('PM due / on time'))}</span><b>${kpi.pm_due || 0} / ${kpi.pm_on_time || 0}</b></div><div class="summary-row"><span>${esc(t('Corrective events'))}</span><b>${kpi.corrective_events || 0}</b></div><div class="summary-row"><span>${esc(kpiTargetText(kpi.availability, targets.availability, true))}</span><b>${esc(t('Availability'))}</b></div><div class="summary-row"><span>${esc(kpiTargetText(kpi.mtbf, targets.mtbf, true))}</span><b>${esc(t('MTBF'))}</b></div><div class="summary-row"><span>${esc(kpiTargetText(kpi.mttr, targets.mttr, false))}</span><b>${esc(t('MTTR'))}</b></div>${targetForm}</section>
    <section class="panel chart-panel"><h2>${esc(t('Component life'))}</h2><p class="kpi-note">${esc(t('Removal date − installation date. In-service components use today.'))}</p>${components}<div class="summary-row"><span>${esc(t('Average life'))}</span><b>${kpi.component_life_avg == null ? '—' : `${kpi.component_life_avg} ${t('days')}`}</b></div></section>`;
  bindFilters();
  document.getElementById('kpi-target')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = document.getElementById('kpi-target-error');
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      await apiRequest('/kpi/targets', { method: 'PUT', body: JSON.stringify({ metric: data.metric, target_value: Number(data.target_value), plant_id: ui.plantId || null, line_id: ui.lineId || null, equipment_id: ui.equipmentId || null }) });
      toast(t('KPI target saved.'));
      await drawDashboard();
    } catch (err) {
      if (error) error.textContent = err.message || t('Could not save the target.');
    }
  });
}

function tabsHtml(labels) {
  return `<div class="tabs">${labels.map((label) => `<button class="tab${ui.tab === label ? ' active' : ''}" data-tab="${esc(label)}" type="button">${esc(t(label))}</button>`).join('')}</div>`;
}

function assetList(selectedCode, options = {}) {
  const requireSop = Boolean(options.requireSop);
  const markMissingSop = Boolean(options.markMissingSop);
  const withSop = (requireSop || markMissingSop) ? equipmentIdsWithSopFile() : null;
  const plants = selectedPlantIds();
  const items = (store.equipment || []).filter((item) => {
    if (plants.length && !plants.includes(item.plant_id)) return false;
    if (!plants.length && ui.plantId && item.plant_id !== ui.plantId) return false;
    if (ui.lineId && item.line_id !== ui.lineId) return false;
    if (ui.sectionId && item.section_id !== ui.sectionId) return false;
    if (ui.equipmentId && item.equipment_id !== ui.equipmentId && options.narrowToEquipment) return false;
    if (requireSop && withSop && !withSop.has(item.equipment_id)) return false;
    return true;
  });
  return `<aside class="equipment-list"><h3>${esc(t('Select Equipment'))}</h3><label class="mini-search">⌕ <input id="asset-search" placeholder="${esc(t('Search equipment...'))}"></label>${items.map((item) => {
    const missing = markMissingSop && withSop && !withSop.has(item.equipment_id);
    const classes = `asset${item.equipment_id === selectedCode ? ' selected' : ''}${missing ? ' missing-sop' : ''}`;
    const title = missing ? ` title="${esc(t('No SOP file'))}"` : '';
    return `<div class="${classes}" data-asset="${esc(item.equipment_id)}"${title}><span class="asset-icon">⚙</span><span><b>${esc(item.equipment_id)}</b><small>${esc(item.name)}</small>${missing ? `<em class="sop-missing-tag">${esc(t('No SOP'))}</em>` : ''}</span></div>`;
  }).join('') || `<p class="live-note">${esc(t(requireSop ? 'No equipment with an SOP file.' : 'No equipment'))}</p>`}</aside>`;
}

function drawWorkOrders() {
  const rows = scoped(store.orders).filter((order) => {
    if (ui.tab === 'Overdue') return overdue(order);
    if (ui.tab === 'Completed') return closed(order);
    if (ui.tab === 'On Hold') return order.status === 'On Hold';
    if (ui.tab === 'In Progress') return order.status === 'In Progress';
    return true;
  });
  const selected = rows.find((order) => order.work_order_id === ui.rowKey) || rows[0];
  document.getElementById('metric-grid').innerHTML = metrics([
    ['Total Work Orders', String(scoped(store.orders).length), '▤', 'blue', ''],
    ['Completed', String(scoped(store.orders).filter(closed).length), '✓', 'green', ''],
    ['In Progress', String(scoped(store.orders).filter((order) => order.status === 'In Progress').length), '◷', 'orange', ''],
    ['On Hold', String(scoped(store.orders).filter((order) => order.status === 'On Hold').length), 'Ⅱ', 'blue', ''],
    ['Overdue', String(scoped(store.orders).filter(overdue).length), '◉', 'red', ''],
    ['Avg. Labor (hrs)', numberText(scoped(store.orders).length ? sum(scoped(store.orders), 'labor_hours') / scoped(store.orders).length : 0, 1), '◷', 'green', ''],
  ]);
  dateLabel(store.orders.map((order) => order.request_date));
  if (ui.mode === 'create' && canMaintain()) {
    document.getElementById('workspace').className = 'workspace';
    document.getElementById('workspace').innerHTML = workOrderForm();
    bindForm();
    bindJobPlace(document.getElementById('live-form'));
    document.getElementById('job-back')?.addEventListener('click', () => {
      ui.mode = 'view';
      drawWorkOrders();
    });
    return;
  }
  if (ui.mode === 'job') {
    const order = store.orders.find((row) => row.work_order_id === ui.rowKey);
    if (order) {
      document.getElementById('workspace').className = 'workspace';
      document.getElementById('workspace').innerHTML = workOrderForm(order);
      bindForm();
      document.getElementById('job-pdf-export')?.addEventListener('click', () => exportJobOrderPdf(order));
      document.getElementById('job-back')?.addEventListener('click', () => {
        ui.mode = 'view';
        drawWorkOrders();
      });
      return;
    }
    ui.mode = 'view';
  }
  const body = rows.map((order) => `<tr data-row="${esc(order.work_order_id)}" class="${selected && selected.work_order_id === order.work_order_id ? 'selected' : ''}">${cell(esc(order.work_order_id), true)}${cell(liveBadge(order.work_order_type))}${cell(esc(equipmentText(order)))}${cell(esc(order.problem_description || order.work_description || '—'))}${cell(liveBadge(order.priority))}${cell(isTechnician() ? `<button type="button" class="badge blue job-open" data-open="${esc(order.work_order_id)}">${esc(t(order.status || 'Open'))}</button>` : liveBadge(order.status))}${cell(esc(assigneeNames(order)))}${cell(fmtDate(order.planned_date))}${cell(fmtDate(order.request_date))}</tr>`);
  const detail = ui.mode === 'create' ? workOrderForm() : detailPanel('Work Order Details', selected?.status || '—', selected?.work_order_id || '—', equipmentText(selected || {}), [
    ['Type', selected?.work_order_type], ['Priority', selected?.priority], ['Equipment', equipmentText(selected || {})],
    ['Problem', selected?.problem_description], ['Work', selected?.work_description], ['Technicians', assigneeNames(selected)],
    ['Planned', fmtDate(selected?.planned_date)], ['Downtime (h)', selected?.downtime_h ?? '—'], ['Parts', selected?.parts_used],
  ]);
  document.getElementById('workspace').className = 'workspace';
  document.getElementById('workspace').innerHTML = `<section class="panel">${tabsHtml(['All Work Orders', 'In Progress', 'Overdue', 'Completed', 'On Hold'])}${tableShell(['WO No.', 'Type', 'Equipment', 'Problem / Description', 'Priority', 'Status', 'Assigned To', 'Due Date', 'Created On'], body, shown(rows.length, scoped(store.orders).length, 'work orders'))}</section>${detail}`;
  if (ui.mode !== 'create' && selected) {
    document.querySelector('.detail')?.insertAdjacentHTML('beforeend', `<button type="button" class="detail-button primary job-open-detail" data-open="${esc(selected.work_order_id)}" title="${esc(t('Open maintenance order'))}"><span class="job-open-glyph" aria-hidden="true">▣</span><span>${esc(t('Open maintenance order'))}</span></button><button type="button" class="detail-button" id="job-pdf-export">${esc(t('Export PDF'))}</button>`);
    document.getElementById('job-pdf-export')?.addEventListener('click', () => exportJobOrderPdf(selected));
  }
  if (ui.mode !== 'create' && selected && canMaintain()) {
    document.querySelector('.detail')?.insertAdjacentHTML('beforeend', `<button type="button" class="detail-button danger" data-delete="/work-orders" data-delete-id="${esc(selected.work_order_id)}">${esc(t('Delete'))}</button>`);
  }
  bindRows();
  bindDeletes();
  document.querySelectorAll('[data-open]').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    ui.rowKey = button.dataset.open;
    ui.mode = 'job';
    drawWorkOrders();
  }));
  bindForm();
  if (ui.mode !== 'create' && selected && isTechnician()) {
    const response = myResponse(selected);
    const panel = document.querySelector('.detail');
    if (response === 'Pending') {
      panel?.insertAdjacentHTML('beforeend', `<div class="response-actions"><button class="detail-button primary" id="accept-order" type="button">Accept</button><button class="detail-button danger" id="reject-order" type="button">Reject</button><p id="response-error" class="form-error"></p></div>`);
      const send = async (decision) => {
        try {
          await apiRequest(`/work-orders/${encodeURIComponent(selected.work_order_id)}/respond`, { method: 'POST', body: JSON.stringify({ decision }) });
          store = null;
          ui.rowKey = selected.work_order_id;
          toast(decision === 'Accepted' ? 'Work order accepted and recorded.' : 'Work order rejected.');
          await paint('work-orders');
        } catch (error) {
          document.getElementById('response-error').textContent = error.message;
        }
      };
      document.getElementById('accept-order')?.addEventListener('click', () => send('Accepted'));
      document.getElementById('reject-order')?.addEventListener('click', () => send('Rejected'));
    } else if (response) {
      panel?.insertAdjacentHTML('beforeend', `<p class="live-note">Your response: ${esc(response)}</p>`);
    }
  }
}

function annualMarks(weeks) {
  return new Set(String(weeks || '').split(',').map((part) => part.trim()).filter(Boolean));
}

function isoDate(value) {
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

function weekDates(year, month, week) {
  const last = new Date(year, month, 0).getDate();
  const start = (week - 1) * 7 + 1;
  const end = week === 4 ? last : Math.min(start + 6, last);
  const dates = [];
  for (let day = start; day <= end; day += 1) dates.push(new Date(year, month - 1, day));
  return dates;
}

function repeatDates(year, every) {
  const step = Number(String(every || '').trim());
  if (!Number.isInteger(step) || step < 1 || step > 366) return [];
  const dates = [];
  const cursor = new Date(year, 0, 1);
  const end = new Date(year, 11, 31);
  while (cursor <= end) {
    dates.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + step);
  }
  return dates;
}

function weekKeyFor(value) {
  const day = value.getDate();
  const week = day <= 7 ? 1 : day <= 14 ? 2 : day <= 21 ? 3 : 4;
  return `${value.getMonth() + 1}-${week}`;
}

function annualLineKey(item) {
  if (item.line_key) return item.line_key;
  item.line_key = `L${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  return item.line_key;
}

function applyRowRepeat(row) {
  const every = row.querySelector('[data-field="frequency_time"]')?.value;
  const dates = repeatDates(ui.annualYear, every);
  const driven = dates.length > 0;
  const weeks = new Set(dates.map(weekKeyFor));
  if (driven) {
    row.dataset.driven = '1';
    row.dataset.days = dates.map(isoDate).join(',');
  } else if (row.dataset.driven === '1') {
    row.dataset.driven = '';
    row.dataset.days = '';
  }
  row.querySelectorAll('[data-week]').forEach((box) => {
    if (driven) {
      box.checked = weeks.has(box.dataset.week);
      box.disabled = true;
      return;
    }
    if (row.dataset.driven !== '1' && box.disabled && canMaintain() && !row.dataset.wasDriven) box.disabled = false;
    if (!driven && row.dataset.wasDriven === '1') {
      box.checked = false;
      if (canMaintain()) box.disabled = false;
    }
  });
  row.dataset.wasDriven = driven ? '1' : '';
}

function annualLineSelect(selected, locked) {
  const lines = (store.lines || []).filter((line) => line.plant_id === ui.annualPlant)
    .sort((a, b) => Number(a.line_number) - Number(b.line_number) || String(a.name).localeCompare(String(b.name)));
  const lock = locked ? ' disabled' : '';
  const options = [`<option value="">${esc(t('No line'))}</option>`].concat(lines.map((line) => {
    const label = line.name ? `${line.line_number} · ${line.name}` : String(line.line_number ?? '');
    return `<option value="${esc(line.line_id)}"${line.line_id === selected ? ' selected' : ''}>${esc(label)}</option>`;
  }));
  return `<select data-field="line_id"${lock}>${options.join('')}</select>`;
}

function annualRowHtml(item = {}, locked = false) {
  const marks = annualMarks(item.weeks);
  const lock = locked ? ' disabled' : '';
  const kind = DAY_MAINTENANCE_TYPES.includes(item.maintenance_type) ? item.maintenance_type : 'Preventive';
  const typeOptions = DAY_MAINTENANCE_TYPES.map((value) => `<option value="${value}"${kind === value ? ' selected' : ''}>${esc(t(value))}</option>`).join('');
  const weeks = ANNUAL_MONTHS.map((_, monthIndex) => [1, 2, 3, 4].map((week) => {
    const key = `${monthIndex + 1}-${week}`;
    return `<td><input type="checkbox" data-week="${key}"${marks.has(key) ? ' checked' : ''}${lock}></td>`;
  }).join('')).join('');
  const field = (name, value, placeholder) => `<input data-field="${name}" value="${esc(value || '')}" placeholder="${esc(placeholder)}"${lock}>`;
  return `<tr data-line="${esc(annualLineKey(item))}" data-days="${esc(item.days || '')}">
    <td class="annual-machine">${field('machine_code', item.machine_code, 'B-1001')}${field('machine_name', item.machine_name, t('Machine name'))}</td>
    <td class="annual-line">${annualLineSelect(item.line_id || '', locked)}</td>
    <td>${field('task', item.task, t('Task description'))}</td>
    <td><select data-field="maintenance_type"${lock}>${typeOptions}</select></td>
    <td>${field('frequency_time', item.frequency_time, '7')}</td>
    <td>${field('frequency_hours', item.frequency_hours, '500 h')}</td>
    ${weeks}
    <td>${locked ? '' : `<button type="button" class="annual-remove" data-i18n="Remove">${esc(t('Remove'))}</button>`}</td>
  </tr>`;
}

function readAnnualRows() {
  return [...document.querySelectorAll('#annual-rows tr')].map((row) => {
    const value = (name) => row.querySelector(`[data-field="${name}"]`)?.value.trim() || '';
    const weeks = [...row.querySelectorAll('[data-week]:checked')].map((box) => box.dataset.week).join(',');
    return { line_key: row.dataset.line || '', line_id: value('line_id'), machine_code: value('machine_code'), machine_name: value('machine_name'), task: value('task'), frequency_time: value('frequency_time'), frequency_hours: value('frequency_hours'), maintenance_type: value('maintenance_type') || 'Preventive', weeks, days: row.dataset.days || '' };
  });
}

function readWeekTasks() {
  const items = [];
  document.querySelectorAll('.week-day').forEach((day) => {
    const workDate = day.dataset.date;
    day.querySelectorAll('.day-task').forEach((row) => {
      const value = (name) => row.querySelector(`[data-field="${name}"]`)?.value.trim() || '';
      items.push({
        id: Number(row.dataset.id) || null,
        work_order_id: row.dataset.workOrder || '',
        released_at: row.dataset.released || '',
        work_date: workDate,
        machine_code: value('machine_code'),
        machine_name: value('machine_name'),
        task: value('task'),
        maintenance_type: value('maintenance_type') || 'Preventive',
      });
    });
  });
  return items;
}

function captureAnnual() {
  if (document.querySelector('.week-day')) ui.weekTasks = readWeekTasks();
  else if (document.getElementById('annual-rows')) ui.annualItems = readAnnualRows();
}

async function loadAnnualPlan() {
  if (!ui.annualPlant) { ui.annualItems = []; return; }
  const data = await apiRequest(`/annual-pm?plant_id=${encodeURIComponent(ui.annualPlant)}&year=${ui.annualYear}`);
  ui.annualItems = data.items || [];
  ui.annualYear = data.year || ui.annualYear;
}

async function saveAnnualPlan() {
  const error = document.getElementById('annual-error');
  if (!ui.annualPlant) {
    if (error) error.textContent = t('Choose a plant, then set the plan.');
    return;
  }
  captureAnnual();
  const items = ui.annualItems;
  try {
    const saved = await apiRequest('/annual-pm', { method: 'PUT', body: JSON.stringify({ plant_id: ui.annualPlant, year: Number(ui.annualYear), items }) });
    ui.annualItems = saved.items || [];
    store.equipment = await apiRequest('/equipment');
    toast(t(saved.new_equipment?.length ? 'The plan was saved. New equipment was added and the engineer was notified.' : 'Annual plan saved.'));
    await drawAnnualPlan();
  } catch (exception) {
    if (error) error.textContent = t(exception.message);
  }
}

function filledAnnualRows(rows) {
  return rows.filter((row) => row.task || row.machine_code || row.machine_name || row.frequency_time || row.frequency_hours);
}

function copyAnnualPlan() {
  const error = document.getElementById('annual-error');
  if (!ui.annualPlant) {
    if (error) error.textContent = t('Choose a plant, then set the plan.');
    return;
  }
  const items = filledAnnualRows(readAnnualRows());
  if (!items.length) {
    if (error) error.textContent = t('This plan has no tasks to copy.');
    return;
  }
  const plant = store.plants.find((item) => item.plant_id === ui.annualPlant);
  ui.annualCopy = {
    year: Number(ui.annualYear),
    plantId: ui.annualPlant,
    plantName: plant?.name || ui.annualPlant,
    items: items.map((item) => ({
      ...item,
      line_number: store.lines.find((line) => line.line_id === item.line_id)?.line_number ?? '',
      line_key: '',
    })),
  };
  toast(t('Plan copied. Open the other plant and paste it.'));
  drawAnnualPlan();
}

async function pasteAnnualPlan() {
  const error = document.getElementById('annual-error');
  const copy = ui.annualCopy;
  if (!copy) return;
  if (!ui.annualPlant) {
    if (error) error.textContent = t('Choose a plant, then set the plan.');
    return;
  }
  if (ui.annualPlant === copy.plantId && Number(ui.annualYear) === Number(copy.year)) {
    if (error) error.textContent = t('Paste into the other plant.');
    return;
  }
  const existing = filledAnnualRows(readAnnualRows());
  if (existing.length && !window.confirm(t('Replace the annual plan of this plant with the copied plan?'))) return;
  const lines = (store.lines || []).filter((line) => line.plant_id === ui.annualPlant);
  ui.annualWeek = '';
  ui.annualItems = copy.items.map((item) => {
    const match = lines.find((line) => String(line.line_number) === String(item.line_number) && item.line_number !== '');
    return {
      machine_code: item.machine_code,
      machine_name: item.machine_name,
      task: item.task,
      frequency_time: item.frequency_time,
      frequency_hours: item.frequency_hours,
      maintenance_type: item.maintenance_type || 'Preventive',
      weeks: item.weeks || '',
      days: Number(ui.annualYear) === Number(copy.year) ? (item.days || '') : '',
      line_id: match?.line_id || '',
      line_key: '',
    };
  });
  await drawAnnualPlan();
  await saveAnnualPlan();
}

function dayTaskHtml(task = {}, locked = false) {
  const sent = Boolean(task.released_at);
  const lock = locked ? ' disabled' : '';
  const sentLock = locked || sent ? ' disabled' : '';
  const kind = DAY_MAINTENANCE_TYPES.includes(task.maintenance_type) ? task.maintenance_type : 'Preventive';
  const equipment = store.equipment.filter((item) => item.plant_id === ui.annualPlant);
  const options = equipment.map((item) => `<option value="${esc(item.equipment_id)}">${esc(item.equipment_id)} — ${esc(item.name)}</option>`).join('');
  const field = (name, value, placeholder) => `<input data-field="${name}" value="${esc(value || '')}" placeholder="${esc(placeholder)}"${lock}>`;
  const typeOptions = DAY_MAINTENANCE_TYPES.map((value) => `<option value="${value}"${kind === value ? ' selected' : ''}>${esc(t(value))}</option>`).join('');
  return `<div class="day-task" data-id="${esc(task.id || '')}" data-work-order="${esc(task.work_order_id || '')}" data-released="${esc(task.released_at || '')}">
    ${locked ? '' : `<label>${esc(t('Registered equipment'))}<select class="equip-pick"><option value="">${esc(t('Choose registered equipment'))}</option>${options}</select></label>`}
    <label>${esc(t('Equipment number'))}${field('machine_code', task.machine_code, 'B-1001')}</label>
    <label>${esc(t('Equipment name'))}${field('machine_name', task.machine_name, t('Equipment name'))}</label>
    <label>${esc(t('Maintenance type'))}<select data-field="maintenance_type"${sentLock}>${typeOptions}</select></label>
    <label class="day-work">${esc(t('Work to be done'))}<textarea data-field="task" rows="2" placeholder="${esc(t('Work to be done'))}"${lock}>${esc(task.task || '')}</textarea></label>
    <p class="day-release" hidden></p>
    ${locked ? '' : `<button type="button" class="annual-remove day-remove">${esc(t('Remove'))}</button>`}
  </div>`;
}

function bindDayTask(row) {
  const codeInput = row.querySelector('[data-field="machine_code"]');
  const nameInput = row.querySelector('[data-field="machine_name"]');
  if (codeInput && nameInput) bindEquipmentCode(codeInput, nameInput);
  row.querySelector('.equip-pick')?.addEventListener('change', (event) => {
    const found = store.equipment.find((item) => item.equipment_id === event.target.value);
    if (!found) return;
    row.querySelector('[data-field="machine_code"]').value = found.equipment_id;
    row.querySelector('[data-field="machine_name"]').value = found.name;
  });
  row.querySelector('[data-field="maintenance_type"]')?.addEventListener('change', () => refreshDayNote(row));
  refreshDayNote(row);
  row.querySelector('.day-remove')?.addEventListener('click', () => {
    const list = row.parentElement;
    row.remove();
    if (!list.querySelector('.day-task')) {
      list.insertAdjacentHTML('beforeend', dayTaskHtml());
      bindDayTask(list.lastElementChild);
    }
  });
}

async function loadWeekTasks() {
  const [month, week] = String(ui.annualWeek || '').split('-').map(Number);
  const dates = weekDates(ui.annualYear, month, week);
  if (!ui.annualPlant || !dates.length) { ui.weekTasks = []; return; }
  const from = isoDate(dates[0]);
  const to = isoDate(dates[dates.length - 1]);
  ui.weekTasks = await apiRequest(`/annual-pm/days?plant_id=${encodeURIComponent(ui.annualPlant)}&year=${ui.annualYear}&date_from=${from}&date_to=${to}`);
}

async function saveWeekTasks() {
  const error = document.getElementById('annual-error');
  const [month, week] = String(ui.annualWeek || '').split('-').map(Number);
  const dates = weekDates(ui.annualYear, month, week);
  if (!ui.annualPlant || !dates.length) return;
  const items = readWeekTasks();
  const unknown = items.filter((item) => (item.maintenance_type || 'Preventive') === 'Preventive' && item.machine_code && item.machine_name && !equipmentByCode(item.machine_code));
  try {
    ui.weekTasks = await apiRequest('/annual-pm/days', { method: 'PUT', body: JSON.stringify({ plant_id: ui.annualPlant, year: Number(ui.annualYear), date_from: isoDate(dates[0]), date_to: isoDate(dates[dates.length - 1]), items }) });
    store.equipment = await apiRequest('/equipment');
    toast(t(unknown.length ? 'The plan was saved. New equipment was added and the engineer was notified.' : 'Week tasks saved.'));
    drawWeekForm();
  } catch (exception) {
    if (error) error.textContent = t(exception.message);
  }
}

function dayBefore(iso) {
  const [year, month, day] = String(iso).slice(0, 10).split('-').map(Number);
  const value = new Date(year, month - 1, day);
  value.setDate(value.getDate() - 1);
  return isoDate(value);
}

function refreshDayNote(row) {
  const note = row.querySelector('.day-release');
  const type = row.querySelector('[data-field="maintenance_type"]')?.value || 'Preventive';
  if (!note) return;
  if (type !== 'Corrective') {
    note.hidden = true;
    return;
  }
  note.hidden = false;
  if (row.dataset.released) {
    note.textContent = `${row.dataset.workOrder} · ${t('Sent to all technicians')}`;
    return;
  }
  if (row.dataset.workOrder) {
    const day = row.closest('.week-day')?.dataset.date;
    note.textContent = `${row.dataset.workOrder} · ${t('Sends to all technicians on')} ${fmtDate(dayBefore(day))}`;
    return;
  }
  note.textContent = t('Saving creates the work order and sends it to all technicians one day before this date.');
}

function drawWeekForm() {
  const locked = !canMaintain();
  const [month, week] = String(ui.annualWeek).split('-').map(Number);
  const dates = weekDates(ui.annualYear, month, week);
  const plant = store.plants.find((item) => item.plant_id === ui.annualPlant);
  const first = dates[0];
  const last = dates[dates.length - 1];
  const taskCount = ui.weekTasks.filter((item) => item.task).length;
  document.getElementById('page-subtitle').textContent = t('Add one or more tasks for each day: equipment number, equipment name, maintenance type, and the work to be done.');
  const action = document.getElementById('primary-action');
  action.hidden = locked;
  action.textContent = t('Save plan');
  document.getElementById('metric-grid').innerHTML = metrics([
    ['Week', String(week), '◷', 'blue', ''],
    [ANNUAL_MONTHS[month - 1], String(dates.length), '▧', 'orange', ''],
    ['Year', String(ui.annualYear), '▣', 'purple', ''],
    ['Plant', plant?.name || '—', '▣', 'blue', ''],
    ['Day tasks', String(taskCount), '⚙', 'green', ''],
    ['From', first ? fmtDate(isoDate(first)) : '—', '◷', 'orange', ''],
  ]);
  const days = dates.map((value) => {
    const key = isoDate(value);
    const tasks = ui.weekTasks.filter((item) => String(item.work_date).slice(0, 10) === key);
    const rows = (tasks.length ? tasks : [{}]).map((task) => dayTaskHtml(task, locked)).join('');
    return `<section class="week-day" data-date="${key}">
      <header><div><b>${esc(t(WEEKDAYS[value.getDay()]))}</b><small>${esc(fmtDate(key))}</small></div>${locked ? '' : `<button type="button" class="detail-button day-add">${esc(t('Add another task'))}</button>`}</header>
      <div class="day-tasks">${rows}</div>
    </section>`;
  }).join('');
  document.getElementById('workspace').className = 'workspace';
  document.getElementById('workspace').innerHTML = `<section class="panel annual-plan">
    <div class="annual-bar">
      <button type="button" id="week-back" class="detail-button">${esc(t('Back to annual plan'))}</button>
      <b class="annual-title">${esc(t('Week'))} ${week} · ${esc(t(ANNUAL_MONTHS[month - 1]))} ${esc(ui.annualYear)}${formNo('annual_plan') ? ` · ${esc(formNo('annual_plan'))}` : ''}</b>
    </div>
    <p class="kpi-note">${esc(fmtDate(isoDate(first)))} – ${esc(fmtDate(isoDate(last)))} · ${dates.length} ${esc(t('days'))}</p>
    <div class="week-days">${days}</div>
    <p id="annual-error" class="form-error"></p>
  </section>`;
  document.querySelectorAll('.day-task').forEach(bindDayTask);
  document.querySelectorAll('.day-add').forEach((button) => button.addEventListener('click', () => {
    const list = button.closest('.week-day').querySelector('.day-tasks');
    list.insertAdjacentHTML('beforeend', dayTaskHtml());
    bindDayTask(list.lastElementChild);
  }));
  document.getElementById('week-back')?.addEventListener('click', () => {
    ui.annualWeek = '';
    ui.weekTasks = [];
    drawAnnualPlan();
  });
}

const PLAN_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#a78bfa', '#fb7185', '#2dd4bf', '#f97316', '#60a5fa'];

function horizonTasks(bucket, emptyText, showPlant = false) {
  const rows = bucket?.items || [];
  if (!rows.length) return `<p class="empty">${esc(t(emptyText))}</p>`;
  const list = rows.map((item) => `<li><b>${esc(item.machine_code || '—')} — ${esc(item.machine_name || '—')}</b><small>${esc(fmtDate(item.work_date))} · ${esc(t(item.maintenance_type || 'Preventive'))}${showPlant && item.plant_name ? ` · ${esc(item.plant_name)}` : ''}</small><span>${esc(item.task || '')}</span></li>`).join('');
  const more = (bucket.count || rows.length) > rows.length ? `<p class="empty">${esc(t('Showing'))} ${rows.length} ${esc(t('of'))} ${bucket.count}</p>` : '';
  return `<ol>${list}</ol>${more}`;
}

function annualHorizon(overview, viewOnly = false) {
  const plants = overview?.plants || [];
  const parts = plants.filter((item) => item.tasks > 0).map((item, index) => ({
    name: `${item.name} · ${item.tasks}`,
    value: item.tasks,
    color: PLAN_COLORS[index % PLAN_COLORS.length],
  }));
  const total = parts.reduce((sum, item) => sum + item.value, 0);
  const chart = total
    ? donut(parts, total)
    : `<p class="empty">${esc(t('No annual tasks for this year.'))}</p>`;
  const quiet = plants.filter((item) => !item.tasks).map((item) => item.name).join(', ');
  const outside = overview && overview.in_year === false
    ? `<p class="empty">${esc(t('Today is outside the selected year.'))}</p>`
    : '';
  const needsPlant = !viewOnly && !ui.annualPlant
    ? `<p class="empty">${esc(t('Choose a plant, then set the plan.'))}</p>`
    : '';
  const block = (title, detail, body) => `<section class="plan-panel"><h3>${esc(t(title))}</h3>${detail ? `<small>${detail}</small>` : ''}${needsPlant || outside || body}</section>`;
  const weekDetail = overview?.week_from ? `${t('Week')} ${overview.week_number} · ${fmtDate(overview.week_from)} – ${fmtDate(overview.week_to)}` : '';
  const monthName = ANNUAL_MONTHS[(overview?.month_number || 1) - 1] || '';
  const yearLabel = viewOnly ? new Date().getFullYear() : ui.annualYear;
  const cards = `
    ${block("Today's task", fmtDate(overview?.on), horizonTasks(overview?.today, 'No task falls on this day.', viewOnly))}
    ${block("This week's plan", weekDetail, horizonTasks(overview?.week, 'No tasks fall in this week.', viewOnly))}
    ${block("This month's plan", `${t(monthName)} ${yearLabel}`, horizonTasks(overview?.month, 'No tasks fall in this month.', viewOnly))}`;
  if (viewOnly) return `<div class="plan-horizon">${cards}</div>`;
  return `<div class="plan-horizon">${cards}
    <section class="plan-panel plan-donut"><h3>${esc(t('Annual plans by plant'))}</h3><p class="empty">${esc(t('Each slice is a plant. Its size is the number of maintenance tasks in that plant annual plan.'))}</p>${chart}${quiet ? `<p class="empty">${esc(quiet)} · 0</p>` : ''}</section>
  </div>`;
}

async function drawTechnicianSchedule() {
  ui.annualWeek = '';
  document.getElementById('primary-action').hidden = true;
  document.getElementById('page-subtitle').textContent = t('Tasks for today, this week, and this month.');
  const year = new Date().getFullYear();
  let overview = { today: { count: 0, items: [] }, week: { count: 0, items: [] }, month: { count: 0, items: [] }, in_year: true, on: isoDate(new Date()), month_number: new Date().getMonth() + 1 };
  try {
    overview = await apiRequest(`/annual-pm/overview?year=${year}`);
  } catch (exception) {
    document.getElementById('metric-grid').innerHTML = '';
    const workspace = document.getElementById('workspace');
    workspace.hidden = false;
    workspace.className = 'workspace';
    workspace.innerHTML = `<section class="panel"><p class="live-note">${esc(t(exception.message))}</p></section>`;
    return;
  }
  document.getElementById('metric-grid').innerHTML = annualHorizon(overview, true);
  const workspace = document.getElementById('workspace');
  workspace.className = 'workspace';
  workspace.innerHTML = '';
  workspace.hidden = true;
}

async function drawAnnualPlan() {
  if (isTechnician()) return drawTechnicianSchedule();
  if (ui.annualPlant && store?.plants && !store.plants.some((plant) => plant.plant_id === ui.annualPlant && plant.active !== false)) {
    ui.annualPlant = '';
    ui.annualItems = [];
    ui.annualWeek = '';
  }
  if (ui.annualWeek && ui.annualPlant) return drawWeekForm();
  ui.annualWeek = '';
  const locked = !canMaintain();
  const items = ui.annualItems.length || !ui.annualPlant || locked ? ui.annualItems : [{}];
  document.getElementById('page-subtitle').textContent = t('Choose a plant, then set the annual plan.');
  document.getElementById('primary-action').hidden = true;
  let overview = { today: { count: 0, items: [] }, week: { count: 0, items: [] }, month: { count: 0, items: [] }, plants: [], in_year: true, on: isoDate(new Date()), month_number: new Date().getMonth() + 1 };
  try {
    const params = new URLSearchParams({ year: String(ui.annualYear) });
    if (ui.annualPlant) params.set('plant_id', ui.annualPlant);
    overview = await apiRequest(`/annual-pm/overview?${params}`);
  } catch (exception) {
    overview.error = exception.message;
  }
  document.getElementById('metric-grid').innerHTML = annualHorizon(overview);
  const monthHead = ANNUAL_MONTHS.map((month) => `<th colspan="4">${esc(t(month))}</th>`).join('');
  const weekHead = ANNUAL_MONTHS.map((_, monthIndex) => [1, 2, 3, 4].map((week) => `<th><button type="button" class="week-open" data-open-week="${monthIndex + 1}-${week}">${week}</button></th>`).join('')).join('');
  const options = openPlants().map((item) => `<option value="${esc(item.plant_id)}"${item.plant_id === ui.annualPlant ? ' selected' : ''}>${esc(item.name)}</option>`).join('');
  const rows = !ui.annualPlant
    ? `<tr><td class="annual-empty" colspan="55">${esc(t('Choose a plant, then set the plan.'))}</td></tr>`
    : (items.length ? items.map((item) => annualRowHtml(item, locked)).join('') : `<tr><td class="annual-empty" colspan="55">${esc(t('No records yet'))}</td></tr>`);
  document.getElementById('workspace').className = 'workspace';
  document.getElementById('workspace').innerHTML = `<section class="panel annual-plan">${tabsHtml(['Annual plan', 'Due tasks'])}
    <div class="annual-bar">
      <label>${esc(t('Plant'))}<select id="annual-plant"><option value="">${esc(t('Choose a plant'))}</option>${options}</select></label>
      <label>${esc(t('Year'))}<input id="annual-year" type="number" min="2000" max="2100" value="${esc(ui.annualYear)}"${locked ? ' disabled' : ''}></label>
      ${locked ? '' : `<button type="button" id="annual-add" class="detail-button">${esc(t('Add task'))}</button><button type="button" id="annual-copy" class="detail-button">${esc(t('Copy plan'))}</button><button type="button" id="annual-paste" class="detail-button"${ui.annualCopy ? '' : ' disabled'}>${esc(ui.annualCopy ? `${t('Paste plan')} · ${ui.annualCopy.plantName}` : t('Paste plan'))}</button>`}
      <button type="button" id="annual-export" class="detail-button">${esc(t('Export'))}</button>
      ${locked ? '' : `<button type="button" id="annual-save" class="detail-button primary">${esc(t('Save plan'))}</button>`}
    </div>
    <h2 class="annual-title">${esc(t('Annual preventive maintenance plan'))}${formNo('annual_plan') ? ` · ${esc(formNo('annual_plan'))}` : ''}</h2>
    <div class="annual-scroll"><table class="annual-sheet">
      <thead><tr><th rowspan="2">${esc(t('Machine name'))}</th><th rowspan="2">${esc(t('Line number'))}</th><th rowspan="2">${esc(t('Task description'))}</th><th rowspan="2">${esc(t('Maintenance type'))}</th><th colspan="2">${esc(t('Frequency'))}</th>${monthHead}<th rowspan="2"></th></tr>
      <tr><th>${esc(t('Every (days)'))}</th><th>${esc(t('By running hours'))}</th>${weekHead}</tr></thead>
      <tbody id="annual-rows">${rows}</tbody>
    </table></div>
    <p class="kpi-note">${esc(t('Enter how many days between each repeat. The task is placed on those dates with its maintenance type.'))}</p>
    <p id="annual-error" class="form-error"></p>
  </section>`;
  document.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => {
    captureAnnual();
    ui.tab = button.dataset.tab;
    ui.mode = 'view';
    draw(ui.page);
  }));
  document.querySelectorAll('.week-open').forEach((button) => button.addEventListener('click', () => {
    if (!ui.annualPlant) {
      const error = document.getElementById('annual-error');
      if (error) error.textContent = t('Choose a plant, then set the plan.');
      return;
    }
    captureAnnual();
    ui.annualWeek = button.dataset.openWeek;
    loadWeekTasks().then(() => drawAnnualPlan()).catch((exception) => {
      const error = document.getElementById('annual-error');
      if (error) error.textContent = exception.message;
    });
  }));
  document.getElementById('annual-plant')?.addEventListener('change', async (event) => {
    ui.annualWeek = '';
    ui.annualPlant = event.target.value;
    try { await loadAnnualPlan(); await drawAnnualPlan(); }
    catch (exception) { const error = document.getElementById('annual-error'); if (error) error.textContent = exception.message; }
  });
  document.getElementById('annual-year')?.addEventListener('change', async (event) => {
    ui.annualWeek = '';
    ui.annualYear = Number(event.target.value) || new Date().getFullYear();
    try { await loadAnnualPlan(); await drawAnnualPlan(); }
    catch (exception) { const error = document.getElementById('annual-error'); if (error) error.textContent = exception.message; }
  });
  document.getElementById('annual-add')?.addEventListener('click', () => {
    ui.annualItems = readAnnualRows();
    ui.annualItems.push({ machine_code: '', machine_name: '', task: '', frequency_time: '', frequency_hours: '', maintenance_type: 'Preventive', line_id: '', weeks: '' });
    drawAnnualPlan();
  });
  document.getElementById('annual-copy')?.addEventListener('click', copyAnnualPlan);
  document.getElementById('annual-paste')?.addEventListener('click', () => { pasteAnnualPlan(); });
  document.getElementById('annual-export')?.addEventListener('click', () => { exportAnnualPlan(); });
  document.getElementById('annual-save')?.addEventListener('click', () => { saveAnnualPlan(); });
  document.querySelectorAll('#annual-rows tr[data-line]').forEach((row) => {
    applyRowRepeat(row);
    row.querySelector('[data-field="frequency_time"]')?.addEventListener('input', () => applyRowRepeat(row));
    const codeInput = row.querySelector('[data-field="machine_code"]');
    const nameInput = row.querySelector('[data-field="machine_name"]');
    if (codeInput && nameInput) bindEquipmentCode(codeInput, nameInput);
  });
  document.querySelectorAll('.annual-remove').forEach((button) => button.addEventListener('click', () => {
    const rows = readAnnualRows();
    const index = [...document.querySelectorAll('.annual-remove')].indexOf(button);
    rows.splice(index, 1);
    ui.annualItems = rows;
    drawAnnualPlan();
  }));
}

async function drawPlans() {
  if (isTechnician()) return drawTechnicianSchedule();
  if (!['Due tasks', 'Due Today', 'Due This Week', 'Due This Month', 'Overdue', 'Completed', 'All PM Tasks'].includes(ui.tab)) return drawAnnualPlan();
  const action = document.getElementById('primary-action');
  action.hidden = true;
  document.getElementById('page-subtitle').textContent = t('Scheduled tasks from the annual plan.');
  const params = new URLSearchParams({ year: String(ui.annualYear || new Date().getFullYear()) });
  if (ui.annualPlant) params.set('plant_id', ui.annualPlant);
  const due = await apiRequest(`/annual-pm/due?${params}`);
  const all = due.items || [];
  const rows = all.filter((item) => {
    if (ui.tab === 'Due Today') return item.status === 'Due Today';
    if (ui.tab === 'Due This Week') return item.status === 'Due Today' || item.status === 'Due This Week';
    if (ui.tab === 'Due This Month') return ['Due Today', 'Due This Week', 'Due This Month'].includes(item.status);
    if (ui.tab === 'Overdue') return item.status === 'Overdue';
    if (ui.tab === 'Completed') return item.status === 'Completed';
    return true;
  });
  const compliance = due.compliance == null ? '—' : `${numberText(due.compliance, 1)}%`;
  document.getElementById('metric-grid').innerHTML = metrics([
    ['Total PM Tasks', String(due.total || 0), '▣', 'blue', ''],
    ['Due This Month', String(due.due_month || 0), '▧', 'orange', ''],
    ['Overdue', String(due.overdue || 0), '◷', 'red', ''],
    ['Completed', String(due.completed || 0), '✓', 'green', ''],
    ['Compliance (%)', compliance, '◈', 'purple', ''],
  ]);
  const body = rows.map((item) => `<tr data-row="${esc(item.id)}">${cell(esc(item.machine_code || '—'), true)}${cell(esc(item.machine_name || '—'))}${cell(esc(item.task || '—'))}${cell(liveBadge(item.maintenance_type))}${cell(fmtDate(item.work_date))}${cell(liveBadge(item.status))}${cell(esc(item.plant_name || '—'))}</tr>`);
  document.getElementById('workspace').className = 'workspace due-board';
  document.getElementById('workspace').innerHTML = `<section class="panel">${tabsHtml(['Annual plan', 'Due tasks', 'Due Today', 'Due This Week', 'Due This Month', 'Overdue', 'Completed'])}${tableShell(['Equipment number', 'Equipment name', 'Task description', 'Maintenance type', 'Date', 'Status', 'Plant'], body, shown(rows.length, all.length, 'PM tasks'))}</section>`;
  document.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => {
    ui.tab = button.dataset.tab;
    ui.mode = 'view';
    ui.rowKey = '';
    draw(ui.page);
  }));
}

function drawPlants() {
  const rows = store.plants.filter((plant) => ui.tab === 'All Plants' || (ui.tab === 'Active' ? plant.active !== false : plant.active === false));
  const selected = rows.find((plant) => plant.plant_id === ui.rowKey) || rows[0];
  const plantLines = store.lines.filter((line) => line.plant_id === selected?.plant_id).sort((a, b) => Number(a.line_number) - Number(b.line_number));
  document.getElementById('metric-grid').innerHTML = metrics([
    ['Plants', String(store.plants.length), '▣', 'blue', ''],
    ['Active Plants', String(store.plants.filter((plant) => plant.active !== false).length), '✓', 'green', ''],
    ['Production Lines', String(store.lines.length), '☰', 'orange', ''],
    ['Lines In View', String(selected ? plantLines.length : 0), '№', 'purple', ''],
    ['Equipment', String(store.equipment.length), '⚙', 'blue', ''],
    ['Plants Without Lines', String(store.plants.filter((plant) => !store.lines.some((line) => line.plant_id === plant.plant_id)).length), '!', 'red', ''],
  ]);
  const body = rows.map((plant) => {
    const count = store.lines.filter((line) => line.plant_id === plant.plant_id).length;
    return `<tr data-row="${esc(plant.plant_id)}" class="${selected && selected.plant_id === plant.plant_id ? 'selected' : ''}">${cell(esc(plant.plant_id), true)}${cell(esc(plant.name))}${cell(esc(plant.order_code || '—'), true)}${cell(String(count))}${cell(liveBadge(plant.active === false ? 'Inactive' : 'Active'))}</tr>`;
  });
  const lineRows = plantLines.map((line) => {
    const sections = lineSections(line.line_id);
    const chips = sections.map((section) => {
      const count = store.equipment.filter((item) => item.section_id === section.section_id).length;
      const remove = canMaintain() ? `<button type="button" class="detail-button danger" data-delete="/sections" data-delete-id="${esc(section.section_id)}" data-delete-keep="1" data-delete-note="Delete this section? Equipment stays on the line.">${esc(t('Delete'))}</button>` : '';
      return `<span class="section-chip"><b>${esc(section.name)}</b><small>${count}</small>${remove}</span>`;
    }).join('') || `<p class="live-note">${esc(t('No sections on this line yet.'))}</p>`;
    const add = canMaintain() ? `<form class="section-form" data-line="${esc(line.line_id)}"><input name="name" required placeholder="${esc(t('Section name'))}"><button class="detail-button primary" type="submit">${esc(t('Add section'))}</button><p class="form-error section-error"></p></form>` : '';
    const title = `${esc(t('Line'))} ${esc(line.line_number ?? '—')}${line.name ? ` · ${esc(line.name)}` : ''}`;
    return `<div class="line-block"><div class="line-head"><b>${title}</b>${canMaintain() ? `<button type="button" class="detail-button danger" data-delete="/lines" data-delete-id="${esc(line.line_id)}" data-delete-keep="1">${esc(t('Delete'))}</button>` : ''}</div><div class="section-list">${chips}</div>${add}</div>`;
  }).join('') || `<p class="live-note">${esc(t('No records yet'))}</p>`;
  const lineForm = selected && canMaintain() ? `<form id="line-form" class="live-form"><div class="assign-block"><b>Add production line</b></div><label>Line number<input name="line_number" type="number" min="1" step="1" required></label><label>Name<input name="name" placeholder="Optional"></label><button class="detail-button primary" type="submit">Add line</button><p id="line-error" class="form-error"></p></form>` : '';
  const statusForm = selected && canMaintain() ? `<form id="plant-status" class="live-form"><label>${esc(t('Plant name'))}<input name="name" value="${esc(selected.name || '')}" required maxlength="150"></label><label>${esc(t('Work order code'))}<input name="order_code" value="${esc(selected.order_code || '')}" required maxlength="12" placeholder="FM1"></label><label>${esc(t('Status'))}<select name="active">${plantStatusOptions(selected.active)}</select></label><button class="detail-button primary" type="submit">${esc(t('Save'))}</button><p class="live-note">${esc(t('Each plant keeps its own sequence. FM1 in 2026 starts at FM12026-001.'))}</p><p id="plant-status-error" class="form-error"></p></form>` : '';
  const detail = ui.mode === 'create' ? plantForm() : `<aside class="panel detail"><h2>Plant Details</h2><div class="detail-top"><div class="machine">▣</div>${liveBadge(selected?.active === false ? 'Inactive' : 'Active')}<h3>${esc(selected?.plant_id || '—')}</h3><p>${esc(selected?.name || '')}</p></div><div class="detail-list">${lineRows}</div>${lineForm}${statusForm}</aside>`;
  document.getElementById('workspace').className = 'workspace';
  document.getElementById('workspace').innerHTML = `<section class="panel">${tabsHtml(['All Plants', 'Active', 'Inactive'])}${tableShell(['Plant Code', 'Plant Name', 'Work order code', 'Production Lines', 'Status'], body, shown(rows.length, store.plants.length, 'plants'))}</section>${detail}`;
  if (selected && canMaintain() && ui.mode !== 'create') {
    document.querySelector('.detail')?.insertAdjacentHTML('beforeend', `<button type="button" class="detail-button danger" data-delete="/plants" data-delete-id="${esc(selected.plant_id)}" data-delete-note="Delete this plant? Its equipment, maintenance history, and KPI charts will be removed.">${esc(t('Delete'))}</button>`);
  }
  bindRows();
  bindForm();
  bindDeletes();
  document.getElementById('line-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = document.getElementById('line-error');
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      await apiRequest('/lines', { method: 'POST', body: JSON.stringify({ plant_id: selected.plant_id, line_number: Number(data.line_number), name: data.name || null, active: true }) });
      store = null;
      ui.rowKey = selected.plant_id;
      ui.mode = 'view';
      toast(t('Production line added.'));
      await paint('plants');
    } catch (exception) {
      error.textContent = t(exception.message);
    }
  });
  document.querySelectorAll('.section-form').forEach((form) => form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = form.querySelector('.section-error');
    const name = String(new FormData(form).get('name') || '').trim();
    try {
      await apiRequest('/sections', { method: 'POST', body: JSON.stringify({ line_id: form.dataset.line, name }) });
      store = null;
      ui.rowKey = selected.plant_id;
      ui.mode = 'view';
      toast(t('Section added.'));
      await paint('plants');
    } catch (exception) {
      if (error) error.textContent = t(exception.message);
    }
  }));
  document.getElementById('plant-status')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = document.getElementById('plant-status-error');
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      await apiRequest(`/plants/${encodeURIComponent(selected.plant_id)}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: String(data.name || '').trim(),
          active: data.active !== 'false',
          order_code: data.order_code,
        }),
      });
      store = null;
      ui.rowKey = selected.plant_id;
      ui.mode = 'view';
      toast(t('Saved.'));
      await paint('plants');
    } catch (exception) {
      if (error) error.textContent = t(exception.message);
    }
  });
}

function plantStatusOptions(active) {
  const current = active === false ? 'false' : 'true';
  return [['true', 'Active plant'], ['false', 'Inactive plant']].map(([value, label]) => `<option value="${value}"${value === current ? ' selected' : ''}>${esc(t(label))}</option>`).join('');
}

function plantForm() {
  return formPanel('Add Plant', [
    field('Plant code', '<input name="plant_id" required>'),
    field('Plant name', '<input name="name" required>'),
    field('Work order code', '<input name="order_code" required maxlength="12" placeholder="FM1">'),
    field('Status', `<select name="active">${plantStatusOptions(true)}</select>`),
  ].join(''));
}

function equipmentTabs() {
  const pending = (store.pending || []).length;
  const labels = ['All Equipment', 'From reports', 'Critical Assets', 'Out of Service', 'Under Maintenance'];
  return `<div class="tabs">${labels.map((label) => {
    const text = label === 'From reports' ? `${t(label)} (${pending})` : t(label);
    return `<button class="tab${ui.tab === label ? ' active' : ''}" data-tab="${esc(label)}" type="button">${esc(text)}</button>`;
  }).join('')}</div>`;
}

function equipmentDetail(selected) {
  const capacity = selected?.capacity == null ? '—' : `${selected.capacity}${selected.capacity_unit ? ` ${selected.capacity_unit}` : ''}`;
  return detailPanel('Equipment Details', selected?.status || '—', selected?.equipment_id || '—', selected?.name || '', [
    ['Category', selected?.equipment_type], ['Location', placeOf(selected)], ['Section', sectionName(selected?.section_id) || '—'], ['Area', selected?.area],
    ['Manufacturer', selected?.manufacturer], ['Model', selected?.model], ['Serial number', selected?.serial_number],
    ['Criticality', criticalityLabel(selected?.criticality)], ['Condition', selected?.condition], ['Capacity', capacity],
    ['Motor power (kW)', selected?.motor_power_kw ?? '—'],
    ['Notes', selected?.notes],
  ]);
}

let equipmentMotorToken = 0;

function motorChartBlock(title, svg, status) {
  if (!svg && !status) return '';
  const latest = status ? `<p class="motor-status">${esc(t(status))}</p>` : '';
  const chart = svg || `<p class="chart-empty">${esc(t('No temperature or oil readings yet.'))}</p>`;
  return `<section class="motor-chart"><h4>${esc(t(title))}</h4>${latest}${chart}</section>`;
}

function equipmentMotorHtml(data) {
  const limit = data.temp_limit_c;
  const latest = data.latest || {};
  const state = latest.state === 'high'
    ? `<p class="temp-state high">${esc(t('Temperature is high'))}${latest.date ? ` · ${esc(fmtDate(latest.date))}` : ''}</p>`
    : latest.state === 'within'
      ? `<p class="temp-state ok">${esc(t('Within the allowed limit'))}${latest.date ? ` · ${esc(fmtDate(latest.date))}` : ''}</p>`
      : '';
  const form = canMaintain()
    ? `<form id="motor-limit" class="live-form"><label>${esc(t('Allowed temperature (°C)'))}<input name="temp_limit_c" type="number" min="1" max="400" step="0.1" value="${limit == null ? '' : esc(String(limit))}"></label><button class="detail-button primary" type="submit">${esc(t('Save'))}</button><p class="live-note">${esc(t('A reading above this value is high. Leave it empty to clear the limit.'))}</p><p id="motor-limit-error" class="form-error"></p></form>`
    : (limit == null ? '' : `<p class="motor-status">${esc(t('Allowed temperature (°C)'))}: ${esc(String(limit))}</p>`);
  const temperature = areaChart(data.temperature || [], '°C', { limit, label: t('Temperature') });
  const level = areaChart(data.oil_level || [], '', { label: t('Oil level') });
  const condition = areaChart(data.oil_condition || [], '', { label: t('Oil condition') });
  const charts = [
    motorChartBlock('Temperature', temperature, ''),
    motorChartBlock('Oil level', level, latest.oil_level || ''),
    motorChartBlock('Oil condition', condition, latest.oil_condition || ''),
  ].join('');
  const empty = charts.trim() ? '' : `<p class="live-note">${esc(t('No temperature or oil readings yet.'))}</p>`;
  return `<h3>${esc(t('Motor condition'))}</h3>${form}${state}${charts}${empty}`;
}

async function loadEquipmentMotor(selected) {
  const token = ++equipmentMotorToken;
  const box = document.getElementById('equipment-motor');
  if (!box || !selected?.equipment_id) return;
  try {
    const data = await apiRequest(`/equipment/${encodeURIComponent(selected.equipment_id)}/motor-history`);
    if (token !== equipmentMotorToken || !box.isConnected) return;
    if (!data?.included) {
      box.remove();
      return;
    }
    box.innerHTML = equipmentMotorHtml(data);
    document.getElementById('motor-limit')?.addEventListener('submit', (event) => saveEquipmentTempLimit(event, selected.equipment_id));
  } catch (exception) {
    if (token === equipmentMotorToken && box.isConnected) box.innerHTML = `<p class="form-error">${esc(t(exception.message || 'Could not load the chart'))}</p>`;
  }
}

async function saveEquipmentTempLimit(event, equipmentId) {
  event.preventDefault();
  const error = document.getElementById('motor-limit-error');
  const raw = String(new FormData(event.currentTarget).get('temp_limit_c') || '').trim().replace(',', '.');
  const value = raw === '' ? null : Number(raw);
  if (value !== null && (!Number.isFinite(value) || value < 1 || value > 400)) {
    if (error) error.textContent = t('Enter an allowed temperature between 1 and 400');
    return;
  }
  try {
    await apiRequest(`/equipment/${encodeURIComponent(equipmentId)}/temp-limit`, {
      method: 'PUT',
      body: JSON.stringify({ temp_limit_c: value }),
    });
    toast(t('Saved.'));
    const selected = (store.equipment || []).find((item) => item.equipment_id === equipmentId);
    if (selected) loadEquipmentMotor(selected);
  } catch (exception) {
    if (error) error.textContent = t(exception.message);
  }
}

function drawEquipment() {
  if (ui.tab === 'From reports') {
    drawEquipmentFromReports();
    return;
  }
  const rows = visibleEquipment().filter((item) => {
    if (ui.tab === 'Critical Assets') return isCriticalAsset(item);
    if (ui.tab === 'Out of Service') return item.status === 'Out of Service';
    if (ui.tab === 'Under Maintenance') return item.status === 'Under Maintenance';
    return true;
  });
  const selected = rows.find((item) => item.equipment_id === ui.rowKey) || rows[0];
  const all = visibleEquipment();
  document.getElementById('metric-grid').innerHTML = metrics([
    ['Total Equipment', String(all.length), '▣', 'blue', ''],
    ['Operational', String(all.filter((item) => item.status === 'Running' || item.status === 'Operational').length), '✓', 'green', ''],
    ['Under Maintenance', String(all.filter((item) => item.status === 'Under Maintenance').length), '⚒', 'orange', ''],
    ['Out of Service', String(all.filter((item) => item.status === 'Out of Service').length), '×', 'red', ''],
    ['From reports', String((store.pending || []).length), '＋', 'purple', ''],
    ['Critical Assets', String(all.filter(isCriticalAsset).length), '◈', 'red', ''],
  ]);
  const body = rows.map((item) => `<tr data-row="${esc(item.equipment_id)}" class="${selected && selected.equipment_id === item.equipment_id ? 'selected' : ''}">${cell(esc(item.equipment_id), true)}${cell(esc(item.name))}${cell(esc(item.equipment_type))}${cell(esc(placeOf(item)))}${cell(liveBadge(item.status))}${cell(liveBadge(item.condition || '—'))}${cell(liveBadge(criticalityLabel(item.criticality)))}</tr>`);
  const detail = ui.mode === 'create' ? equipmentForm() : equipmentDetail(selected);
  document.getElementById('workspace').className = 'workspace';
  document.getElementById('workspace').innerHTML = `<section class="panel">${filtersHtml()}${equipmentTabs()}${tableShell(['Equipment Code', 'Equipment Name', 'Category', 'Location (Plant / Line)', 'Status', 'Condition', 'Criticality'], body, shown(rows.length, all.length, 'equipment'))}</section>${detail}`;
  if (selected && ui.mode !== 'create') {
    document.querySelector('.detail')?.insertAdjacentHTML('beforeend', '<div id="equipment-motor" class="equipment-motor"></div>');
    loadEquipmentMotor(selected);
  }
  if (selected && canMaintain() && ui.mode !== 'create') {
    document.querySelector('.detail')?.insertAdjacentHTML('beforeend', '<div id="equipment-parts" class="equipment-parts"></div>');
    loadEquipmentParts(selected);
    const sectionForm = lineSections(selected.line_id).length ? `<form id="equipment-section" class="live-form"><label>${esc(t('Section'))}<select name="section_id">${sectionOptions(selected.line_id, selected.section_id || '')}</select></label><button class="detail-button primary" type="submit">${esc(t('Save'))}</button><p id="equipment-section-error" class="form-error"></p></form>` : `<p class="live-note">${esc(t('No sections on this line yet.'))}</p>`;
    document.querySelector('.detail')?.insertAdjacentHTML('beforeend', `${sectionForm}<button type="button" class="detail-button danger" data-delete="/equipment" data-delete-id="${esc(selected.equipment_id)}" data-delete-note="Delete this equipment? Its maintenance history and KPI charts will be removed.">${esc(t('Delete'))}</button>`);
  }
  bindFilters();
  bindRows();
  bindForm();
  bindDeletes();
  document.getElementById('equipment-section')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = document.getElementById('equipment-section-error');
    const sectionId = new FormData(event.currentTarget).get('section_id') || null;
    try {
      await apiRequest(`/equipment/${encodeURIComponent(selected.equipment_id)}/section`, { method: 'PUT', body: JSON.stringify({ section_id: sectionId || null }) });
      store = null;
      ui.rowKey = selected.equipment_id;
      toast(t('Saved.'));
      await paint('equipment');
    } catch (exception) {
      if (error) error.textContent = t(exception.message);
    }
  });
}

function readSopParagraphs() {
  const fields = [...document.querySelectorAll('[data-sop-paragraph]')];
  if (fields.length) return fields.map((field) => field.value);
  return [...document.querySelectorAll('.sop-text')].map((node) => (node.textContent === '—' ? '' : node.textContent));
}

function sopManualHtml(manual) {
  const doc = manual?.document || {};
  if (!doc || (!doc.title && !(doc.steps || []).length && !(doc.safety || []).length)) return '';
  const safetyHeaders = doc.safety_headers || {};
  const stepsHeaders = doc.steps_headers || {};
  const safetyDetail = safetyHeaders.detail || t('Detailed standards');
  const safetyDesc = safetyHeaders.description || t('Requirement description');
  const safetyCat = safetyHeaders.category || t('Category');
  const stepAction = stepsHeaders.action || t('Procedure and steps');
  const stepStandard = stepsHeaders.standard || t('Standards and measurements');
  const stepNotes = stepsHeaders.notes || t('Safety and quality notes');
  const stepPhase = stepsHeaders.phase || t('Main phase');
  const meta = `
    <div class="sop-manual-section">
      <div class="sop-manual-section-title">${esc(doc.meta_heading || t('Document and equipment information'))}</div>
      <div class="sop-manual-meta">
        <div class="sop-manual-meta-row"><span>${esc(doc.document_no_label || t('Document No.:'))}</span><b>${esc(doc.document_no || '—')}</b></div>
        <div class="sop-manual-meta-row"><span>${esc(doc.equipment_name_label || t('Equipment name:'))}</span><b>${esc(doc.equipment_name || '—')}</b></div>
        <div class="sop-manual-meta-row"><span>${esc(doc.location_label || t('Location / section:'))}</span><b>${esc(doc.location || '—')}</b></div>
      </div>
    </div>`;
  const safetyRows = (doc.safety || []).map((row) => `<tr>
      <td data-label="${esc(safetyDetail)}">${esc(row.detail || '—')}</td>
      <td data-label="${esc(safetyDesc)}">${esc(row.description || '—')}</td>
      <td data-label="${esc(safetyCat)}">${esc(row.category || '—')}</td>
    </tr>`).join('') || `<tr><td data-label="${esc(t('Category'))}" colspan="3">${esc(t('No records yet'))}</td></tr>`;
  const safety = `
    <div class="sop-manual-section">
      <div class="sop-manual-section-title">${esc(doc.safety_heading || t('Safety, LOTO and tools'))}</div>
      <div class="sop-manual-table-wrap">
        <table class="sop-manual-table">
          <thead><tr>
            <th>${esc(safetyDetail)}</th>
            <th>${esc(safetyDesc)}</th>
            <th>${esc(safetyCat)}</th>
          </tr></thead>
          <tbody>${safetyRows}</tbody>
        </table>
      </div>
    </div>`;
  const stepRows = (doc.steps || []).map((row) => `<tr>
      <td data-label="${esc(stepAction)}">${esc(row.action || '—')}</td>
      <td data-label="${esc(stepStandard)}">${esc(row.standard || '—')}</td>
      <td data-label="${esc(stepNotes)}">${esc(row.notes || '—')}</td>
      <td data-label="${esc(stepPhase)}">${esc(row.phase || '—')}</td>
    </tr>`).join('') || `<tr><td data-label="${esc(stepPhase)}" colspan="4">${esc(t('No records yet'))}</td></tr>`;
  const steps = `
    <div class="sop-manual-section">
      <div class="sop-manual-section-title">${esc(doc.steps_heading || t('Detailed maintenance steps'))}</div>
      <div class="sop-manual-table-wrap">
        <table class="sop-manual-table sop-manual-steps">
          <thead><tr>
            <th>${esc(stepAction)}</th>
            <th>${esc(stepStandard)}</th>
            <th>${esc(stepNotes)}</th>
            <th>${esc(stepPhase)}</th>
          </tr></thead>
          <tbody>${stepRows}</tbody>
        </table>
      </div>
    </div>`;
  const fileNote = manual.filename ? `<small class="sop-manual-file">${esc(t('Imported file'))}: ${esc(manual.filename)}</small>` : '';
  return `<article class="sop-manual" dir="rtl" lang="ar">
    <header class="sop-manual-head">
      <h2>${esc(doc.title || t('Standard operating procedure'))}</h2>
      <p>${esc(doc.subtitle || '')}</p>
      ${fileNote}
    </header>
    ${meta}${safety}${steps}
  </article>`;
}

function sopParagraphEditor(equipment, manual) {
  const locked = !canMaintain();
  const hasManual = Boolean(manual?.document);
  const write = locked
    ? ''
    : `<button type="button" id="sop-import" class="detail-button primary">${esc(t(hasManual ? 'Replace SOP file' : 'Publish SOP file'))}</button><input id="sop-import-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden>${hasManual ? `<button type="button" class="detail-button danger" data-delete="/equipment" data-delete-id="${esc(equipment.equipment_id)}" data-delete-suffix="/sop" data-delete-note="Delete this equipment SOP? The published file will be removed.">${esc(t('Delete SOP'))}</button>` : ''}`;
  const emptyNote = isTechnician()
    ? t('Select a machine that has a published SOP file.')
    : t('Each machine has one SOP only. Publish it by importing one Excel file.');
  const empty = `<p class="kpi-note">${esc(emptyNote)}</p>`;
  const viewer = hasManual
    ? `${sopManualHtml(manual)}${locked ? '' : `<p class="kpi-note">${esc(t('This operating manual opens inside the site in the same form as the imported Excel file.'))}</p>`}`
    : empty;
  return `<section class="sop-sheet">
    <div class="sop-sheet-bar">
      <h3>${esc(t('Operating manual'))} · ${esc(equipment.equipment_id)} · ${esc(equipment.name || '')}</h3>
      ${write}
    </div>
    ${viewer}
    <p id="sop-error" class="form-error"></p>
  </section>`;
}

async function loadSopBundle(equipmentId) {
  const data = await apiRequest(`/equipment/${encodeURIComponent(equipmentId)}/sop-paragraphs`);
  return {
    paragraphs: (data.items || []).map((item) => item.body || ''),
    manual: data.manual || null,
  };
}

async function loadSopParagraphs(equipmentId) {
  const data = await loadSopBundle(equipmentId);
  return data.paragraphs;
}

async function importSopParagraphs(file) {
  const equipmentId = ui.equipmentId;
  const error = document.getElementById('sop-error');
  if (!equipmentId || !canMaintain() || !file) return;
  if (error) error.textContent = '';
  const body = new FormData();
  body.append('file', file);
  try {
    await apiRequest(`/equipment/${encodeURIComponent(equipmentId)}/sop-paragraphs/import`, { method: 'POST', body });
    store = null;
    toast(t('SOP file imported.'));
    await drawSops();
  } catch (exception) {
    if (error) error.textContent = t(exception.message);
  }
}

function oneSopPerEquipment(list) {
  const byEquipment = new Map();
  (list || []).forEach((sop) => {
    const key = sop.equipment_id || sop.sop_id;
    const current = byEquipment.get(key);
    if (!current || Number(sop.id || 0) >= Number(current.id || 0)) byEquipment.set(key, sop);
  });
  return [...byEquipment.values()];
}

async function drawSops() {
  const techView = isTechnician();
  const withSop = equipmentIdsWithSopFile();
  if (techView && ui.equipmentId && !withSop.has(ui.equipmentId)) {
    ui.equipmentId = '';
    ui.rowKey = '';
  }
  const chosen = ui.equipmentId;
  const equipment = equipmentOf(chosen);
  let manual = null;
  if (chosen) {
    try {
      const bundle = await loadSopBundle(chosen);
      manual = bundle.manual;
    } catch (_) {
      manual = null;
    }
  }
  const all = oneSopPerEquipment(store.sops || []);
  const machines = (store.equipment || []).filter((item) => {
    if (selectedPlantIds().length && !selectedPlantIds().includes(item.plant_id)) return false;
    if (!selectedPlantIds().length && ui.plantId && item.plant_id !== ui.plantId) return false;
    if (ui.lineId && item.line_id !== ui.lineId) return false;
    if (ui.sectionId && item.section_id !== ui.sectionId) return false;
    return true;
  });
  const published = all.filter((sop) => /Published|Approved/i.test(sop.status || '') || sop.document_path);
  const publishedScoped = published.filter((sop) => machines.some((item) => item.equipment_id === sop.equipment_id));
  const missing = Math.max(0, machines.length - publishedScoped.length);
  const rows = all.filter((sop) => {
    if (!machines.some((item) => item.equipment_id === sop.equipment_id)) return false;
    if (ui.equipmentId && sop.equipment_id !== ui.equipmentId) return false;
    if (ui.tab === 'Published') return /Published|Approved/i.test(sop.status || '') || sop.document_path;
    return true;
  });
  const selected = chosen
    ? rows.find((sop) => sop.equipment_id === chosen) || all.find((sop) => sop.equipment_id === chosen)
    : (rows.find((sop) => sop.sop_id === ui.rowKey) || rows[0]);
  document.getElementById('metric-grid').innerHTML = techView
    ? metrics([
      ['Equipment with SOP', String(publishedScoped.length), '⚙', 'blue', ''],
      ['Published SOPs', String(publishedScoped.length), '✓', 'green', ''],
      ['Open published SOP', String(publishedScoped.length), '▤', 'purple', ''],
    ])
    : metrics([
      ['Equipment', String(machines.length), '⚙', 'blue', ''],
      ['Published SOPs', String(publishedScoped.length), '✓', 'green', ''],
      ['Without SOP', String(missing), '!', 'red', ''],
      ['One SOP per machine', '1', '▤', 'purple', ''],
      ['File publish only', 'xlsx', '◈', 'blue', ''],
      ['Compliance', `${machines.length ? numberText((publishedScoped.length / machines.length) * 100) : 0}%`, '◈', 'green', ''],
    ]);
  const pickNote = techView
    ? t('Select a machine that has a published SOP file.')
    : t('Select a machine, then publish one SOP Excel file for it. Machines without an SOP are marked in red.');
  const sheet = equipment
    ? sopParagraphEditor(equipment, manual)
    : `<p class="live-note">${esc(pickNote)}</p>`;
  const filterBar = filtersHtml({ sopOnly: techView });
  const list = assetList(chosen, {
    requireSop: techView,
    markMissingSop: !techView,
  });
  let markup;
  if (techView) {
    markup = `<section class="panel sop-tech-panel">${filterBar}<div class="sop-tech-layout">${list}<div class="sop-tech-view">${sheet}</div></div></section>`;
  } else {
    const body = rows.map((sop) => `<tr data-row="${esc(sop.sop_id)}" class="${selected && selected.sop_id === sop.sop_id ? 'selected' : ''}">${cell(esc(sop.sop_id), true)}${cell(esc(sop.title))}${cell(esc(sop.equipment_id || '—'))}${cell(esc(sop.revision || '—'))}${cell(liveBadge(sop.status))}${cell(esc(sop.document_path || '—'))}</tr>`);
    let detail = selected
      ? detailPanel('SOP Details', selected.status || '—', selected.sop_id || '—', selected.title || '', [
        ['Equipment', selected.equipment_id], ['Category', selected.sop_type], ['Revision', selected.revision],
        ['Effective', fmtDate(selected.effective_date)], ['Imported file', selected.document_path || '—'],
      ])
      : `<aside class="panel detail"><h2>${esc(t('SOP Details'))}</h2><p class="live-note">${esc(pickNote)}</p></aside>`;
    markup = `<section class="panel">${filterBar}<div class="split">${list}<div class="asset-view">${tabsHtml(['All SOPs', 'Published'])}${tableShell(['SOP Code', 'SOP Title', 'Equipment', 'Version', 'Status', 'Imported file'], body, shown(rows.length, all.length, 'SOPs'))}</div></div>${sheet}</section>${detail}`;
  }
  document.getElementById('workspace').className = 'workspace sop-board';
  document.getElementById('workspace').innerHTML = markup;
  if (!techView && canMaintain() && selected?.equipment_id) {
    document.querySelector('.detail')?.insertAdjacentHTML('beforeend', `<button type="button" class="detail-button danger" data-delete="/equipment" data-delete-id="${esc(selected.equipment_id)}" data-delete-suffix="/sop" data-delete-note="Delete this equipment SOP? The published file will be removed.">${esc(t('Delete SOP'))}</button>`);
  }
  bindFilters();
  bindAssets();
  if (!techView) bindRows();
  bindDeletes();
  const importButton = document.getElementById('sop-import');
  const importFile = document.getElementById('sop-import-file');
  importButton?.addEventListener('click', () => importFile?.click());
  importFile?.addEventListener('change', async () => {
    const file = importFile.files?.[0];
    importFile.value = '';
    if (file) await importSopParagraphs(file);
  });
}

function workOrderFor(row) {
  if (!row) return null;
  if (row.wo_id) {
    const linked = store.orders.find((order) => order.work_order_id === row.wo_id);
    if (linked) return linked;
  }
  const code = row.equipment_id;
  const matches = store.orders.filter((order) => order.equipment_id === code || order.manual_equipment_code === code);
  const recordDay = String(row.record_date || '').slice(0, 10);
  const sameDay = matches.filter((order) => order.planned_date === recordDay || order.request_date === recordDay);
  return sameDay[0] || matches[0] || null;
}

function workOrderNumber(row) {
  return row?.wo_id || workOrderFor(row)?.work_order_id || '';
}

function maintenanceKind(row) {
  const type = row?.record_type || workOrderFor(row)?.work_order_type || '';
  if (/Emergency/i.test(type)) return 'Emergency';
  if (/Oil change/i.test(type)) return 'Oil change';
  if (/Corrective/i.test(type)) return 'Corrective';
  return '';
}

function isLogEntry(row) {
  return Boolean(maintenanceKind(row));
}

function logCode(kind) {
  if (kind === 'Emergency') return 'EM';
  if (kind === 'Oil change') return 'OC';
  if (kind === 'Corrective') return 'CM';
  return '';
}

function logParts(text) {
  const names = [];
  const numbers = [];
  String(text || '').split('\n').map((line) => line.trim()).filter(Boolean).forEach((line) => {
    const match = line.match(/^\d+ \| (.*?) \| No: (.*)$/);
    if (!match) {
      names.push(line);
      return;
    }
    if (match[1] && match[1] !== '—') names.push(match[1]);
    if (match[2] && match[2] !== '—') numbers.push(match[2]);
  });
  return {
    names: names.join('، ') || '—',
    numbers: numbers.join('، ') || '—',
  };
}

function oilChangeParts(row) {
  const text = String(row?.description || row?.action || '').replace(/^Oil change:\s*/, '');
  const bits = text.split(' — ').map((part) => part.trim()).filter(Boolean);
  return {
    names: bits[0] || '—',
    numbers: '—',
    quantity: bits[1] || '—',
    work: bits[3] || bits[2] || t('Oil change'),
  };
}

function machinePlace(equipment) {
  if (!equipment) return '—';
  const plant = store.plants.find((row) => row.plant_id === equipment.plant_id)?.name || '';
  const line = store.lines.find((row) => row.line_id === equipment.line_id);
  const lineLabel = line?.name || (line?.line_number != null && line.line_number !== '' ? `${t('Line')} ${line.line_number}` : '');
  const section = sectionName(equipment.section_id);
  return [plant, lineLabel, section, equipment.area].filter(Boolean).join(' / ') || '—';
}

function machineLogPaper(equipment, rows) {
  const body = rows.map((row, index) => {
    const kind = maintenanceKind(row);
    const parts = kind === 'Oil change' ? oilChangeParts(row) : { ...logParts(row.spare_parts), quantity: '—', work: row.action || row.description || '—' };
    const reason = kind === 'Oil change' ? t('Oil change') : (row.cause || '—');
    const downtime = row.downtime_h == null || row.downtime_h === '' ? '—' : numberText(row.downtime_h, 2);
    const remove = canMaintain() ? `<td class="no-print"><button type="button" class="detail-button danger log-delete" data-delete="/machine-records" data-delete-id="${esc(row.id)}" data-delete-keep="1">${esc(t('Delete'))}</button></td>` : '';
    return `<tr><td>${index + 1}</td><td>${esc(fmtDate(row.record_date))}</td><td>${esc(logCode(kind))}</td><td>${esc(reason)}</td><td>${esc(parts.work)}</td><td>${esc(workOrderNumber(row) || '—')}</td><td>${esc(parts.names)}</td><td>${esc(parts.numbers)}</td><td>${esc(parts.quantity)}</td><td>${esc(downtime)}</td><td>${esc(technicianName(row.technician_id) || '—')}</td>${remove}</tr>`;
  }).join('') || `<tr><td colspan="${canMaintain() ? 12 : 11}">${esc(t('No log lines for this machine yet.'))}</td></tr>`;
  const commissioned = String(equipment?.commissioning_date || '').slice(0, 10);
  const lock = canMaintain() ? '' : ' readonly';
  const saveFacts = canMaintain() ? `<button class="detail-button primary no-print log-facts-save" type="submit">${esc(t('Save'))}</button>` : '';
  return `<form class="lube-paper machine-log" id="machine-log"><header class="lube-head"><img src="logo-rayan.png?v=3" alt="Rayan"><div><h2>${esc(t('Equipment maintenance log'))}</h2><p>${esc(t('Mechanical Maintenance Department'))}</p></div><dl>${formNo('equipment_log') ? `<div><dt>${esc(t('Form No.:'))}</dt><dd>${esc(formNo('equipment_log'))}</dd></div>` : ''}<div><dt>${esc(t('Document no.'))}</dt><dd>${esc(equipment?.equipment_id || '—')}</dd></div><div><dt>${esc(t('Revision no.'))}</dt><dd>00</dd></div><div><dt>${esc(t('Issue date'))}</dt><dd>${esc(fmtDate(rows[0]?.record_date) || '—')}</dd></div></dl></header><p class="log-approve">${esc(t('Approved according to'))}: ${esc(t('Mechanical Maintenance Department'))}</p><div class="log-facts"><section><h3>${esc(t('Equipment data'))}</h3><dl><div><dt>${esc(t('Log machine name'))}</dt><dd>${esc(equipment?.name || '—')}</dd></div><div><dt>${esc(t('Machine number'))}</dt><dd>${esc(equipment?.equipment_id || '—')}</dd></div><div><dt>${esc(t('Location / section'))}</dt><dd>${esc(machinePlace(equipment))}</dd></div><div><dt>${esc(t('Commissioning date'))}</dt><dd><input name="commissioning_date" type="date" value="${esc(commissioned)}"${lock}></dd></div><div><dt>${esc(t('Manufacturer'))}</dt><dd><input name="manufacturer" value="${esc(equipment?.manufacturer || '')}"${lock}></dd></div></dl>${saveFacts}</section><section><h3>${esc(t('Maintenance type key'))}</h3><table class="log-key"><thead><tr><th>${esc(t('Maintenance type'))}</th><th>${esc(t('Symbol'))}</th></tr></thead><tbody><tr><td>${esc(t('Corrective'))}</td><td>CM</td></tr><tr><td>${esc(t('Emergency'))}</td><td>EM</td></tr><tr><td>${esc(t('Oil change'))}</td><td>OC</td></tr></tbody></table></section></div><h3 class="log-table-title">${esc(t('Maintenance work and details'))}</h3><div class="sheet-scroll"><table class="lube-table log-table"><colgroup><col class="c-no"><col class="c-date"><col class="c-type"><col class="c-reason"><col class="c-work"><col class="c-order"><col class="c-parts"><col class="c-partno"><col class="c-qty"><col class="c-down"><col class="c-tech">${canMaintain() ? '<col class="c-remove no-print">' : ''}</colgroup><thead><tr><th>${esc(t('No.'))}</th><th>${esc(t('Maintenance date'))}</th><th>${esc(t('Maintenance type'))}</th><th>${esc(t('Reason for maintenance'))}</th><th>${esc(t('Work performed'))}</th><th>${esc(t('Work order no.'))}</th><th>${esc(t('Parts used'))}</th><th>${esc(t('Part No.'))}</th><th>${esc(t('Quantity'))}</th><th>${esc(t('Downtime time'))}</th><th>${esc(t('Technician name'))}</th>${canMaintain() ? `<th class="no-print">${esc(t('Delete'))}</th>` : ''}</tr></thead><tbody>${body}</tbody></table></div></form>`;
}

function drawRecords() {
  const chosen = ui.equipmentId;
  const equipment = store.equipment.find((item) => item.equipment_id === chosen) || null;
  const listed = scoped(store.records).filter(isLogEntry).filter((row) => !chosen || row.equipment_id === chosen);
  const rows = listed.filter((row) => ui.tab === 'All' || maintenanceKind(row) === ui.tab)
    .slice()
    .sort((a, b) => String(a.record_date || '').localeCompare(String(b.record_date || '')) || a.id - b.id);
  document.getElementById('metric-grid').innerHTML = metrics([
    ['Total', String(listed.length), '▤', 'blue', ''],
    ['Corrective', String(listed.filter((row) => maintenanceKind(row) === 'Corrective').length), '⚒', 'orange', ''],
    ['Emergency', String(listed.filter((row) => maintenanceKind(row) === 'Emergency').length), '◉', 'red', ''],
    ['Oil changes', String(listed.filter((row) => maintenanceKind(row) === 'Oil change').length), '◉', 'purple', ''],
    ['Equipment', String(new Set(listed.map((row) => row.equipment_id).filter(Boolean)).size), '⚙', 'blue', ''],
    ['Total Downtime (hrs)', numberText(sum(listed, 'downtime_h'), 1), '◷', 'green', ''],
  ]);
  dateLabel(listed.map((row) => row.record_date));
  document.getElementById('workspace').className = 'workspace log-board';
  document.getElementById('workspace').innerHTML = `<section class="panel"><div class="split">${assetList(chosen)}<div class="asset-view">${tabsHtml(['All', 'Corrective', 'Emergency', 'Oil change'])}${chosen ? machineLogPaper(equipment, rows) : `<p class="live-note">${esc(t('Select a machine to open its maintenance log.'))}</p>`}</div></div></section>`;
  bindAssets();
  bindRows();
  bindDeletes();
  document.getElementById('machine-log')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!canMaintain() || !equipment) return;
    const form = event.currentTarget;
    const error = form.querySelector('.form-error');
    const manufacturer = form.querySelector('[name="manufacturer"]').value.trim();
    const commissioning = form.querySelector('[name="commissioning_date"]').value;
    try {
      const saved = await apiRequest(`/equipment/${encodeURIComponent(equipment.equipment_id)}/log-facts`, {
        method: 'PUT',
        body: JSON.stringify({ manufacturer: manufacturer || null, commissioning_date: commissioning || null }),
      });
      equipment.manufacturer = saved.manufacturer;
      equipment.commissioning_date = saved.commissioning_date;
      toast(t('Saved.'));
    } catch (exception) {
      if (error) error.textContent = t(exception.message);
      else toast(t(exception.message));
    }
  });
}

function jobPartRows(text) {
  const parsed = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = line.match(/^\d+ \| (.*?) \| No: (.*)$/);
    if (!match) return { name: line, number: '' };
    return { name: match[1] === '—' ? '' : match[1], number: match[2] === '—' ? '' : match[2] };
  });
  while (parsed.length < 5) parsed.push({ name: '', number: '' });
  return parsed.map((part, index) => `<tr><td class="lube-no">${index + 1}</td><td><input data-job-part="name" value="${esc(part.name)}"></td><td><input data-job-part="number" value="${esc(part.number)}"></td></tr>`).join('');
}

function jobTypeLabel(type) {
  if (type === 'Corrective') return t('Curative');
  return t(type || '');
}

function jobTypeOptions(selected = 'Corrective') {
  return [
    ['Preventive', 'Preventive'],
    ['Corrective', 'Curative'],
    ['Emergency', 'Emergency'],
    ['Routine', 'Routine'],
    ['Inspection', 'Inspection'],
  ].map(([value, label]) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(t(label))}</option>`).join('');
}

function jobLineLabel(line) {
  if (!line) return '';
  const numbered = line.line_number != null && line.line_number !== '' ? `${t('Line')} ${line.line_number}` : '';
  const ownName = line.name && line.name !== `Line ${line.line_number}` ? line.name : '';
  if (numbered && ownName) return `${numbered} · ${ownName}`;
  return numbered || ownName || line.line_id || '';
}

function jobLocation(order) {
  const equipment = store.equipment.find((item) => item.equipment_id === order?.equipment_id);
  const plantId = equipment?.plant_id || order?.manual_plant_id;
  const lineId = equipment?.line_id || order?.manual_line_id;
  const sectionId = equipment?.section_id || '';
  const plant = store.plants.find((item) => item.plant_id === plantId)?.name || '';
  const line = jobLineLabel(store.lines.find((item) => item.line_id === lineId));
  return { plant, line, section: sectionName(sectionId) };
}

function jobOrderNumber(plantId, when) {
  const plant = (store.plants || []).find((item) => item.plant_id === plantId);
  const code = String(plant?.order_code || '').trim().toUpperCase();
  if (!code) return '';
  const year = String(when || '').slice(0, 4) || String(new Date().getFullYear());
  const stem = `${code}${year}-`;
  let highest = 0;
  (store.orders || []).forEach((order) => {
    const id = String(order.work_order_id || '');
    if (!id.startsWith(stem)) return;
    const tail = id.slice(stem.length);
    if (/^\d+$/.test(tail)) highest = Math.max(highest, Number(tail));
  });
  return `${stem}${String(highest + 1).padStart(3, '0')}`;
}

function jobField(label, control, extra = '') {
  return `<label class="${extra}"><span>${esc(t(label))}</span>${control}</label>`;
}

function jobHead() {
  return `<header class="lube-head"><img src="logo-rayan.png?v=3" alt="Rayan"><div><h2>${esc(t('Maintenance Job Order'))}</h2><small>Maintenance Job Order</small></div><dl><div><dt>${esc(t('Form No.:'))}</dt><dd>${esc(formNo('job_order'))}</dd></div><div><dt>${esc(t('Rev.'))}</dt><dd>a</dd></div></dl></header>`;
}

function bindJobPlace(form) {
  const plantSelect = form.querySelector('#job-plant');
  const lineSelect = form.querySelector('#job-line');
  const sectionSelect = form.querySelector('#job-section');
  const machine = form.querySelector('#job-equipment');
  const list = form.querySelector('#job-equipment-list');
  if (!plantSelect || !lineSelect || !sectionSelect || !machine || !list) return;
  let syncing = false;
  const fillLines = (keep) => {
    const lines = store.lines
      .filter((line) => line.plant_id === plantSelect.value && line.active !== false)
      .sort((a, b) => Number(a.line_number) - Number(b.line_number));
    lineSelect.innerHTML = `<option value="">${esc(t(plantSelect.value ? 'Select line number' : 'Select a plant first'))}</option>${lines.map((line) => `<option value="${esc(line.line_id)}"${line.line_id === keep ? ' selected' : ''}>${esc(jobLineLabel(line))}</option>`).join('')}`;
  };
  const fillSections = (keep) => {
    sectionSelect.innerHTML = sectionOptions(lineSelect.value, keep, lineSelect.value ? 'No section' : 'Select a line first');
  };
  const fillMachines = () => {
    const rows = store.equipment.filter((item) => {
      const plant = store.plants.find((row) => row.plant_id === item.plant_id);
      if (plant && plant.active === false) return false;
      if (plantSelect.value && item.plant_id !== plantSelect.value) return false;
      if (lineSelect.value && item.line_id !== lineSelect.value) return false;
      if (lineSelect.value && (item.section_id || '') !== sectionSelect.value) return false;
      return true;
    });
    list.innerHTML = rows.map((item) => `<option value="${esc(item.equipment_id)}"></option><option value="${esc(item.name)}"></option>`).join('');
  };
  const applyMachine = () => {
    const item = matchEquipment(machine.value);
    if (!item || syncing) return;
    syncing = true;
    if (item.plant_id && openPlants().some((plant) => plant.plant_id === item.plant_id)) plantSelect.value = item.plant_id;
    fillLines(item.line_id || '');
    fillSections(item.section_id || '');
    syncing = false;
    fillMachines();
    refreshJobNumber();
  };
  plantSelect.addEventListener('change', () => {
    if (syncing) return;
    fillLines('');
    fillSections('');
    fillMachines();
    refreshJobNumber();
  });
  lineSelect.addEventListener('change', () => {
    if (syncing) return;
    fillSections('');
    fillMachines();
  });
  sectionSelect.addEventListener('change', () => { if (!syncing) fillMachines(); });
  machine.addEventListener('input', applyMachine);
  machine.addEventListener('change', applyMachine);
  const refreshJobNumber = () => {
    const box = form.querySelector('#job-number');
    if (!box) return;
    const next = jobOrderNumber(plantSelect.value, form.querySelector('[name="planned_date"]')?.value);
    box.value = next || t(plantSelect.value ? 'Set the work order code for this plant.' : 'Created when saved');
  };
  form.querySelector('[name="planned_date"]')?.addEventListener('change', refreshJobNumber);
  fillLines('');
  fillSections('');
  fillMachines();
  refreshJobNumber();
}

function jobActions(order) {
  const pdf = order ? `<button type="button" id="job-pdf-export">${esc(t('Export PDF'))}</button>` : '';
  return `<p id="live-form-error" class="form-error"></p><div class="lube-actions no-print">${pdf}<button type="button" id="job-back">${esc(t('Back'))}</button><button type="submit">${esc(t('Save'))}</button></div>`;
}

function orderForPdf(order) {
  const form = document.getElementById('live-form');
  if (!form || form.dataset.orderId !== order.work_order_id) return order;
  const parts = [...form.querySelectorAll('#job-parts tr')].map((row) => {
    const name = row.querySelector('[data-job-part="name"]')?.value.trim() || '';
    const number = row.querySelector('[data-job-part="number"]')?.value.trim() || '';
    if (!name && !number) return '';
    return `1 | ${name || '—'} | No: ${number || '—'}`;
  }).filter(Boolean);
  return {
    ...order,
    corrective_action: form.querySelector('[name="corrective_action"]')?.value ?? order.corrective_action,
    verification: form.querySelector('[name="verification"]')?.value ?? order.verification,
    parts_used: parts.join('\n'),
  };
}

function exportJobOrderPdf(order) {
  if (!order?.work_order_id) return;
  let root = document.getElementById('job-pdf');
  if (!root) {
    root = document.createElement('div');
    root.id = 'job-pdf';
    document.body.appendChild(root);
  }
  root.innerHTML = workOrderForm(orderForPdf(order));
  root.querySelectorAll('.lube-actions, #live-form-error').forEach((node) => node.remove());
  const form = root.querySelector('form');
  form?.classList.add('job-sheet');
  root.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
  root.querySelectorAll('textarea, input').forEach((field) => {
    if (field.type === 'radio' || field.type === 'checkbox' || field.type === 'hidden') return;
    const block = document.createElement('div');
    block.className = field.closest('table') ? 'job-print-cell' : (field.tagName === 'TEXTAREA' ? 'job-print-text' : 'job-print-line');
    const text = field.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(field.value || '') ? fmtDate(field.value) : (field.value || '');
    block.textContent = text;
    field.replaceWith(block);
  });
  const previousTitle = document.title;
  document.title = `job-order-${order.work_order_id}`;
  document.body.classList.add('job-printing');
  const cleanup = () => {
    document.body.classList.remove('job-printing');
    root.innerHTML = '';
    document.title = previousTitle;
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  window.print();
}

function approvalDateField(order) {
  const raw = String(order?.closing_date || '').slice(0, 10);
  const shown = raw ? fmtDate(raw) : '';
  return `<label class="job-result-date"><span>${esc(t('Order approval date'))}</span><input class="job-code" value="${esc(shown)}" readonly placeholder="${esc(t('Set when the order is approved'))}"></label>`;
}

function workOrderForm(order) {
  const today = isoDate(new Date());
  const partRows = order ? jobPartRows(order.parts_used) : Array.from({ length: 5 }, (_, index) => `<tr><td class="lube-no">${index + 1}</td><td><input data-job-part="name"></td><td><input data-job-part="number"></td></tr>`).join('');
  const parts = `<section class="daily-parts"><h3>${esc(t('Parts used'))}</h3><table class="lube-table"><thead><tr><th>${esc(t('No.'))}</th><th>${esc(t('Parts used'))}</th><th>${esc(t('Part No.'))}</th></tr></thead><tbody id="job-parts">${partRows}</tbody></table></section>`;
  const actions = jobActions();
  if (order) {
    const place = jobLocation(order);
    const crew = order.crew_type === 'External' ? t('External maintenance team') : t('Company maintenance team');
    const fields = [
      jobField('Plant', `<input value="${esc(place.plant)}" readonly>`),
      jobField('Line', `<input value="${esc(place.line)}" readonly>`),
      jobField('Section', `<input value="${esc(place.section)}" readonly>`),
      jobField('Maintenance type', `<input value="${esc(jobTypeLabel(order.work_order_type))}" readonly>`),
      jobField('Machine name', `<input class="job-code" value="${esc(equipmentText(order))}" readonly>`, 'job-wide'),
      jobField('Repair order no.', `<input class="job-code" value="${esc(order.work_order_id)}" readonly>`),
      jobField('Date', `<input type="date" value="${esc(String(order.planned_date || '').slice(0, 10))}" readonly>`),
    ].join('');
    return `<form id="live-form" class="lube-paper job-order" data-order-id="${esc(order.work_order_id)}">${jobHead()}<div class="job-fields">${fields}</div><div class="job-crew"><b>${esc(crew)}</b></div><label class="job-block"><span>${esc(t('Fault'))}</span><textarea readonly>${esc(order.problem_description || '')}</textarea></label><label class="job-block"><span>${esc(t('Action taken'))}</span><textarea name="corrective_action">${esc(order.corrective_action || '')}</textarea></label><div class="job-block"><span>${esc(t('Technician signature'))}</span><input value="${esc(getSavedUser()?.full_name || assigneeNames(order))}" readonly></div>${parts}<label class="job-block"><span>${esc(t('Result'))}</span><textarea name="verification">${esc(order.verification || '')}</textarea></label>${approvalDateField(order)}${jobActions(order)}</form>`;
  }
  const plants = openPlants().map((plant) => `<option value="${esc(plant.plant_id)}">${esc(plant.name)}</option>`).join('');
  const fields = [
    jobField('Plant', `<select name="plant_id" id="job-plant" required><option value="">${esc(t('Select a plant first'))}</option>${plants}</select>`),
    jobField('Line', `<select name="line_id" id="job-line" required><option value="">${esc(t('Select a plant first'))}</option></select>`),
    jobField('Section', `<select name="section_id" id="job-section"><option value="">${esc(t('Select a line first'))}</option></select>`),
    jobField('Maintenance type', `<select name="work_order_type" required>${jobTypeOptions('Corrective')}</select>`),
    jobField('Machine name', `<input class="job-code" name="machine_name" id="job-equipment" list="job-equipment-list" required autocomplete="off" placeholder="${esc(t('Equipment name or number'))}"><datalist id="job-equipment-list"></datalist>`, 'job-wide'),
    jobField('Repair order no.', `<input id="job-number" class="job-code" value="${esc(t('Created when saved'))}" readonly>`),
    jobField('Date', `<input name="planned_date" type="date" value="${today}" required>`),
  ].join('');
  return `<form id="live-form" class="lube-paper job-order">${jobHead()}<div class="job-fields">${fields}</div><div class="job-crew"><label><input type="radio" name="crew_type" value="Company" checked> ${esc(t('Company maintenance team'))}</label><label><input type="radio" name="crew_type" value="External"> ${esc(t('External maintenance team'))}</label></div><label class="job-block"><span>${esc(t('Fault'))}</span><textarea name="problem_description" required></textarea></label><label class="job-block"><span>${esc(t('Action taken'))}</span><textarea name="corrective_action"></textarea></label><div class="job-block"><span>${esc(t('Technician signature'))}</span>${technicianChecks([])}</div>${parts}<label class="job-block"><span>${esc(t('Result'))}</span><textarea name="verification"></textarea></label>${approvalDateField()}${actions}</form>`;
}

function planForm() {
  return formPanel('New PM Task', [
    field('Equipment', selectField('equipment_id', equipmentOptions())),
    field('Task', '<textarea name="task" rows="3" required></textarea>'),
    field('Frequency', selectField('frequency', ['Daily', 'Weekly', 'Monthly', 'Annual'].map((type) => `<option>${type}</option>`).join(''))),
    field('Next due date', '<input name="next_due_date" type="date">'),
    field('Priority', selectField('priority', ['High', 'Medium', 'Low'].map((type) => `<option${type === 'Medium' ? ' selected' : ''}>${type}</option>`).join(''))),
    field('Estimated hours', '<input name="estimated_time_h" type="number" min="0" step="0.1">'),
  ].join(''));
}

function equipmentChoice(values, selected = '') {
  return values.map((type) => `<option value="${esc(type)}"${type === selected ? ' selected' : ''}>${esc(t(type))}</option>`).join('');
}

function equipmentForm() {
  const plants = openPlants().map((plant) => `<option value="${esc(plant.plant_id)}">${esc(plant.name)}</option>`).join('');
  return formPanel('Add Equipment', [
    field('Equipment code', '<input name="equipment_id" required>'),
    field('Name', '<input name="name" required>'),
    field('Category', '<input name="equipment_type" required>'),
    field('Plant', selectField('plant_id', plants, true)),
    field('Line number', '<select name="line_id" required><option value=""></option></select>'),
    field('Section', '<select name="section_id"><option value=""></option></select>'),
    field('Criticality', selectField('criticality', equipmentChoice(CRITICALITY_LEVELS))),
    field('Area', '<input name="area">'),
    field('Manufacturer', '<input name="manufacturer">'),
    field('Model', '<input name="model">'),
    field('Serial number', '<input name="serial_number">'),
    field('Status', selectField('status', equipmentChoice(['Running', 'Under Maintenance', 'Out of Service'], 'Running'))),
    field('Condition', selectField('condition', equipmentChoice(['Good', 'Fair', 'Poor']), false)),
    field('Capacity', '<input name="capacity" type="number" min="0" step="any">'),
    field('Capacity unit', '<input name="capacity_unit">'),
    field('Motor power (kW)', '<input name="motor_power_kw" type="number" min="0" step="any">'),
    field('Notes', '<textarea name="notes" rows="3"></textarea>'),
  ].join(''));
}

function bindEquipmentLines(form) {
  const plantSelect = form.querySelector('[name="plant_id"]');
  const lineSelect = form.querySelector('[name="line_id"]');
  const sectionSelect = form.querySelector('[name="section_id"]');
  if (!plantSelect || !lineSelect) return;
  const fillSections = () => {
    if (!sectionSelect) return;
    sectionSelect.innerHTML = sectionOptions(lineSelect.value, '', lineSelect.value ? 'No section' : 'Select a line first');
  };
  const fill = () => {
    const lines = store.lines.filter((line) => line.plant_id === plantSelect.value).sort((a, b) => Number(a.line_number) - Number(b.line_number));
    lineSelect.innerHTML = `<option value="">${esc(t(plantSelect.value ? 'Select line number' : 'Select a plant first'))}</option>${lines.map((line) => {
      const label = lineText(line);
      const extra = line.name && line.name !== label ? ` — ${line.name}` : '';
      return `<option value="${esc(line.line_id)}">${esc(label + extra)}</option>`;
    }).join('')}`;
    fillSections();
  };
  plantSelect.addEventListener('change', fill);
  lineSelect.addEventListener('change', fillSections);
  fill();
}

function sopForm() {
  return formPanel('Add SOP', [
    field('Equipment', selectField('equipment_id', equipmentOptions())),
    field('Title', '<input name="title" required>'),
    field('Category', '<input name="sop_type">'),
    field('Revision', '<input name="revision" value="00">'),
    field('Status', selectField('status', ['Draft', 'Under Review', 'Published'].map((type) => `<option>${type}</option>`).join(''))),
  ].join(''));
}

function plantMenuSummaryText() {
  const plants = selectedPlantIds();
  if (!plants.length) return t('All plants');
  if (plants.length === 1) {
    return openPlants().find((plant) => plant.plant_id === plants[0])?.name || plants[0];
  }
  return `${plants.length} ${t('plants selected')}`;
}

function setPlantMenuOpen(open) {
  const toggle = document.getElementById('plant-menu-toggle');
  const panel = document.getElementById('plant-menu-panel');
  if (!toggle || !panel) return;
  ui.plantMenuOpen = Boolean(open);
  panel.hidden = !open;
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  toggle.classList.toggle('open', Boolean(open));
}

function applyPlantMenuSelection(ids, { redraw = true, keepOpen = false } = {}) {
  syncPlantSelection(ids);
  ui.lineId = '';
  ui.sectionId = '';
  ui.equipmentId = '';
  ui.rowKey = '';
  const summary = document.getElementById('plant-menu-summary');
  if (summary) summary.textContent = plantMenuSummaryText();
  if (!redraw) return;
  ui.plantMenuOpen = keepOpen;
  draw(ui.page);
}

function bindPlantMenu() {
  const toggle = document.getElementById('plant-menu-toggle');
  const panel = document.getElementById('plant-menu-panel');
  if (!toggle || !panel) return;
  if (ui.plantMenuOpen) setPlantMenuOpen(true);
  toggle.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    setPlantMenuOpen(panel.hidden);
  });
  panel.addEventListener('click', (event) => event.stopPropagation());
  panel.querySelectorAll('input[type="checkbox"]').forEach((box) => {
    box.addEventListener('change', () => {
      const ids = [...panel.querySelectorAll('input:checked')].map((item) => item.value);
      applyPlantMenuSelection(ids, { redraw: true, keepOpen: true });
    });
  });
  document.getElementById('plant-menu-clear')?.addEventListener('click', (event) => {
    event.preventDefault();
    applyPlantMenuSelection([], { redraw: true, keepOpen: true });
  });
  if (!ui._plantMenuDocBound) {
    ui._plantMenuDocBound = true;
    document.addEventListener('click', (event) => {
      if (!ui.plantMenuOpen) return;
      if (event.target.closest?.('.plant-menu')) return;
      setPlantMenuOpen(false);
    });
  }
}

function bindFilters() {
  const fields = { plant: 'plantId', line: 'lineId', section: 'sectionId', equipment: 'equipmentId', technician: 'technicianId', from: 'dateFrom', to: 'dateTo' };
  bindPlantMenu();
  document.querySelectorAll('[data-filter]').forEach((select) => {
    if (select.dataset.filter === 'plants') return;
    select.addEventListener('change', () => {
      ui[fields[select.dataset.filter] || 'equipmentId'] = select.value;
      if (select.dataset.filter === 'plant') {
        syncPlantSelection(select.value ? [select.value] : []);
        ui.lineId = '';
        ui.sectionId = '';
        ui.equipmentId = '';
      }
      if (select.dataset.filter === 'line') { ui.sectionId = ''; ui.equipmentId = ''; }
      if (select.dataset.filter === 'section') ui.equipmentId = '';
      ui.rowKey = '';
      draw(ui.page);
    });
  });
}

function bindDeletes() {
  document.querySelectorAll('[data-delete]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!canMaintain()) return;
      const note = button.dataset.deleteNote || 'Delete this record? This cannot be undone.';
      if (!window.confirm(t(note))) return;
      try {
        const suffix = button.dataset.deleteSuffix || '';
        const path = button.dataset.deleteId
          ? `${button.dataset.delete}/${encodeURIComponent(button.dataset.deleteId)}${suffix}`
          : button.dataset.delete;
        await apiRequest(path, { method: 'DELETE' });
        store = null;
        if (!button.dataset.deleteKeep) ui.rowKey = '';
        if (button.dataset.delete === '/lubrication-reports') ui.lubeId = '';
        toast(t('Deleted.'));
        await paint(ui.page);
      } catch (error) {
        toast(error.message);
      }
    });
  });
}

function bindRows() {
  document.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => {
    ui.tab = button.dataset.tab;
    ui.mode = 'view';
    ui.rowKey = '';
    draw(ui.page);
  }));
  document.querySelectorAll('[data-row]').forEach((row) => row.addEventListener('click', () => {
    ui.rowKey = row.dataset.row;
    ui.mode = 'view';
    if (ui.page === 'sop') {
      const sop = (store.sops || []).find((item) => item.sop_id === row.dataset.row);
      if (sop?.equipment_id) ui.equipmentId = sop.equipment_id;
    }
    draw(ui.page);
  }));
}

function bindAssets() {
  document.querySelectorAll('[data-asset]').forEach((item) => item.addEventListener('click', () => {
    ui.equipmentId = ui.equipmentId === item.dataset.asset ? '' : item.dataset.asset;
    ui.rowKey = '';
    draw(ui.page);
  }));
  document.getElementById('asset-search')?.addEventListener('input', (event) => {
    const query = event.target.value.toLowerCase();
    document.querySelectorAll('[data-asset]').forEach((item) => { item.hidden = !item.textContent.toLowerCase().includes(query); });
  });
}

function bindForm() {
  const form = document.getElementById('live-form');
  if (!form) return;
  if (ui.page === 'equipment') bindEquipmentLines(form);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = document.getElementById('live-form-error');
    const formData = new FormData(form);
    const data = Object.fromEntries(formData.entries());
    Object.keys(data).forEach((key) => { if (data[key] === '') data[key] = null; });
    try {
      if (ui.page === 'work-orders') {
        const parts = [...document.querySelectorAll('#job-parts tr')].map((row) => ({
          name: row.querySelector('[data-job-part="name"]').value.trim(),
          number: row.querySelector('[data-job-part="number"]').value.trim(),
        })).filter((part) => part.name || part.number);
        const partsUsed = parts.length ? parts.map((part, index) => `${index + 1} | ${part.name || '—'} | No: ${part.number || '—'}`).join('\n') : null;
        if (form.dataset.orderId) {
          await apiRequest(`/work-orders/${encodeURIComponent(form.dataset.orderId)}`, { method: 'PUT', body: JSON.stringify({
            corrective_action: data.corrective_action,
            verification: data.verification,
            parts_used: partsUsed,
          }) });
        } else {
          const technicians = formData.getAll('assigned_technician_ids').filter(Boolean);
          const knownMachine = matchEquipment(data.machine_name);
          if (!data.plant_id || !data.line_id) throw new Error(t('Select a plant and then a line number.'));
          if (knownMachine && data.plant_id !== knownMachine.plant_id) throw new Error(t('The machine does not belong to the selected plant'));
          if (knownMachine && data.line_id && knownMachine.line_id && data.line_id !== knownMachine.line_id) throw new Error(t('The machine does not belong to the selected line'));
          if (knownMachine && data.section_id && knownMachine.section_id && data.section_id !== knownMachine.section_id) throw new Error(t('The machine does not belong to the selected section'));
          await apiRequest('/work-orders', { method: 'POST', body: JSON.stringify({
            work_order_type: data.work_order_type,
            equipment_id: knownMachine ? knownMachine.equipment_id : null,
            manual_equipment_name: knownMachine ? null : data.machine_name,
            priority: 'Medium',
            status: 'Open',
            problem_description: data.problem_description,
            corrective_action: data.corrective_action,
            verification: data.verification,
            parts_used: partsUsed,
            crew_type: data.crew_type,
            planned_date: data.planned_date,
            assigned_technician_ids: technicians,
          }) });
        }
      } else if (ui.page === 'pm-schedule') {
        data.frequency_value = 1;
        data.pm_type = 'Preventive';
        data.active = true;
        if (data.estimated_time_h) data.estimated_time_h = Number(data.estimated_time_h);
        await apiRequest('/pm', { method: 'POST', body: JSON.stringify(data) });
      } else if (ui.page === 'equipment') {
        if (!data.plant_id || !data.line_id) throw new Error('Select a plant and then a line number.');
        ['capacity', 'motor_power_kw'].forEach((key) => {
          if (data[key] != null) data[key] = Number(data[key]);
        });
        await apiRequest('/equipment', { method: 'POST', body: JSON.stringify(data) });
      } else if (ui.page === 'plants') {
        data.active = data.active !== 'false';
        await apiRequest('/plants', { method: 'POST', body: JSON.stringify(data) });
      } else if (ui.page === 'sop') {
        throw new Error('Publish one SOP per equipment by importing an Excel file.');
      }
      store = null;
      ui.mode = 'view';
      toast(form.dataset.orderId ? t('Work order accepted and added to your daily report.') : 'Saved.');
      await paint(ui.page);
    } catch (exception) {
      error.textContent = exception.message;
    }
  });
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(entries) {
  const encoder = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const bytesOf = (values) => new Uint8Array(values);
  const u16 = (value) => [value & 255, (value >> 8) & 255];
  const u32 = (value) => [value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >> 24) & 255];
  entries.forEach((entry) => {
    const name = encoder.encode(entry.name);
    const data = entry.data;
    const crc = crc32(data);
    const local = bytesOf([
      0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), 0, 0,
    ]);
    parts.push(local, name, data);
    central.push(bytesOf([
      0x50, 0x4b, 0x01, 0x02, 20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length),
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...u32(offset),
    ]), name);
    offset += local.length + name.length + data.length;
  });
  const centralStart = offset;
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = bytesOf([
    0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0,
    ...u16(entries.length), ...u16(entries.length), ...u32(centralSize), ...u32(centralStart), 0, 0,
  ]);
  return new Blob([...parts, ...central, end], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

function xmlText(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function columnLetters(index) {
  let number = index;
  let letters = '';
  while (number > 0) {
    const remainder = (number - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    number = Math.floor((number - 1) / 26);
  }
  return letters;
}

function workbookStyles() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="0.##"/></numFmts>
<fonts count="7">
<font><sz val="11"/><color rgb="FF102D60"/><name val="Calibri"/></font>
<font><b/><sz val="18"/><color rgb="FF102D60"/><name val="Calibri"/></font>
<font><b/><sz val="12"/><color rgb="FF102D60"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FF102D60"/><name val="Calibri"/></font>
<font><b/><sz val="10"/><color rgb="FF102D60"/><name val="Calibri"/></font>
<font><sz val="10"/><color rgb="FF102D60"/><name val="Calibri"/></font>
<font><b/><sz val="12"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
</fonts>
<fills count="4">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE7F0FF"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF102D60"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="3">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FF2A5287"/></left><right style="thin"><color rgb="FF2A5287"/></right><top style="thin"><color rgb="FF2A5287"/></top><bottom style="thin"><color rgb="FF2A5287"/></bottom><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FF8EABDA"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="17">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="6" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="2" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="4" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="5" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="5" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="2" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="5" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="4" fillId="2" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="164" fontId="3" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
</cellXfs>
</styleSheet>`;
}

function excelNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value ?? '').trim();
  if (!text || text === '—' || !/^-?\d+(\.\d+)?$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function worksheetRows(cells, heights) {
  const byRow = new Map();
  cells.forEach((cell) => {
    if (!byRow.has(cell.r)) byRow.set(cell.r, []);
    byRow.get(cell.r).push(cell);
  });
  return [...byRow.keys()].sort((a, b) => a - b).map((row) => {
    const body = byRow.get(row).sort((a, b) => a.c - b.c).map((cell) => {
      const ref = `${columnLetters(cell.c)}${row}`;
      if (typeof cell.v === 'number' && Number.isFinite(cell.v)) return `<c r="${ref}" s="${cell.s}"><v>${cell.v}</v></c>`;
      if (cell.v === '' || cell.v == null) return `<c r="${ref}" s="${cell.s}"/>`;
      return `<c r="${ref}" s="${cell.s}" t="inlineStr"><is><t xml:space="preserve">${xmlText(cell.v)}</t></is></c>`;
    }).join('');
    return `<row r="${row}" ht="${heights[row] || 20}" customHeight="1">${body}</row>`;
  }).join('');
}

function packWorkbook(sheet, sheetName, logo, logoRows = 4) {
  const encoder = new TextEncoder();
  const files = [
    { name: '[Content_Types].xml', data: encoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${logo ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : ''}
</Types>`) },
    { name: '_rels/.rels', data: encoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`) },
    { name: 'xl/workbook.xml', data: encoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${xmlText(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: encoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`) },
    { name: 'xl/styles.xml', data: encoder.encode(workbookStyles()) },
    { name: 'xl/worksheets/sheet1.xml', data: encoder.encode(sheet) },
  ];
  if (logo) {
    files.push(
      { name: 'xl/worksheets/_rels/sheet1.xml.rels', data: encoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`) },
      { name: 'xl/drawings/drawing1.xml', data: encoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<xdr:twoCellAnchor editAs="oneCell">
<xdr:from><xdr:col>0</xdr:col><xdr:colOff>80000</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>40000</xdr:rowOff></xdr:from>
<xdr:to><xdr:col>2</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${logoRows}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
<xdr:pic>
<xdr:nvPicPr><xdr:cNvPr id="1" name="Logo"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>
<xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
<xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>
</xdr:pic>
<xdr:clientData/>
</xdr:twoCellAnchor>
</xdr:wsDr>`) },
      { name: 'xl/drawings/_rels/drawing1.xml.rels', data: encoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/logo.png"/>
</Relationships>`) },
      { name: 'xl/media/logo.png', data: logo },
    );
  }
  return zipStore(files);
}

function buildMaintenanceLogWorkbook(model) {
  const rtl = model.rtl;
  const labelStyle = rtl ? 12 : 5;
  const valueStyle = rtl ? 13 : 6;
  const textStyle = rtl ? 14 : 11;
  const cells = [];
  const merges = [];
  const place = (row, column, value, style) => cells.push({ r: row, c: column, v: value, s: style });
  const merge = (row, column, rowTo, columnTo, value, style) => {
    place(row, column, value, style);
    if (row !== rowTo || column !== columnTo) merges.push(`${columnLetters(column)}${row}:${columnLetters(columnTo)}${rowTo}`);
  };
  const lastCol = 11;
  let row = 1;
  const heights = {};

  // Header block matching the on-screen maintenance log form.
  merge(row, 1, row, lastCol, model.title, 1);
  heights[row] = 28;
  row += 1;
  merge(row, 1, row, lastCol, model.department, 2);
  heights[row] = 22;
  row += 1;

  const meta = model.meta || [];
  meta.forEach((item) => {
    merge(row, 1, row, 3, item.label, labelStyle);
    merge(row, 4, row, lastCol, item.value == null || item.value === '' ? '—' : item.value, valueStyle);
    heights[row] = 20;
    row += 1;
  });

  merge(row, 1, row, lastCol, model.approved, 3);
  heights[row] = 22;
  row += 1;

  merge(row, 1, row, lastCol, model.equipmentTitle, 4);
  heights[row] = 22;
  row += 1;
  (model.facts || []).forEach((item) => {
    merge(row, 1, row, 3, item.label, labelStyle);
    merge(row, 4, row, lastCol, item.value == null || item.value === '' ? '—' : item.value, valueStyle);
    heights[row] = 20;
    row += 1;
  });

  merge(row, 1, row, lastCol, model.keyTitle, 4);
  heights[row] = 22;
  row += 1;
  merge(row, 1, row, 8, model.typeHeading, 9);
  merge(row, 9, row, lastCol, model.symbolHeading, 9);
  heights[row] = 20;
  row += 1;
  (model.key || []).forEach((item) => {
    merge(row, 1, row, 8, item.label, 8);
    merge(row, 9, row, lastCol, item.value, 10);
    heights[row] = 20;
    row += 1;
  });

  row += 1;
  merge(row, 1, row, lastCol, model.tableTitle, 4);
  heights[row] = 24;
  row += 1;

  const headerRow = row;
  (model.headings || []).forEach((heading, index) => place(headerRow, index + 1, heading, 9));
  heights[headerRow] = 32;
  row += 1;

  const dataStart = row;
  (model.lines || []).forEach((line, index) => {
    const current = dataStart + index;
    heights[current] = 28;
    line.forEach((value, column) => {
      const numeric = column === 0 || column === 8 || column === 9;
      const number = numeric ? excelNumber(value) : null;
      const textColumn = column === 3 || column === 4 || column === 6 || column === 10;
      place(current, column + 1, number == null ? value : number, number == null ? (textColumn ? textStyle : 10) : 16);
    });
  });
  if (!(model.lines || []).length) {
    heights[dataStart] = 24;
    merge(dataStart, 1, dataStart, lastCol, model.empty, textStyle);
  }

  const lastRow = Math.max(dataStart, dataStart + Math.max(0, (model.lines || []).length) - 1);
  const sheetRows = worksheetRows(cells, heights);
  const drawing = model.logo ? '<drawing r:id="rId1"/>' : '';
  const mergeXml = merges.length
    ? `<mergeCells count="${merges.length}">${merges.map((ref) => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells>`
    : '';
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<dimension ref="A1:K${lastRow}"/>
<sheetViews><sheetView showGridLines="0" rightToLeft="${rtl ? 1 : 0}" workbookViewId="0"/></sheetViews>
<sheetFormatPr defaultRowHeight="18"/>
<cols>
<col min="1" max="1" width="8" customWidth="1"/>
<col min="2" max="2" width="14" customWidth="1"/>
<col min="3" max="3" width="14" customWidth="1"/>
<col min="4" max="4" width="22" customWidth="1"/>
<col min="5" max="5" width="28" customWidth="1"/>
<col min="6" max="6" width="16" customWidth="1"/>
<col min="7" max="7" width="20" customWidth="1"/>
<col min="8" max="8" width="14" customWidth="1"/>
<col min="9" max="9" width="12" customWidth="1"/>
<col min="10" max="10" width="12" customWidth="1"/>
<col min="11" max="11" width="18" customWidth="1"/>
</cols>
<sheetData>${sheetRows}</sheetData>
${mergeXml}
<pageMargins left="0.4" right="0.4" top="0.4" bottom="0.4" header="0.2" footer="0.2"/>
<pageSetup orientation="landscape" paperSize="9" fitToWidth="1" fitToHeight="0"/>
${drawing}
</worksheet>`;
  return packWorkbook(sheet, model.sheetName, model.logo, 2);
}

async function exportRecords() {
  const chosen = ui.equipmentId;
  const equipment = (store.equipment || []).find((item) => item.equipment_id === chosen) || null;
  if (!equipment) {
    toast(t('Select a machine to open its maintenance log.'));
    return;
  }
  const listed = scoped(store.records).filter(isLogEntry).filter((row) => row.equipment_id === chosen);
  const rows = listed.filter((row) => ui.tab === 'All' || maintenanceKind(row) === ui.tab)
    .slice()
    .sort((a, b) => String(a.record_date || '').localeCompare(String(b.record_date || '')) || a.id - b.id);
  const form = document.getElementById('machine-log');
  const commissioning = form?.querySelector('[name="commissioning_date"]')?.value || String(equipment.commissioning_date || '').slice(0, 10);
  const manufacturer = form?.querySelector('[name="manufacturer"]')?.value ?? equipment.manufacturer ?? '';
  const formNumber = formNo('equipment_log');
  const meta = [];
  if (formNumber) meta.push({ label: t('Form No.:'), value: formNumber });
  meta.push({ label: t('Document no.'), value: equipment.equipment_id || '—' });
  meta.push({ label: t('Revision no.'), value: '00' });
  meta.push({ label: t('Issue date'), value: fmtDate(rows[0]?.record_date) });
  const lines = rows.map((row, index) => {
    const kind = maintenanceKind(row);
    const parts = kind === 'Oil change' ? oilChangeParts(row) : { ...logParts(row.spare_parts), quantity: '—', work: row.action || row.description || '—' };
    const downtime = row.downtime_h == null || row.downtime_h === '' ? '—' : numberText(row.downtime_h, 2);
    return [
      index + 1,
      fmtDate(row.record_date),
      logCode(kind),
      kind === 'Oil change' ? t('Oil change') : (row.cause || '—'),
      parts.work || '—',
      workOrderNumber(row) || '—',
      parts.names || '—',
      parts.numbers || '—',
      parts.quantity || '—',
      downtime,
      technicianName(row.technician_id) || '—',
    ];
  });
  let logo = null;
  try {
    const response = await fetch('logo-rayan.png?v=3');
    if (response.ok) logo = new Uint8Array(await response.arrayBuffer());
  } catch (_) {
    logo = null;
  }
  try {
    const blob = buildMaintenanceLogWorkbook({
      rtl: document.documentElement.dir === 'rtl',
      sheetName: t('Equipment maintenance log').slice(0, 31),
      title: t('Equipment maintenance log'),
      department: t('Mechanical Maintenance Department'),
      approved: `${t('Approved according to')}: ${t('Mechanical Maintenance Department')}`,
      equipmentTitle: t('Equipment data'),
      keyTitle: t('Maintenance type key'),
      typeHeading: t('Maintenance type'),
      symbolHeading: t('Symbol'),
      tableTitle: t('Maintenance work and details'),
      empty: t('No log lines for this machine yet.'),
      meta,
      facts: [
        { label: t('Log machine name'), value: equipment.name || '—' },
        { label: t('Machine number'), value: equipment.equipment_id || '—' },
        { label: t('Location / section'), value: machinePlace(equipment) },
        { label: t('Commissioning date'), value: fmtDate(commissioning) || '—' },
        { label: t('Manufacturer'), value: manufacturer || '—' },
      ],
      key: [
        { label: t('Corrective'), value: 'CM' },
        { label: t('Emergency'), value: 'EM' },
        { label: t('Oil change'), value: 'OC' },
      ],
      headings: [t('No.'), t('Maintenance date'), t('Maintenance type'), t('Reason for maintenance'), t('Work performed'), t('Work order no.'), t('Parts used'), t('Part No.'), t('Quantity'), t('Downtime time'), t('Technician name')],
      lines,
      logo,
    });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `maintenance-log-${equipment.equipment_id}.xlsx`;
    link.click();
    URL.revokeObjectURL(link.href);
  } catch (exception) {
    toast(t(exception.message) || t('Could not export the maintenance log.'));
  }
}

function buildAnnualPlanWorkbook(model) {
  const rtl = model.rtl;
  const textStyle = rtl ? 14 : 11;
  const cells = [];
  const merges = [];
  const place = (row, column, value, style) => cells.push({ r: row, c: column, v: value, s: style });
  const merge = (row, column, rowTo, columnTo, value, style) => {
    place(row, column, value, style);
    if (row !== rowTo || column !== columnTo) merges.push(`${columnLetters(column)}${row}:${columnLetters(columnTo)}${rowTo}`);
  };
  const lastColumn = 57;
  merge(1, 3, 1, 9, model.title, 1);
  merge(2, 3, 2, 9, model.subtitle, 2);
  model.headings.forEach((heading, index) => merge(4, index + 1, 5, index + 1, heading, 9));
  model.months.forEach((month, index) => {
    const start = 10 + index * 4;
    merge(4, start, 4, start + 3, month, index % 2 ? 9 : 4);
    for (let week = 1; week <= 4; week += 1) place(5, start + week - 1, week, 16);
  });
  const heights = { 1: 26, 2: 22, 4: 24, 5: 20 };
  model.lines.forEach((line, index) => {
    const row = 6 + index;
    heights[row] = 22;
    line.values.forEach((value, column) => {
      const number = excelNumber(value);
      const numericColumn = column === 0 || column === 3 || column === 7 || column === 8;
      const useNumber = numericColumn && number != null;
      const textColumn = column === 2 || column === 4 || column === 5;
      place(row, column + 1, useNumber ? number : (value || ''), useNumber ? 16 : (textColumn ? textStyle : 10));
    });
    const marks = new Set(line.marks || []);
    for (let month = 1; month <= 12; month += 1) {
      for (let week = 1; week <= 4; week += 1) {
        const on = marks.has(`${month}-${week}`);
        place(row, 9 + (month - 1) * 4 + week, on ? week : '', on ? 15 : 10);
      }
    }
  });
  const lastData = model.lines.length ? 5 + model.lines.length : 6;
  if (!model.lines.length) {
    heights[6] = 24;
    merge(6, 1, 6, lastColumn, model.empty, textStyle);
  }
  const end = columnLetters(lastColumn);
  const drawing = model.logo ? '<drawing r:id="rId1"/>' : '';
  const cols = [6, 16, 22, 10, 18, 32, 16, 12, 14].map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('')
    + `<col min="10" max="${lastColumn}" width="4.5" customWidth="1"/>`;
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<dimension ref="A1:${end}${lastData}"/>
<sheetViews><sheetView showGridLines="0" rightToLeft="${rtl ? 1 : 0}" workbookViewId="0"><pane xSplit="9" ySplit="5" topLeftCell="J6" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="18"/>
<cols>${cols}</cols>
<sheetData>${worksheetRows(cells, heights)}</sheetData>
<mergeCells count="${merges.length}">${merges.map((ref) => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells>
<pageMargins left="0.35" right="0.35" top="0.4" bottom="0.4" header="0.2" footer="0.2"/>
<pageSetup orientation="landscape" paperSize="8" fitToWidth="1" fitToHeight="0"/>
${drawing}
</worksheet>`;
  return packWorkbook(sheet, model.sheetName, model.logo, 2);
}

async function exportAnnualPlan() {
  if (!ui.annualPlant) {
    toast(t('Choose a plant, then set the plan.'));
    return;
  }
  const source = document.getElementById('annual-rows') ? readAnnualRows() : (ui.annualItems || []);
  const items = filledAnnualRows(source);
  const plant = (store.plants || []).find((item) => item.plant_id === ui.annualPlant);
  const formNumber = formNo('annual_plan');
  const subtitle = [
    `${t('Plant')}: ${plant?.name || ui.annualPlant}`,
    `${t('Year')}: ${ui.annualYear}`,
    formNumber ? `${t('Form No.:')} ${formNumber}` : '',
  ].filter(Boolean).join('    ');
  const lines = items.map((item, index) => {
    const line = (store.lines || []).find((row) => row.line_id === item.line_id);
    return {
      values: [
        index + 1,
        item.machine_code || '',
        item.machine_name || '',
        line ? (line.line_number ?? '') : '',
        line?.name || '',
        item.task || '',
        t(item.maintenance_type || 'Preventive'),
        item.frequency_time || '',
        item.frequency_hours || '',
      ],
      marks: String(item.weeks || '').split(',').map((part) => part.trim()).filter(Boolean),
    };
  });
  let logo = null;
  try {
    const response = await fetch('logo-rayan.png?v=3');
    if (response.ok) logo = new Uint8Array(await response.arrayBuffer());
  } catch (_) {
    logo = null;
  }
  const blob = buildAnnualPlanWorkbook({
    rtl: document.documentElement.dir === 'rtl',
    sheetName: t('Annual preventive maintenance plan').slice(0, 31),
    title: t('Annual preventive maintenance plan'),
    subtitle,
    headings: [t('No.'), t('Machine number'), t('Machine name'), t('Line number'), t('Line name'), t('Task description'), t('Maintenance type'), t('Every (days)'), t('By running hours')],
    months: ANNUAL_MONTHS.map((month) => t(month)),
    lines,
    empty: t('No records yet'),
    logo,
  });
  const safe = String(plant?.name || ui.annualPlant).replace(/[\\/:*?"<>|]/g, '-').slice(0, 40);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `annual-plan-${ui.annualYear}-${safe}.xlsx`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function pendingSource(row) {
  const reportId = String(row?.report_id || '');
  if (reportId.startsWith('LR-')) return t('Oil and grease report');
  if (reportId.startsWith('DR-')) return t('Daily maintenance report');
  return t('Report');
}

function drawEquipmentFromReports() {
  const rows = store.pending || [];
  const selected = rows.find((row) => String(row.id) === String(ui.rowKey)) || rows[0];
  const all = visibleEquipment();
  document.getElementById('metric-grid').innerHTML = metrics([
    ['Total Equipment', String(all.length), '▣', 'blue', ''],
    ['From reports', String(rows.length), '＋', 'orange', ''],
    ['Pending Approval', String(rows.length), '⌛', 'purple', ''],
  ]);
  const body = rows.map((row) => {
    const plant = store.plants.find((item) => item.plant_id === row.plant_id)?.name || row.plant_id || '—';
    return `<tr data-row="${esc(row.id)}" class="${selected && selected.id === row.id ? 'selected' : ''}">${cell(esc(row.equipment_code), true)}${cell(esc(row.equipment_name))}${cell(esc(plant))}${cell(esc(row.line_number || '—'))}${cell(esc(technicianName(row.technician_id)))}</tr>`;
  });
  const reviewForm = `<form class="live-form" id="pending-review"><label>${esc(t('Equipment name'))}<input id="pending-name" value="${esc(selected?.equipment_name || '')}" required></label><label>${esc(t('Plant'))}<select id="pending-plant"><option value="">${esc(t('Select'))}</option>${openPlants().map((plant) => `<option value="${esc(plant.plant_id)}"${plant.plant_id === selected?.plant_id ? ' selected' : ''}>${esc(plant.name)}</option>`).join('')}</select></label><label>${esc(t('Line number'))}<select id="pending-line"><option value="">${esc(t('Select'))}</option></select></label><label>${esc(t('Section'))}<select id="pending-section"><option value="">${esc(t('No section'))}</option></select></label><label>${esc(t('Criticality'))}<select id="pending-criticality" required><option value="">${esc(t('Select'))}</option>${equipmentChoice(CRITICALITY_LEVELS)}</select></label><div class="summary-row"><span>${esc(t('Technician'))}</span><b>${esc(technicianName(selected?.technician_id))}</b></div><div class="summary-row"><span>${esc(t('Report'))}</span><b>${esc(pendingSource(selected))} ${esc(selected?.report_id || '')}</b></div></form><div class="assign-block"><button class="detail-button primary" type="button" id="approve-equipment">${esc(t('Approve'))}</button><button class="detail-button" type="button" id="reject-equipment">${esc(t('Reject'))}</button><p id="pending-error" class="form-error"></p></div>`;
  const review = selected ? reviewForm : `<p class="live-note">${esc(t('No new equipment'))}</p>`;
  const detail = ui.mode === 'create' ? equipmentForm() : `<aside class="panel detail pending-review"><h2>${esc(t('From reports'))}</h2><div class="detail-top"><div class="machine">⚙</div>${selected ? liveBadge('Pending') : ''}<h3>${esc(selected?.equipment_code || '—')}</h3></div>${review}</aside>`;
  document.getElementById('workspace').className = 'workspace';
  document.getElementById('workspace').innerHTML = `<section class="panel">${equipmentTabs()}${tableShell(['Code', 'Name', 'Plant', 'Line No.', 'Technician'], body, shown(rows.length, rows.length, 'new equipment'))}</section>${detail}`;
  bindRows();
  bindForm();
  const pendingPlant = document.getElementById('pending-plant');
  const pendingLine = document.getElementById('pending-line');
  const pendingSection = document.getElementById('pending-section');
  const fillPendingSections = () => {
    if (!pendingSection) return;
    pendingSection.innerHTML = sectionOptions(pendingLine?.value || '', selected?.section_id || '');
  };
  const fillPendingLines = () => {
    if (!pendingLine) return;
    const lines = store.lines.filter((line) => line.plant_id === pendingPlant.value);
    pendingLine.innerHTML = `<option value="">${esc(t('Select'))}</option>${lines.map((line) => `<option value="${esc(line.line_id)}"${line.line_id === selected?.line_id ? ' selected' : ''}>${esc(line.line_number ?? '')} — ${esc(line.name || '')}</option>`).join('')}`;
    fillPendingSections();
  };
  pendingPlant?.addEventListener('change', fillPendingLines);
  pendingLine?.addEventListener('change', fillPendingSections);
  fillPendingLines();
  document.getElementById('pending-review')?.addEventListener('submit', (event) => {
    event.preventDefault();
    decidePending(selected, 'approve');
  });
  document.getElementById('approve-equipment')?.addEventListener('click', () => decidePending(selected, 'approve'));
  document.getElementById('reject-equipment')?.addEventListener('click', () => decidePending(selected, 'reject'));
}

async function decidePending(row, decision) {
  const error = document.getElementById('pending-error');
  try {
    let path = `/pending-equipment/${row.id}/${decision}`;
    if (decision === 'approve') {
      const plant = document.getElementById('pending-plant')?.value || '';
      const line = document.getElementById('pending-line')?.value || '';
      const section = document.getElementById('pending-section')?.value || '';
      const criticality = document.getElementById('pending-criticality')?.value || '';
      const name = document.getElementById('pending-name')?.value.trim() || '';
      if (!name || !plant || !line || !criticality) {
        if (error) error.textContent = t(!criticality ? 'Choose the equipment importance' : 'Enter the name, plant, and line before approving this equipment.');
        return;
      }
      const params = new URLSearchParams({ plant_id: plant, line_id: line, name, criticality });
      if (section) params.set('section_id', section);
      path += `?${params}`;
    }
    await apiRequest(path, { method: 'POST' });
    store = null;
    ui.rowKey = '';
    toast(decision === 'approve' ? 'Equipment added to the plant register.' : 'Equipment was rejected.');
    ui.tab = 'From reports';
    await paint('equipment');
  } catch (err) {
    if (error) error.textContent = err.message || 'Could not update this equipment.';
  }
}

const LUBE_SHIFTS = ['Morning (07:00 - 15:00)', 'Evening (15:00 - 23:00)', 'Night (23:00 - 07:00)'];
let lubeCache = [];
let dailyCache = [];
let dailyPhotoItems = [];
let dailyPhotoToken = 0;
let dailyPhotoLoad = Promise.resolve();
let dailyPhotosEditable = false;
let dailyOpenTimer = 0;
const DAILY_TYPES = ['Preventive', 'Corrective', 'Emergency', 'Routine', 'Inspection'];

function lubeDayName(value) {
  const date = new Date(`${value}T00:00:00`);
  return WEEKDAYS[date.getDay()] || '';
}

function lubeTypeCell(line) {
  const types = ['Oil change', 'Grease change', 'Other'];
  const options = [`<option value="">${esc(t('Select'))}</option>`, ...types.map((type) => `<option value="${esc(type)}"${line.work_type === type ? ' selected' : ''}>${esc(t(type))}</option>`)];
  const order = line.work_order_id ? `<small class="lube-order">${esc(t('Work order'))} ${esc(line.work_order_id)}</small>` : '';
  return `<td class="lube-type"><select data-field="work_type">${options.join('')}</select>${order}</td>`;
}

function lubeRow(line = {}, index = 0) {
  const field = (name, value, placeholder) => `<input data-field="${name}" value="${esc(value || '')}" placeholder="${esc(t(placeholder))}">`;
  const plantId = line.plant_id || '';
  const lineId = line.line_id || '';
  const plants = `<select data-field="plant_id"><option value="">${esc(t('Select plant'))}</option>${openPlants(plantId).map((plant) => `<option value="${esc(plant.plant_id)}"${plant.plant_id === plantId ? ' selected' : ''}>${esc(plant.name)}</option>`).join('')}</select>`;
  const lines = `<select data-field="line_id">${lubeLineOptions(plantId, lineId)}</select>`;
  const qtyUnit = lubeQtyUnit(line.work_type);
  const qty = `<td class="lube-qty">${field('quantity', line.quantity, 'Qty')}<span class="lube-qty-unit" data-qty-unit>${esc(qtyUnit)}</span></td>`;
  return `<tr><td class="lube-no">${index + 1}</td><td class="lube-machine">${field('equipment_code', line.equipment_code, 'Equipment number')}${field('equipment_name', line.equipment_name, 'Equipment name')}${plants}${lines}</td>${lubeTypeCell(line)}<td>${field('component', line.component, 'Component')}</td>${qty}<td>${field('lubricant_name', line.lubricant_name, 'Oil or grease name')}</td><td>${field('notes', line.notes, 'Remarks')}</td></tr>`;
}

function lubeLinesFromForm() {
  return [...document.querySelectorAll('#lube-rows tr')].map((row) => ({
    equipment_code: row.querySelector('[data-field="equipment_code"]').value.trim(),
    equipment_name: row.querySelector('[data-field="equipment_name"]').value.trim(),
    plant_id: row.querySelector('[data-field="plant_id"]')?.value || null,
    line_id: row.querySelector('[data-field="line_id"]')?.value || null,
    component: row.querySelector('[data-field="component"]').value.trim(),
    quantity: row.querySelector('[data-field="quantity"]').value.trim(),
    lubricant_name: row.querySelector('[data-field="lubricant_name"]').value.trim(),
    notes: row.querySelector('[data-field="notes"]').value.trim(),
    work_type: row.querySelector('[data-field="work_type"]').value,
  })).filter((line) => [line.equipment_code, line.equipment_name, line.plant_id, line.line_id, line.component, line.quantity, line.lubricant_name, line.notes, line.work_type].some(Boolean));
}

async function saveLubrication() {
  const form = document.getElementById('lube-form');
  if (!form) return;
  clearReportAlert('lube');
  const technicianId = isTechnician() ? (getSavedUser()?.technician_id || '') : form.querySelector('#lube-tech').value;
  try {
    const saved = await apiRequest('/lubrication-reports', {
      method: 'PUT',
      body: JSON.stringify({
        report_date: form.querySelector('#lube-date').value,
        shift: form.querySelector('#lube-shift').value,
        technician_id: technicianId,
        lines: lubeLinesFromForm(),
      }),
    });
    ui.lubeId = saved.report_id;
    if (isLubricationTechnician()) screenNotice(t('The report was sent to the maintenance engineer.'));
    else toast(t(saved.new_equipment?.length ? 'The equipment was sent to the maintenance engineer for approval.' : 'The lubrication report was saved.'));
    await drawLubrication();
  } catch (exception) {
    showReportAlert(exception.message, 'lube');
  }
}

async function drawLubrication() {
  const viewer = getSavedUser()?.role === 'ADMINISTRATOR_VIEWER';
  lubeCache = await apiRequest('/lubrication-reports');
  const today = isoDate(new Date());
  let current = null;
  if (ui.lubeId && ui.lubeId !== 'new') {
    current = await apiRequest(`/lubrication-reports/${encodeURIComponent(ui.lubeId)}`);
  } else if (!ui.lubeId) {
    const user = getSavedUser();
    const mine = lubeCache.find((row) => row.report_date === today && (!isTechnician() || row.technician_id === user?.technician_id));
    if (mine && isTechnician()) current = await apiRequest(`/lubrication-reports/${encodeURIComponent(mine.report_id)}`);
  }
  const reportDate = current?.report_date || today;
  const lines = current?.lines?.length ? current.lines : [];
  while (lines.length < 10) lines.push({});
  const monthKey = today.slice(0, 7);
  const monthCount = lubeCache.filter((row) => String(row.report_date).startsWith(monthKey)).length;
  document.getElementById('metric-grid').innerHTML = metrics([
    ['Reports', String(lubeCache.length), '▣', 'blue', ''],
    ['Lines recorded', String(lubeCache.reduce((total, row) => total + (Number(row.line_count) || 0), 0)), '▤', 'green', ''],
    ['This month', String(monthCount), '◷', 'orange', ''],
  ]);
  const techField = isTechnician()
    ? `<input id="lube-tech-name" value="${esc(current?.technician_name || getSavedUser()?.full_name || '')}" readonly>`
    : `<select id="lube-tech">${store.technicians.map((item) => `<option value="${esc(item.technician_id)}"${item.technician_id === current?.technician_id ? ' selected' : ''}>${esc(item.name)}</option>`).join('')}</select>`;
  const list = lubeCache.map((row) => `<button type="button" class="lube-open${current?.report_id === row.report_id ? ' selected' : ''}" data-lube="${esc(row.report_id)}"><b>${esc(fmtDate(row.report_date))}</b><small>${esc(row.technician_name)} · ${esc(t(row.shift))} · ${row.line_count}</small></button>`).join('') || `<p class="live-note">${esc(t('No lubrication reports yet.'))}</p>`;
  document.getElementById('workspace').className = 'workspace lube-board';
  document.getElementById('workspace').innerHTML = `<aside class="panel lube-list"><div class="lube-list-head"><b>${esc(t('Reports'))}</b><button type="button" class="detail-button" id="lube-new">${esc(t('New report'))}</button></div>${list}</aside><form id="lube-form" class="lube-paper lube-sheet"><div id="lube-alert" class="report-alert no-print" hidden role="alert"></div><header class="lube-head"><img src="logo-rayan.png?v=3" alt="Rayan"><div><h2>${esc(t('Daily report for the lubrication technician'))}</h2><p>${esc(t('Oil and grease change log'))}</p><small>${esc(t('Mechanical Maintenance Department'))}</small></div><dl><div><dt>${esc(t('Form No.:'))}</dt><dd>${esc(formNo('lubrication'))}</dd></div><div><dt>${esc(t('Report No.'))}</dt><dd>${esc(current?.report_id || t('New'))}</dd></div></dl></header><div class="lube-meta"><label><span>${esc(t('Shift'))}</span><select id="lube-shift">${LUBE_SHIFTS.map((shift) => `<option value="${esc(shift)}"${shift === (current?.shift || LUBE_SHIFTS[0]) ? ' selected' : ''}>${esc(t(shift))}</option>`).join('')}</select></label><label><span>${esc(t("Technician's name"))}</span>${techField}</label><label><span>${esc(t('Day'))}</span><input id="lube-day" value="${esc(t(current?.day_name || lubeDayName(reportDate)))}" readonly></label><label><span>${esc(t('Date'))}</span><input id="lube-date" type="date" value="${esc(reportDate)}" required></label></div><table class="lube-table"><thead><tr><th>${esc(t('Seq.'))}</th><th>${esc(t('Machine'))}</th><th>${esc(t('Work type'))}</th><th>${esc(t('Component'))}</th><th>${esc(t('Qty'))}</th><th>${esc(t('Oil or grease name'))}</th><th>${esc(t('Remarks'))}</th></tr></thead><tbody id="lube-rows">${lines.map(lubeRow).join('')}</tbody></table><div class="lube-foot"><span>PMF 17-05 rev.a</span><span>${esc(t('Mechanical Maintenance Department'))}</span></div><p class="lube-help no-print">${esc(t('An equipment number that is not registered is sent to the maintenance engineer for approval.'))}</p><div class="lube-actions lube-form-actions no-print"><button type="button" id="lube-add">${esc(t('Add row'))}</button>${viewer ? '' : `<button type="submit" id="lube-save" class="detail-button primary">${esc(t(isLubricationTechnician() ? 'Send report' : 'Save report'))}</button>`}<button type="button" id="lube-print">${esc(t('Print'))}</button>${current && canMaintain() ? `<button type="button" class="detail-button danger" data-delete="/lubrication-reports" data-delete-id="${esc(current.report_id)}">${esc(t('Delete'))}</button>` : ''}</div></form>`;
  if (viewer) document.querySelectorAll('#lube-form input, #lube-form select, #lube-add').forEach((node) => { node.disabled = true; });
  document.querySelectorAll('#lube-rows tr').forEach(bindLubeRow);
  document.getElementById('lube-date')?.addEventListener('change', (event) => {
    document.getElementById('lube-day').value = t(lubeDayName(event.target.value));
    const technicianId = isTechnician() ? getSavedUser()?.technician_id : document.getElementById('lube-tech')?.value;
    const found = lubeCache.find((row) => row.report_date === event.target.value && row.technician_id === technicianId);
    if (found) {
      ui.lubeId = found.report_id;
      drawLubrication();
    }
  });
  document.getElementById('lube-new')?.addEventListener('click', () => { ui.lubeId = 'new'; drawLubrication(); });
  document.querySelectorAll('[data-lube]').forEach((button) => button.addEventListener('click', () => { ui.lubeId = button.dataset.lube; drawLubrication(); }));
  document.getElementById('lube-add')?.addEventListener('click', () => {
    const body = document.getElementById('lube-rows');
    body.insertAdjacentHTML('beforeend', lubeRow({}, body.children.length));
    bindLubeRow(body.lastElementChild);
  });
  document.getElementById('lube-print')?.addEventListener('click', () => window.print());
  bindDeletes();
  document.getElementById('lube-form')?.addEventListener('submit', (event) => { event.preventDefault(); saveLubrication(); });
}

function dailyHours(start, end) {
  if (!start || !end) return '';
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  if ([sh, sm, eh, em].some((part) => Number.isNaN(part))) return '';
  let minutes = (eh * 60 + em) - (sh * 60 + sm);
  if (minutes < 0) minutes += 24 * 60;
  return (minutes / 60).toFixed(2);
}

function dailyPartsText(parts) {
  const rows = parts.filter((part) => part.description || part.number || part.quantity);
  return rows.length
    ? rows.map((part) => `${part.description || 'Part'} | No: ${part.number || '—'} | Qty: ${part.quantity || '—'}`).join('\n')
    : null;
}

function dailyPartsFromText(text) {
  const rows = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = line.match(/^(.*?) \| No: (.*?) \| Qty: (.*?)(?: \| .*)?$/);
    if (!match) return { description: line, number: '', quantity: '' };
    return {
      description: match[1] === 'Part' ? '' : match[1],
      number: match[2] === '—' ? '' : match[2],
      quantity: match[3] === '—' ? '' : match[3],
    };
  });
  while (rows.length < 2) rows.push({ description: '', number: '', quantity: '' });
  return rows;
}

function dailyPartRow(part, index) {
  return `<tr><td class="lube-no">${index + 1}</td><td><input data-part="description" list="spare-part-names" value="${esc(part.description || '')}" placeholder="${esc(t('Part'))}"></td><td><input data-part="number" list="spare-part-numbers" value="${esc(part.number || '')}" placeholder="${esc(t('Part No.'))}"></td><td><input data-part="quantity" value="${esc(part.quantity || '')}" placeholder="${esc(t('Qty'))}"></td></tr>`;
}

let spareCatalog = [];

function spareDataLists() {
  const numbers = (spareCatalog || []).map((part) => `<option value="${esc(part.part_number)}">${esc(part.name)}</option>`).join('');
  const names = (spareCatalog || []).map((part) => `<option value="${esc(part.name)}">${esc(part.part_number)}</option>`).join('');
  return `<datalist id="spare-part-numbers">${numbers}</datalist><datalist id="spare-part-names">${names}</datalist>`;
}

function dailyPartsFromForm() {
  return [...document.querySelectorAll('#daily-parts tr')].map((row) => ({
    description: row.querySelector('[data-part="description"]').value.trim(),
    number: row.querySelector('[data-part="number"]').value.trim(),
    quantity: row.querySelector('[data-part="quantity"]').value.trim(),
  }));
}

function reportSentAt(row) {
  const raw = row?.submitted_at;
  if (!raw) return null;
  const text = String(raw);
  const stamp = new Date(/Z|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`).getTime();
  return Number.isNaN(stamp) ? null : stamp;
}

const REPORT_GAP_MS = 10 * 60 * 60 * 1000;
let sendWatchTimer = 0;

function remainText(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

function startSendWatch(opens) {
  window.clearInterval(sendWatchTimer);
  const tick = () => {
    const node = document.getElementById('send-watch-time');
    if (!node) {
      window.clearInterval(sendWatchTimer);
      return;
    }
    const left = opens - Date.now();
    if (left <= 0) {
      window.clearInterval(sendWatchTimer);
      if (ui.page === 'daily-reports') drawDailyReport();
      return;
    }
    node.textContent = remainText(left);
  };
  tick();
  sendWatchTimer = window.setInterval(tick, 1000);
}

function dailySendLock(rows) {
  const sent = rows
    .map((row) => ({ row, at: reportSentAt(row) }))
    .filter((item) => item.at && ['Submitted', 'Approved'].includes(item.row.status))
    .sort((a, b) => b.at - a.at)[0];
  if (!sent) return null;
  const opens = sent.at + REPORT_GAP_MS;
  if (Date.now() >= opens) return null;
  return { reportId: sent.row.report_id, status: sent.row.status, opens };
}

function openReportDate() {
  return isoDate(new Date());
}

function fmtStamp(value) {
  if (!value) return '—';
  const text = String(value);
  const stamp = new Date(/Z|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
  if (Number.isNaN(stamp.getTime())) return '—';
  return stamp.toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
}

function rejectedFieldHtml(rows, openId) {
  const rejected = rows.filter((row) => row.status === 'Returned');
  if (!rejected.length) return '';
  const items = rejected.map((row) => {
    const selected = openId === row.report_id;
    const detail = selected ? `<div class="daily-rejected-detail"><div><span>${esc(t('Submitted to the engineer'))}</span><p>${esc(fmtStamp(row.submitted_at))}</p></div><div><span>${esc(t('Rejected by the engineer'))}</span><p>${esc(fmtStamp(row.returned_at))}</p></div><div><span>${esc(t('Rejection reason'))}</span><p>${esc(row.return_reason || t('No reason was entered.'))}</p></div></div>` : '';
    return `<button type="button" class="daily-rejected-item${selected ? ' selected' : ''}" data-daily="${esc(row.report_id)}"><b>${esc(row.report_id)}</b><small>${esc(fmtDate(String(row.report_date).slice(0, 10)))}</small></button>${detail}`;
  }).join('');
  return `<section class="daily-rejected no-print"><h3>${esc(t('Rejected reports'))}</h3>${items}</section>`;
}

function dailyListHtml(rows, openId, techName) {
  return rows.map((row) => {
    const day = String(row.report_date).slice(0, 10);
    const who = store.technicians.find((item) => item.technician_id === row.technician_id)?.name || techName;
    return `<button type="button" class="lube-open${openId === row.report_id ? ' selected' : ''}" data-daily="${esc(row.report_id)}"><b>${esc(fmtDate(day))}</b><small>${esc(who)} · ${esc(t(row.status || 'Draft'))}</small></button>`;
  }).join('') || `<p class="live-note">${esc(t(ui.dailyFilter ? 'No reports on this date.' : 'No daily reports yet.'))}</p>`;
}

function refreshDailyTotal() {
  const total = [...document.querySelectorAll('#daily-rows [data-field="downtime"]')].reduce((sum, input) => sum + (Number(input.value) || 0), 0);
  const node = document.getElementById('daily-total');
  if (node) node.textContent = total.toFixed(2);
}

function dailyPlantLines(plantId = '') {
  if (!plantId || !store?.lines) return [];
  return store.lines.filter((line) => line.plant_id === plantId);
}

function applyDailyLine(row, number) {
  const input = row.querySelector('[data-field="line"]');
  if (!input) return;
  const value = String(number ?? '').trim();
  const plantId = row.querySelector('[data-field="plant"]')?.value || '';
  const lines = dailyPlantLines(plantId);
  const exact = lines.filter((line) => String(line.line_number) === value);
  const longer = lines.some((line) => {
    const text = String(line.line_number);
    return text !== value && text.startsWith(value);
  });
  const named = exact.length === 1 && !longer && exact[0].name ? exact[0] : null;
  row.dataset.lineNumber = value;
  row.dataset.lineId = exact.length === 1 ? (exact[0].line_id || '') : '';
  if (named) {
    input.value = named.name;
    input.dataset.resolved = '1';
    if (!plantId && named.plant_id) {
      const plant = row.querySelector('[data-field="plant"]');
      if (plant) plant.value = named.plant_id;
    }
    return;
  }
  input.dataset.resolved = '';
  if (input.value !== value) input.value = value;
}

function showDailyLineName(row) {
  const input = row.querySelector('[data-field="line"]');
  if (!input) return;
  const number = input.dataset.resolved === '1' ? (row.dataset.lineNumber || '') : input.value.trim();
  applyDailyLine(row, number);
}

function dailyRow(item = {}, index = 0) {
  const options = [`<option value="">${esc(t('Select'))}</option>`, ...DAILY_TYPES.map((type) => `<option value="${esc(type)}"${item.maintenance_type === type ? ' selected' : ''}>${esc(t(type))}</option>`)];
  const order = item.wo_id ? `<small class="lube-order">${esc(item.wo_id)}</small>` : '';
  const plantId = item.plant_id || '';
  const line = store.lines.find((row) => row.line_id === item.line_id)
    || store.lines.find((row) => String(row.line_number) === String(item.entered_line_number || '') && (!plantId || row.plant_id === plantId));
  const lineNumber = item.entered_line_number || (line?.line_number ?? '');
  const lineLabel = line?.name || lineNumber;
  const start = item.maintenance_start ? String(item.maintenance_start).slice(0, 5) : '';
  const end = item.maintenance_end ? String(item.maintenance_end).slice(0, 5) : '';
  const rowPlant = plantId || line?.plant_id || '';
  const plants = `<select data-field="plant"><option value="">${esc(t('Select plant'))}</option>${openPlants(rowPlant).map((plant) => `<option value="${esc(plant.plant_id)}"${plant.plant_id === rowPlant ? ' selected' : ''}>${esc(plant.name)}</option>`).join('')}</select>`;
  return `<tr data-wo="${esc(item.wo_id || '')}" data-line-number="${esc(lineNumber)}" data-line-id="${esc(line?.line_id || '')}"><td class="lube-no">${index + 1}</td><td class="lube-machine"><input data-field="code" placeholder="${esc(t('Equipment number'))}" value="${esc(item.equipment_code || item.equipment_id || '')}"><input data-field="name" placeholder="${esc(t('Equipment name'))}" value="${esc(item.equipment_name || '')}">${plants}<input data-field="line" data-resolved="${line?.name ? '1' : ''}" placeholder="${esc(t('Line'))}" value="${esc(lineLabel)}"></td><td class="lube-type"><select data-field="type">${options.join('')}</select>${order}</td><td class="daily-work"><input data-field="failure" placeholder="${esc(t('Failure Reason'))}" value="${esc(item.failure_reason || '')}"><input data-field="action" placeholder="${esc(t('Repair Actions'))}" value="${esc(item.action_taken || '')}"></td><td><input data-field="start" type="time" value="${esc(start)}"></td><td><input data-field="end" type="time" value="${esc(end)}"></td><td><input data-field="downtime" value="${item.downtime_h != null && item.downtime_h !== '' ? Number(item.downtime_h).toFixed(2) : ''}" readonly></td></tr>`;
}

function dailyItemsFromForm() {
  const items = [];
  document.querySelectorAll('#daily-rows tr').forEach((row) => {
    const get = (field) => row.querySelector(`[data-field="${field}"]`)?.value.trim() || '';
    const code = get('code');
    const name = get('name');
    const touched = [code, name, get('type'), get('failure'), get('action'), get('start'), get('end'), get('plant')].some(Boolean);
    if (!touched) return;
    if (!code || !name || !get('type')) throw new Error('Each activity needs an equipment number, a name, and a maintenance type.');
    const known = equipmentByCode(code);
    const plantId = get('plant') || known?.plant_id || '';
    if (!plantId) throw new Error('Each activity needs a plant.');
    const start = get('start') || null;
    const end = get('end') || null;
    const lineNumber = row.dataset.lineNumber || get('line');
    const line = store.lines.find((item) => item.plant_id === plantId && String(item.line_number) === String(lineNumber));
    items.push({
      equipment_id: known ? known.equipment_id : code,
      equipment_code: code,
      equipment_name: name,
      plant_id: plantId,
      line_id: line?.line_id || null,
      entered_line_number: lineNumber || null,
      is_manual_entry: !known,
      maintenance_type: get('type'),
      maintenance_start: start,
      maintenance_end: end,
      downtime_start: start,
      downtime_end: end,
      downtime_h: get('downtime') ? Number(get('downtime')) : null,
      failure_reason: get('failure') || null,
      action_taken: get('action') || null,
      wo_id: row.dataset.wo || null,
      spare_parts: dailyPartsText(dailyPartsFromForm()),
      maintenance_completed: true,
    });
  });
  if (!items.length) throw new Error('Enter at least one maintenance activity.');
  return items;
}

function fillKnownEquipmentRow(row) {
  const code = row.querySelector('[data-field="code"]');
  const name = row.querySelector('[data-field="name"]');
  const line = row.querySelector('[data-field="line"]');
  if (!code || !name) return;
  const found = matchEquipment(code.value) || matchEquipment(name.value);
  if (!found) return;
  if (!code.value) code.value = found.equipment_id || '';
  if (!name.value) name.value = found.name || '';
  if (found.plant_id) {
    const plant = row.querySelector('[data-field="plant"]');
    if (plant) plant.value = found.plant_id;
  }
  const lineNumber = equipmentLineNumber(found);
  if (line && lineNumber && !row.dataset.lineNumber && !line.value) {
    line.dataset.resolved = '';
    line.value = lineNumber;
  }
  showDailyLineName(row);
}

function syncDailyOrder(row) {
  const type = row.querySelector('[data-field="type"]')?.value || '';
  if (type === 'Corrective' || type === 'Emergency') return;
  row.dataset.wo = '';
  row.querySelector('.lube-order')?.remove();
}

function bindDailyRow(row) {
  const code = row.querySelector('[data-field="code"]');
  const name = row.querySelector('[data-field="name"]');
  if (code && name) bindEquipmentCode(code, name);
  fillKnownEquipmentRow(row);
  row.querySelector('[data-field="plant"]')?.addEventListener('change', () => showDailyLineName(row));
  const lineInput = row.querySelector('[data-field="line"]');
  lineInput?.addEventListener('beforeinput', (event) => {
    if (lineInput.dataset.resolved !== '1' || !row.dataset.lineNumber) return;
    if (event.inputType === 'insertText') {
      event.preventDefault();
      lineInput.dataset.resolved = '';
      applyDailyLine(row, `${row.dataset.lineNumber}${event.data || ''}`);
    } else if (event.inputType === 'deleteContentBackward' || event.inputType === 'deleteContentForward') {
      event.preventDefault();
      lineInput.dataset.resolved = '';
      applyDailyLine(row, String(row.dataset.lineNumber).slice(0, -1));
    }
  });
  lineInput?.addEventListener('input', () => {
    lineInput.dataset.resolved = '';
    applyDailyLine(row, lineInput.value.trim());
  });
  showDailyLineName(row);
  row.querySelector('[data-field="type"]')?.addEventListener('change', () => syncDailyOrder(row));
}

function readPhotoSize(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => resolve({ url, width: image.naturalWidth || 1, height: image.naturalHeight || 1 });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('The photo could not be read.'));
    };
    image.src = url;
  });
}

function canvasJpeg(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

async function compressReportPhoto(file) {
  const source = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const node = new Image();
      node.onload = () => resolve(node);
      node.onerror = () => reject(new Error('The photo could not be read.'));
      node.src = source;
    });
    const maxSide = 2480;
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight, 1));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    let blob = await canvasJpeg(canvas, 0.82);
    if (blob && blob.size > 2400000) blob = await canvasJpeg(canvas, 0.6);
    if (blob && blob.size > 2400000) blob = await canvasJpeg(canvas, 0.45);
    if (!blob) throw new Error('The photo could not be read.');
    return { blob, width, height, url: URL.createObjectURL(blob) };
  } finally {
    URL.revokeObjectURL(source);
  }
}

function paintDailyPhotos() {
  const strip = document.getElementById('daily-photo-strip');
  const printBox = document.getElementById('daily-photo-print');
  const add = document.getElementById('daily-add-photo');
  if (!strip || !printBox) return;
  if (add) add.hidden = !dailyPhotosEditable;
  strip.innerHTML = dailyPhotoItems.length
    ? dailyPhotoItems.map((photo, index) => `<figure><img src="${photo.url}" alt="">${dailyPhotosEditable ? `<button type="button" data-photo-remove="${index}" aria-label="${esc(t('Remove photo'))}">×</button>` : ''}</figure>`).join('')
    : `<p class="photo-hint">${esc(t('No photos attached.'))}</p>`;
  printBox.innerHTML = dailyPhotoItems.map((photo) => `<section class="report-photo-page${photo.width > photo.height ? ' landscape' : ''}"><img src="${photo.url}" alt=""></section>`).join('');
  strip.querySelectorAll('[data-photo-remove]').forEach((button) => {
    button.addEventListener('click', () => removeDailyPhoto(Number(button.dataset.photoRemove)));
  });
}

async function fetchDailyPhotos(token, reportId, photos) {
  const loaded = [];
  try {
    for (const photo of photos || []) {
      const blob = await apiRequest(`/daily-reports/${encodeURIComponent(reportId)}/photos/${photo.id}`, { blob: true });
      if (token !== dailyPhotoToken) {
        loaded.forEach((item) => URL.revokeObjectURL(item.url));
        return;
      }
      const sized = await readPhotoSize(blob);
      if (token !== dailyPhotoToken) {
        URL.revokeObjectURL(sized.url);
        loaded.forEach((item) => URL.revokeObjectURL(item.url));
        return;
      }
      loaded.push({ id: photo.id, blob: null, url: sized.url, width: sized.width, height: sized.height });
    }
  } catch (exception) {
    loaded.forEach((photo) => URL.revokeObjectURL(photo.url));
    if (token === dailyPhotoToken) showReportAlert(exception.message);
    return;
  }
  if (token !== dailyPhotoToken) {
    loaded.forEach((photo) => URL.revokeObjectURL(photo.url));
    return;
  }
  const pending = dailyPhotoItems.filter((photo) => !photo.id);
  dailyPhotoItems = loaded.concat(pending);
  paintDailyPhotos();
}

function startDailyPhotos(reportId, photos) {
  dailyPhotoToken += 1;
  const token = dailyPhotoToken;
  dailyPhotoItems.forEach((photo) => URL.revokeObjectURL(photo.url));
  dailyPhotoItems = [];
  paintDailyPhotos();
  dailyPhotoLoad = reportId ? fetchDailyPhotos(token, reportId, photos) : Promise.resolve();
}

async function uploadPendingPhotos(reportId) {
  for (const photo of dailyPhotoItems) {
    if (photo.id || !photo.blob) continue;
    const body = new FormData();
    body.append('file', photo.blob, 'report-photo.jpg');
    const saved = await apiRequest(`/daily-reports/${encodeURIComponent(reportId)}/photos`, { method: 'POST', body });
    photo.id = saved.id;
    photo.blob = null;
  }
}

async function removeDailyPhoto(index) {
  const photo = dailyPhotoItems[index];
  if (!photo || !dailyPhotosEditable) return;
  const reportId = document.getElementById('daily-form')?.dataset.reportId || '';
  try {
    if (photo.id && reportId) {
      await apiRequest(`/daily-reports/${encodeURIComponent(reportId)}/photos/${photo.id}`, { method: 'DELETE' });
    }
    URL.revokeObjectURL(photo.url);
    dailyPhotoItems.splice(index, 1);
    paintDailyPhotos();
  } catch (exception) {
    showReportAlert(exception.message);
  }
}

async function addDailyPhotos(files) {
  clearReportAlert();
  await dailyPhotoLoad;
  for (const file of files) {
    if (!dailyPhotosEditable) return;
    if (dailyPhotoItems.length >= 12) {
      showReportAlert('A report can hold 12 photos.');
      break;
    }
    if (file.type && !file.type.startsWith('image/')) {
      showReportAlert('Choose an image file.');
      continue;
    }
    const photo = await compressReportPhoto(file);
    if (photo.blob.size > 2500000) {
      URL.revokeObjectURL(photo.url);
      showReportAlert('Each photo must be smaller than 2.5 MB.');
      continue;
    }
    const reportId = document.getElementById('daily-form')?.dataset.reportId || '';
    if (reportId) {
      const body = new FormData();
      body.append('file', photo.blob, 'report-photo.jpg');
      try {
        const saved = await apiRequest(`/daily-reports/${encodeURIComponent(reportId)}/photos`, { method: 'POST', body });
        photo.id = saved.id;
        photo.blob = null;
      } catch (exception) {
        URL.revokeObjectURL(photo.url);
        throw exception;
      }
    }
    dailyPhotoItems.push(photo);
    paintDailyPhotos();
  }
}

async function saveDailyReport(submit) {
  const form = document.getElementById('daily-form');
  if (!form) return;
  clearReportAlert();
  const reportId = form.dataset.reportId || '';
  const status = form.dataset.status || 'Draft';
  const sendLock = isTechnician() ? dailySendLock(dailyCache) : null;
  if (submit && sendLock && reportId !== sendLock.reportId) {
    showReportAlert('A new report can be sent 10 hours after the last one.');
    return;
  }
  if (reportId && status !== 'Draft' && status !== 'Returned') {
    showReportAlert('This report can no longer be edited.');
    return;
  }
  try {
    const items = dailyItemsFromForm();
    const itemPlants = [...new Set(items.map((item) => item.plant_id).filter(Boolean))];
    const payload = {
      report_date: form.querySelector('#daily-date').value,
      plant_id: itemPlants.length === 1 ? itemPlants[0] : null,
      shift: form.querySelector('#daily-shift').value,
      general_notes: form.querySelector('#daily-notes').value.trim() || null,
      items,
    };
    if (!payload.report_date) throw new Error('Report date is required.');
    const response = reportId
      ? await apiRequest(`/daily-reports/${encodeURIComponent(reportId)}`, { method: 'PUT', body: JSON.stringify(payload) })
      : await apiRequest('/daily-reports', { method: 'POST', body: JSON.stringify(payload) });
    const savedId = response.report.report_id;
    form.dataset.reportId = savedId;
    ui.dailyId = savedId;
    await dailyPhotoLoad;
    await uploadPendingPhotos(savedId);
    if (submit) await apiRequest(`/daily-reports/${encodeURIComponent(savedId)}/submit`, { method: 'POST' });
    ui.dailyId = submit ? 'new' : savedId;
    if (submit) screenNotice(t('The report was sent to the maintenance engineer.'));
    else toast(t('Draft saved.'));
    await drawDailyReport();
  } catch (exception) {
    const existing = String(exception.message || '').match(/Daily Report already exists for this technician\/date: (\S+)/);
    if (existing && !reportId) {
      ui.dailyId = existing[1];
      toast(t('A report already exists for this date.'));
      await drawDailyReport();
      return;
    }
    showReportAlert(exception.message);
  }
}

async function drawDailyReport() {
  dailyCache = await apiRequest('/daily-reports');
  try {
    spareCatalog = await apiRequest('/spare-parts/catalog');
  } catch (_) {
    spareCatalog = [];
  }
  const missingReason = dailyCache.filter((row) => row.status === 'Returned' && (row.return_reason == null || row.returned_at == null));
  await Promise.all(missingReason.map(async (row) => {
    const detail = await apiRequest(`/daily-reports/${encodeURIComponent(row.report_id)}`);
    const source = detail.report || {};
    row.return_reason = source.return_reason || row.return_reason || '';
    row.returned_at = source.returned_at || row.returned_at || '';
    row.submitted_at = row.submitted_at || source.submitted_at || '';
  }));
  const today = isoDate(new Date());
  const windowLock = isTechnician() ? dailySendLock(dailyCache) : null;
  window.clearTimeout(dailyOpenTimer);
  window.clearInterval(sendWatchTimer);
  let detail = null;
  if (ui.dailyId && ui.dailyId !== 'new') {
    detail = await apiRequest(`/daily-reports/${encodeURIComponent(ui.dailyId)}`);
  } else if (!ui.dailyId) {
    const mine = dailyCache.find((row) => String(row.report_date).slice(0, 10) === today && row.status === 'Draft');
    if (mine) detail = await apiRequest(`/daily-reports/${encodeURIComponent(mine.report_id)}`);
  }
  const report = detail?.report || null;
  const items = detail?.items?.length ? detail.items.slice() : [];
  const parts = dailyPartsFromText(items.find((item) => item.spare_parts)?.spare_parts || '');
  while (items.length < 10) items.push({});
  const monthKey = today.slice(0, 7);
  const monthCount = dailyCache.filter((row) => String(row.report_date).startsWith(monthKey)).length;
  const approved = dailyCache.filter((row) => row.status === 'Approved').length;
  document.getElementById('metric-grid').innerHTML = metrics([
    ['Reports', String(dailyCache.length), '▣', 'blue', ''],
    ['Approved', String(approved), '✓', 'green', ''],
    ['This month', String(monthCount), '◷', 'orange', ''],
  ]);
  const locked = Boolean(report && !['Draft', 'Returned'].includes(report.status));
  const returned = report?.status === 'Returned';
  const draftButton = document.getElementById('draft-action');
  const sendButton = document.getElementById('primary-action');
  if (draftButton) draftButton.hidden = locked || returned;
  if (sendButton) {
    sendButton.hidden = locked || returned || Boolean(windowLock);
    if (!sendButton.hidden) sendButton.textContent = t('Send report');
  }
  const reportDate = String(report?.report_date || openReportDate(dailyCache)).slice(0, 10);
  const techName = report?.technician_name || getSavedUser()?.full_name || '';
  const visibleReports = () => (ui.dailyFilter
    ? dailyCache.filter((row) => String(row.report_date).slice(0, 10) === ui.dailyFilter)
    : dailyCache);
  const list = dailyListHtml(visibleReports(), report?.report_id || '', techName);
  const workspace = document.getElementById('workspace');
  workspace.className = 'workspace lube-board';
  workspace.innerHTML = `<aside class="panel lube-list"><div class="lube-list-head"><b>${esc(t('Reports'))}</b><button type="button" class="detail-button" id="daily-new">${esc(t('New report'))}</button></div><label class="daily-filter"><span>${esc(t('Date'))}</span><input id="daily-filter" type="date" value="${esc(ui.dailyFilter || '')}"></label>${rejectedFieldHtml(dailyCache, report?.report_id || '')}<div id="daily-report-list">${list}</div></aside><form id="daily-form" class="lube-paper daily-paper" data-report-id="${esc(report?.report_id || '')}" data-status="${esc(report?.status || 'Draft')}">${windowLock ? `<div class="send-watch no-print" id="send-watch"><span>${esc(t('Time left before the next report'))}</span><b id="send-watch-time">00:00:00</b></div>` : ''}<div id="daily-alert" class="report-alert no-print" hidden role="alert"></div><header class="lube-head"><img src="logo-rayan.png?v=3" alt="Rayan"><div><h2>${esc(t('DAILY MAINTENANCE REPORT'))}</h2><p>${esc(t(report?.status || 'Draft report'))}</p><small>${esc(t('Mechanical Maintenance Department'))}</small></div><dl><div><dt>${esc(t('Form No.:'))}</dt><dd class="form-no">${esc(formNo('daily'))}</dd></div><div><dt>${esc(t('Approved by'))}</dt><dd class="approved-name">${esc(report?.approved_by || '—')}</dd></div></dl></header><div class="lube-meta"><label><span>${esc(t('Shift'))}</span><select id="daily-shift">${LUBE_SHIFTS.map((shift) => `<option value="${esc(shift)}"${shift === (report?.shift || LUBE_SHIFTS[0]) ? ' selected' : ''}>${esc(t(shift))}</option>`).join('')}</select></label><label><span>${esc(t("Technician's name"))}</span><input id="daily-tech" value="${esc(techName)}" readonly></label><label><span>${esc(t('Date'))}</span><input id="daily-date" type="date" value="${esc(reportDate)}" required></label></div><div class="sheet-scroll"><table class="lube-table"><thead><tr><th>${esc(t('Seq.'))}</th><th>${esc(t('Machine'))}</th><th>${esc(t('Maintenance Type'))}</th><th>${esc(t('Repair Actions'))}</th><th>${esc(t('Start Time'))}</th><th>${esc(t('End Time'))}</th><th>${esc(t('Downtime (hrs)'))}</th></tr></thead><tbody id="daily-rows">${items.map(dailyRow).join('')}</tbody></table></div><section class="daily-parts"><div class="lube-list-head"><h3>${esc(t('SPARE PARTS USED'))}</h3><button type="button" class="no-print" id="daily-add-part">${esc(t('Add part'))}</button></div><div class="sheet-scroll"><table class="lube-table"><thead><tr><th>${esc(t('No.'))}</th><th>${esc(t('Part'))}</th><th>${esc(t('Part No.'))}</th><th>${esc(t('Qty'))}</th></tr></thead><tbody id="daily-parts">${parts.map(dailyPartRow).join('')}</tbody></table></div></section><label class="daily-notes"><span>${esc(t('GENERAL NOTES'))}</span><div class="daily-note-box"><textarea id="daily-notes">${esc(report?.general_notes || '')}</textarea><b class="daily-tdt">TDT: <span id="daily-total">0.00</span></b></div></label><section class="daily-photos no-print"><div class="lube-list-head"><h3>${esc(t('Photos'))}</h3><button type="button" id="daily-add-photo">${esc(t('Add photo'))}</button></div><p class="photo-hint">${esc(t('Each photo prints on a full A3 page.'))}</p><div class="photo-strip" id="daily-photo-strip"></div><input id="daily-photo-file" type="file" accept="image/*" multiple hidden></section><div class="lube-actions no-print"><button type="button" id="daily-add">${esc(t('Add row'))}</button>${returned && !windowLock ? `<button type="button" id="daily-resend">${esc(t('Resend the report'))}</button>` : ''}<button type="button" id="daily-print">${esc(t('Print'))}</button></div></form><div id="daily-photo-print"></div>`;
  workspace.insertAdjacentHTML('beforeend', spareDataLists());
  if (windowLock) startSendWatch(windowLock.opens);
  dailyPhotosEditable = !locked;
  startDailyPhotos(report?.report_id || '', detail?.photos || []);
  if (locked) document.querySelectorAll('#daily-form input, #daily-form select, #daily-form textarea, #daily-add, #daily-add-part, #daily-add-photo').forEach((node) => { node.disabled = true; });
  if (returned) {
    ['daily-shift', 'daily-date', 'daily-notes'].forEach((id) => {
      const node = document.getElementById(id);
      if (node) node.disabled = true;
    });
    document.querySelectorAll('#daily-parts input, #daily-add-part').forEach((node) => { node.disabled = true; });
  }
  document.querySelectorAll('#daily-rows tr').forEach(bindDailyRow);
  document.getElementById('daily-rows')?.addEventListener('input', (event) => {
    const row = event.target.closest('tr');
    if (!row || (event.target.dataset.field !== 'start' && event.target.dataset.field !== 'end')) return;
    row.querySelector('[data-field="downtime"]').value = dailyHours(row.querySelector('[data-field="start"]').value, row.querySelector('[data-field="end"]').value);
    refreshDailyTotal();
  });
  refreshDailyTotal();
  document.getElementById('daily-date')?.addEventListener('change', (event) => {
    const found = dailyCache.find((row) => String(row.report_date).slice(0, 10) === event.target.value && row.status === 'Draft');
    if (found && found.report_id !== document.getElementById('daily-form')?.dataset.reportId) {
      ui.dailyId = found.report_id;
      drawDailyReport();
    }
  });
  const bindDailyList = () => {
    document.querySelectorAll('#daily-report-list [data-daily]').forEach((button) => button.addEventListener('click', () => { ui.dailyId = button.dataset.daily; drawDailyReport(); }));
  };
  document.querySelectorAll('.daily-rejected [data-daily]').forEach((button) => button.addEventListener('click', () => { ui.dailyId = button.dataset.daily; drawDailyReport(); }));
  document.getElementById('daily-filter')?.addEventListener('change', (event) => {
    ui.dailyFilter = event.target.value;
    const box = document.getElementById('daily-report-list');
    if (!box) return;
    box.innerHTML = dailyListHtml(visibleReports(), document.getElementById('daily-form')?.dataset.reportId || '', techName);
    bindDailyList();
  });
  const newReport = document.getElementById('daily-new');
  if (newReport) newReport.hidden = false;
  newReport?.addEventListener('click', () => {
    ui.dailyId = 'new';
    drawDailyReport();
  });
  bindDailyList();
  document.getElementById('daily-add')?.addEventListener('click', () => {
    const body = document.getElementById('daily-rows');
    body.insertAdjacentHTML('beforeend', dailyRow({}, body.children.length));
    bindDailyRow(body.lastElementChild);
  });
  document.getElementById('daily-resend')?.addEventListener('click', () => saveDailyReport(true));
  document.getElementById('daily-add-part')?.addEventListener('click', () => {
    const body = document.getElementById('daily-parts');
    body.insertAdjacentHTML('beforeend', dailyPartRow({}, body.children.length));
  });
  document.getElementById('daily-print')?.addEventListener('click', () => window.print());
  document.getElementById('daily-add-photo')?.addEventListener('click', () => document.getElementById('daily-photo-file')?.click());
  document.getElementById('daily-photo-file')?.addEventListener('change', (event) => {
    const files = [...event.target.files];
    event.target.value = '';
    addDailyPhotos(files).catch((exception) => {
      showReportAlert(exception.message);
    });
  });
  document.getElementById('daily-form')?.addEventListener('submit', (event) => { event.preventDefault(); saveDailyReport(false); });
}

const ISO_DOCUMENTS = [
  ['daily', 'DAILY MAINTENANCE REPORT'],
  ['job_order', 'Maintenance Job Order'],
  ['lubrication', 'Oil and grease change log'],
  ['motor', 'Motor condition'],
  ['equipment_log', 'Equipment maintenance log'],
  ['annual_plan', 'Annual preventive maintenance plan'],
];

function stockAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '';
  return String(Math.round(amount * 1000) / 1000);
}

function stockClass(part) {
  if (part?.stock_qty == null) return '';
  const stock = Number(part.stock_qty);
  if (stock <= 0) return 'stock-out';
  if (part.critical_qty != null && stock <= Number(part.critical_qty)) return 'stock-critical';
  return '';
}

let equipmentPartsToken = 0;

async function loadEquipmentParts(selected) {
  const token = ++equipmentPartsToken;
  const box = document.getElementById('equipment-parts');
  if (!box || !selected?.equipment_id) return;
  try {
    const parts = await apiRequest(`/spare-parts?equipment_id=${encodeURIComponent(selected.equipment_id)}`);
    if (token !== equipmentPartsToken || !box.isConnected) return;
    const rows = (parts || []).map((part) => {
      const stock = part.stock_qty == null ? t('No warehouse balance') : stockAmount(part.stock_qty);
      const tone = stockClass(part);
      return `<li><b>${esc(part.part_number)}</b><span>${esc(part.name)}</span><em${tone ? ` class="${tone}"` : ''}>${esc(stock)}</em></li>`;
    }).join('');
    box.innerHTML = `<h3>${esc(t('Spare parts'))}</h3>${rows ? `<ul class="spare-links">${rows}</ul>` : `<p class="live-note">${esc(t('No spare parts linked to this machine.'))}</p>`}<button type="button" class="detail-button" id="open-spare">${esc(t('Spare parts'))}</button>`;
    document.getElementById('open-spare')?.addEventListener('click', () => {
      ui.spareEquipment = selected.equipment_id;
      ui.mode = 'view';
      ui.rowKey = '';
      render('spare-parts');
    });
  } catch (exception) {
    if (token === equipmentPartsToken && box.isConnected) box.innerHTML = `<p class="form-error">${esc(t(exception.message || ''))}</p>`;
  }
}

function spareEquipmentIds(form) {
  return String(form.querySelector('[name="equipment_ids"]')?.value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function spareLinkHtml(ids) {
  const items = ids.map((id) => {
    const equipment = (store.equipment || []).find((row) => row.equipment_id === id);
    return `<li><b>${esc(id)}</b><span>${esc(equipment?.name || '')}</span><button type="button" data-remove-equipment="${esc(id)}">${esc(t('Remove'))}</button></li>`;
  }).join('');
  const remaining = (store.equipment || [])
    .filter((row) => !ids.includes(row.equipment_id))
    .sort((a, b) => String(a.equipment_id).localeCompare(String(b.equipment_id)));
  const options = remaining.map((row) => `<option value="${esc(row.equipment_id)}">${esc(row.equipment_id)} — ${esc(row.name)}</option>`).join('');
  return `<ul class="spare-links">${items || `<li class="live-note">${esc(t('Choose the equipment for this part'))}</li>`}</ul><label>${esc(t('Linked equipment'))}<select id="spare-add-equipment"><option value="">${esc(t('Select'))}</option>${options}</select></label>`;
}

function paintSpareEquipment(form) {
  const box = form.querySelector('#spare-equipment-box');
  if (!box) return;
  box.innerHTML = spareLinkHtml(spareEquipmentIds(form));
  box.querySelector('#spare-add-equipment')?.addEventListener('change', (event) => {
    const id = event.target.value;
    if (!id) return;
    const hidden = form.querySelector('[name="equipment_ids"]');
    hidden.value = [...spareEquipmentIds(form), id].join(',');
    paintSpareEquipment(form);
  });
  box.querySelectorAll('[data-remove-equipment]').forEach((button) => {
    button.addEventListener('click', () => {
      const hidden = form.querySelector('[name="equipment_ids"]');
      hidden.value = spareEquipmentIds(form).filter((id) => id !== button.dataset.removeEquipment).join(',');
      paintSpareEquipment(form);
    });
  });
}

function spareForm(part) {
  const ids = part?.equipment?.map((row) => row.equipment_id) || (ui.spareEquipment ? [ui.spareEquipment] : []);
  const stock = part?.stock_qty == null ? '' : stockAmount(part.stock_qty);
  const critical = part?.critical_qty == null ? '' : stockAmount(part.critical_qty);
  return `<aside class="panel detail"><h2>${esc(t(part ? 'Spare parts' : '+ Add part'))}</h2><form id="spare-form" class="live-form spare-form"><label>${esc(t('Part No.'))}<input name="part_number" required maxlength="100" value="${esc(part?.part_number || '')}"></label><label>${esc(t('Part name'))}<input name="name" required maxlength="200" value="${esc(part?.name || '')}"></label><label>${esc(t('Stock'))}<input name="stock_qty" type="number" step="0.001" value="${esc(stock)}"></label><p class="live-note">${esc(t('Leave empty when this part has no warehouse balance.'))}</p><p class="live-note">${esc(t('A daily report quantity reduces this balance when the part number matches.'))}</p><label>${esc(t('Critical balance'))}<input name="critical_qty" type="number" min="0" step="0.001" value="${esc(critical)}"></label><p class="live-note">${esc(t('Leave empty when this part has no critical balance.'))}</p><p class="live-note">${esc(t('The maintenance engineer is notified when the warehouse balance reaches this level.'))}</p><label>${esc(t('Unit'))}<input name="unit" maxlength="30" value="${esc(part?.unit || 'pcs')}"></label><input type="hidden" name="equipment_ids" value="${esc(ids.join(','))}"><div id="spare-equipment-box"></div><button class="detail-button primary" type="submit">${esc(t('Save'))}</button>${part ? `<button type="button" class="detail-button danger" data-delete="/spare-parts" data-delete-id="${esc(part.part_id)}" data-delete-note="Delete this spare part?">${esc(t('Delete'))}</button>` : ''}<p id="spare-error" class="form-error"></p></form></aside>`;
}

async function saveSparePart(event, partId) {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.getElementById('spare-error');
  const data = new FormData(form);
  const stockText = String(data.get('stock_qty') || '').trim().replace(',', '.');
  const stock = stockText === '' ? null : Number(stockText);
  if (stock !== null && !Number.isFinite(stock)) {
    if (error) error.textContent = t('Enter a warehouse balance');
    return;
  }
  const criticalText = String(data.get('critical_qty') || '').trim().replace(',', '.');
  const critical = criticalText === '' ? null : Number(criticalText);
  if (critical !== null && (!Number.isFinite(critical) || critical < 0)) {
    if (error) error.textContent = t('Enter a critical balance');
    return;
  }
  const equipmentIds = spareEquipmentIds(form);
  if (!equipmentIds.length) {
    if (error) error.textContent = t('Choose the equipment for this part');
    return;
  }
  const payload = {
    part_number: String(data.get('part_number') || '').trim(),
    name: String(data.get('name') || '').trim(),
    stock_qty: stock,
    critical_qty: critical,
    unit: String(data.get('unit') || '').trim() || 'pcs',
    equipment_ids: equipmentIds,
  };
  try {
    const saved = await apiRequest(partId ? `/spare-parts/${encodeURIComponent(partId)}` : '/spare-parts', {
      method: partId ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    });
    ui.mode = 'view';
    ui.rowKey = saved.part_id;
    toast(t('Saved.'));
    await drawSpareParts();
  } catch (exception) {
    if (error) error.textContent = t(exception.message);
  }
}

async function drawSpareParts() {
  const query = ui.spareEquipment ? `?equipment_id=${encodeURIComponent(ui.spareEquipment)}` : '';
  const parts = await apiRequest(`/spare-parts${query}`);
  const selected = ui.mode === 'create' ? null : (parts.find((item) => item.part_id === ui.rowKey) || parts[0]);
  if (selected) ui.rowKey = selected.part_id;
  const tracked = parts.filter((item) => item.stock_qty != null).length;
  const empty = parts.filter((item) => item.stock_qty != null && Number(item.stock_qty) <= 0).length;
  const criticalCount = parts.filter((item) => stockClass(item) === 'stock-critical' || (item.critical_qty != null && item.stock_qty != null && Number(item.stock_qty) <= Number(item.critical_qty))).length;
  document.getElementById('metric-grid').innerHTML = metrics([
    ['Spare parts', String(parts.length), '□', 'blue', ''],
    ['With a balance', String(tracked), '▣', 'green', ''],
    ['Out of stock', String(empty), '×', 'red', ''],
    ['Critical balance', String(criticalCount), '!', 'orange', ''],
    ['Linked equipment', String(new Set(parts.flatMap((item) => (item.equipment || []).map((row) => row.equipment_id))).size), '⚙', 'orange', ''],
  ]);
  const equipmentOptions = [`<option value="">${esc(t('All equipment'))}</option>`].concat(
    (store.equipment || [])
      .slice()
      .sort((a, b) => String(a.equipment_id).localeCompare(String(b.equipment_id)))
      .map((item) => `<option value="${esc(item.equipment_id)}"${item.equipment_id === ui.spareEquipment ? ' selected' : ''}>${esc(item.equipment_id)} — ${esc(item.name)}</option>`),
  );
  const body = parts.map((item) => {
    const machines = (item.equipment || []).map((row) => row.equipment_id).join(', ') || '—';
    const stock = item.stock_qty == null ? t('No warehouse balance') : stockAmount(item.stock_qty);
    const tone = stockClass(item);
    const stockCell = tone ? `<span class="${tone}">${esc(stock)}</span>` : esc(stock);
    const critical = item.critical_qty == null ? '—' : stockAmount(item.critical_qty);
    return `<tr data-row="${esc(item.part_id)}" class="${selected && selected.part_id === item.part_id ? 'selected' : ''}">${cell(esc(item.part_number), true)}${cell(esc(item.name))}${cell(esc(machines))}${cell(stockCell)}${cell(esc(critical))}${cell(esc(item.unit || 'pcs'))}</tr>`;
  });
  document.getElementById('workspace').className = 'workspace';
  document.getElementById('workspace').innerHTML = `<section class="panel"><label class="spare-filter">${esc(t('Linked equipment'))}<select id="spare-equipment">${equipmentOptions.join('')}</select></label>${tableShell(['Part No.', 'Part name', 'Linked equipment', 'Stock', 'Critical balance', 'Unit'], body.length ? body : [`<tr><td colspan="6">${esc(t('No spare parts yet.'))}</td></tr>`], shown(parts.length, parts.length, 'parts'))}</section>${ui.mode === 'create' ? spareForm(null) : (selected ? spareForm(selected) : `<aside class="panel detail"><h2>${esc(t('Spare parts'))}</h2><p class="live-note">${esc(t('No spare parts yet.'))}</p></aside>`)}`;
  document.getElementById('spare-equipment')?.addEventListener('change', (event) => {
    ui.spareEquipment = event.target.value;
    ui.rowKey = '';
    ui.mode = 'view';
    drawSpareParts();
  });
  const form = document.getElementById('spare-form');
  if (form) {
    paintSpareEquipment(form);
    form.addEventListener('submit', (event) => saveSparePart(event, ui.mode === 'create' ? '' : (selected?.part_id || '')));
  }
  bindRows();
  bindDeletes();
}

function drawIso() {
  document.getElementById('metric-grid').innerHTML = '';
  document.getElementById('workspace').className = 'workspace';
  document.getElementById('workspace').innerHTML = `<form id="iso-form" class="panel iso-form"><div class="iso-head"><span>${esc(t('Document'))}</span><span>${esc(t('Form No.:'))}</span></div>${ISO_DOCUMENTS.map(([key, label]) => `<label class="iso-row"><span>${esc(t(label))}</span><input name="${esc(key)}" maxlength="80" value="${esc(formNo(key))}" autocomplete="off" aria-label="${esc(t(label))}"></label>`).join('')}</form>`;
  document.getElementById('iso-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    saveIsoForms();
  });
}

async function saveIsoForms() {
  const form = document.getElementById('iso-form');
  if (!form || !canMaintain()) return;
  const forms = {};
  [...form.elements].forEach((field) => {
    if (field.name) forms[field.name] = field.value.trim();
  });
  try {
    isoForms = await apiRequest('/form-numbers', { method: 'PUT', body: JSON.stringify({ forms }) });
    toast(t('Saved.'));
    drawIso();
  } catch (error) {
    toast(error.message);
  }
}

async function draw(page) {
  if (page === 'dashboard') await drawDashboard();
  else if (page === 'work-orders') drawWorkOrders();
  else if (page === 'pm-schedule') await drawPlans();
  else if (page === 'plants') drawPlants();
  else if (page === 'new-equipment' || page === 'equipment') drawEquipment();
  else if (page === 'sop') await drawSops();
  else if (page === 'lubrication') await drawLubrication();
  else if (page === 'motor-condition') await drawMotorCondition();
  else if (page === 'daily-reports') await drawDailyReport();
  else if (page === 'iso') drawIso();
  else if (page === 'spare-parts') await drawSpareParts();
  else drawRecords();
}

async function paint(page) {
  const token = ++paintToken;
  ui.page = page;
  setHeader(page);
  document.getElementById('metric-grid').innerHTML = metrics([['Loading', '…', '◷', 'blue', '']]);
  const workspace = document.getElementById('workspace');
  workspace.hidden = false;
  workspace.className = 'workspace';
  workspace.innerHTML = `<section class="panel"><p class="live-note">${esc(t('Loading live records…'))}</p></section>`;
  try {
    if (!store) await loadStore();
    if (token !== paintToken) return;
    await draw(page);
  } catch (error) {
    if (token !== paintToken) return;
    document.getElementById('workspace').innerHTML = `<section class="panel"><p class="live-note">${esc(error.message)}</p></section>`;
  }
}

function openCreate() {
  if (isTechnician()) {
    if (ui.page !== 'equipment') {
      toast(t('A technician can add equipment only.'));
      return;
    }
  } else if (!canMaintain()) {
    toast(t('Only a maintenance engineer can add this record.'));
    return;
  }
  ui.mode = 'create';
  draw(ui.page);
}

document.getElementById('primary-action').addEventListener('click', (event) => {
  if (!document.body.dataset.livePage) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (ui.page === 'machine-records') exportRecords();
  else if (ui.page === 'dashboard') (document.getElementById('plant-menu-toggle') || document.querySelector('[data-filter="plant"]'))?.focus();
  else if (ui.page === 'pm-schedule' && isTechnician()) return;
  else if (ui.page === 'pm-schedule' && document.querySelector('.week-day')) saveWeekTasks();
  else if (ui.page === 'pm-schedule' && document.getElementById('annual-rows')) saveAnnualPlan();
  else if (ui.page === 'pm-schedule') return;
  else if (ui.page === 'lubrication') saveLubrication();
  else if (ui.page === 'motor-condition') saveMotorCondition();
  else if (ui.page === 'daily-reports') saveDailyReport(true);
  else if (ui.page === 'iso') saveIsoForms();
  else openCreate();
}, true);

document.getElementById('draft-action')?.addEventListener('click', (event) => {
  if (ui.page !== 'daily-reports') return;
  event.preventDefault();
  saveDailyReport(false);
});

render = function liveRender(page) {
  if (page === 'users' || page === 'user') {
    document.body.dataset.livePage = '';
    shellRender(page);
    return;
  }
  if (page === 'daily-reports' && !isTechnician()) {
    location.href = 'daily-reports.html';
    return;
  }
  let name = LIVE_PAGES.has(page) ? page : 'dashboard';
  const lubricationPages = ['lubrication', 'work-orders', 'sop', 'motor-condition'];
  const maintenancePages = ['daily-reports', 'work-orders', 'pm-schedule', 'sop'];
  const openReports = name === 'new-equipment' && canMaintain();
  if (isLubricationTechnician()) {
    if (!lubricationPages.includes(name)) name = 'lubrication';
  } else if (getSavedUser()?.role === 'TECHNICIAN') {
    if (!maintenancePages.includes(name)) name = 'work-orders';
  } else if (name === 'motor-condition' && !canSeeMotor()) {
    name = 'dashboard';
  } else if (name === 'new-equipment' || name === 'equipment') {
    name = canMaintain() ? 'equipment' : 'dashboard';
  } else if (name === 'iso' && !canMaintain()) {
    name = 'dashboard';
  } else if (name === 'spare-parts' && !canMaintain()) {
    name = 'dashboard';
  }
  if (name !== ui.page) {
    ui.tab = openReports ? 'From reports' : DEFAULT_TAB[name];
    ui.rowKey = '';
    ui.mode = 'view';
  }
  document.body.dataset.livePage = name;
  paint(name);
};

const boot = location.hash.slice(1);
render(boot === 'users' || boot === 'user' || boot === 'daily-reports' || LIVE_PAGES.has(boot) ? boot : 'dashboard');
document.addEventListener('cmms-language', () => {
  captureAnnual();
  if (document.body.dataset.livePage) paint(ui.page);
  else if (location.hash === '#user' && typeof renderMyAccount === 'function') renderMyAccount();
  else if (location.hash === '#users' && typeof renderUsers === 'function') renderUsers();
});
