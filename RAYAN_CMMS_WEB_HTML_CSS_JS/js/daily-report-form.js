const ACTIVITY_ROWS_PER_PAGE = 10;
const PART_ROWS = 5;
let currentUser = null;
let currentReport = null;
let serializedActivityRows = [];
let catalog = { plants: [], lines: [] };

function activityRow(number) {
  return `<tr data-row="${number}"><td class="row-number">${number}</td><td class="line-cell"><input class="line-input" data-field="line" inputmode="numeric" aria-label="Line number ${number}" data-i18n-placeholder="No." placeholder="No."><span class="line-name" data-line-name></span></td><td><input class="equipment-code" data-field="code" aria-label="Equipment code ${number}" data-i18n-placeholder="Code" placeholder="Code" required></td><td><input class="equipment-name" data-field="name" aria-label="Equipment name ${number}" data-i18n-placeholder="Name" placeholder="Name"></td><td><select data-field="type" aria-label="Maintenance type ${number}"><option value="" data-i18n-option="Select">Select</option><option value="Preventive" data-i18n-option="Preventive">Preventive</option><option value="Corrective" data-i18n-option="Corrective">Corrective</option><option value="Emergency" data-i18n-option="Emergency">Emergency</option><option value="Routine" data-i18n-option="Routine">Routine</option><option value="Inspection" data-i18n-option="Inspection">Inspection</option></select></td><td><input class="work-order" data-field="wo" aria-label="Work order ${number}" readonly></td><td><input data-field="failure" aria-label="Failure reason ${number}"></td><td><input data-field="action" aria-label="Repair actions ${number}"></td><td><input class="time" data-field="start" type="time" step="60" aria-label="Start time (hours and minutes) ${number}"></td><td><input class="time" data-field="end" type="time" step="60" aria-label="End time (hours and minutes) ${number}"></td><td><input class="downtime" data-field="downtime" aria-label="Downtime (hours) ${number}" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.00" readonly title="Calculated from start and end time"></td></tr>`;
}

function activityHeader() {
  return `<thead><tr><th rowspan="2" data-i18n="No.">No.</th><th rowspan="2" data-i18n="Line">Line</th><th colspan="2" data-i18n="Machine">Machine</th><th rowspan="2" data-i18n="Maintenance Type">Maintenance Type</th><th rowspan="2" data-i18n="Work Order No.">Work Order No.</th><th rowspan="2" data-i18n="Failure Reason">Failure Reason</th><th rowspan="2" data-i18n="Repair Actions">Repair Actions</th><th rowspan="2" data-i18n="Start Time">Start Time</th><th rowspan="2" data-i18n="End Time">End Time</th><th rowspan="2" data-i18n="Downtime (hrs)">Downtime (hrs)</th></tr><tr><th data-i18n="Code">Code</th><th data-i18n="Name">Name</th></tr></thead>`;
}

function activityPage(pageNumber) {
  const firstRow = (pageNumber - 1) * ACTIVITY_ROWS_PER_PAGE + 1;
  const rows = Array.from(
    { length: ACTIVITY_ROWS_PER_PAGE },
    (_, index) => activityRow(firstRow + index)
  ).join('');

  return `<section class="activity-page" data-page="${pageNumber}"><div class="activity-page-label"><strong data-i18n="DAILY MAINTENANCE REPORT">DAILY MAINTENANCE REPORT</strong><span>${t('Activity page')} ${pageNumber}</span></div><table class="activity-table">${activityHeader()}<tbody>${rows}</tbody></table></section>`;
}

function fillSpareLists() {
  let numbers = document.getElementById('spare-part-numbers');
  let names = document.getElementById('spare-part-names');
  if (!numbers) {
    numbers = document.createElement('datalist');
    numbers.id = 'spare-part-numbers';
    document.body.append(numbers);
  }
  if (!names) {
    names = document.createElement('datalist');
    names.id = 'spare-part-names';
    document.body.append(names);
  }
  numbers.replaceChildren();
  names.replaceChildren();
  (catalog.parts || []).forEach((part) => {
    const number = document.createElement('option');
    number.value = part.part_number || '';
    number.label = part.name || '';
    numbers.append(number);
    const name = document.createElement('option');
    name.value = part.name || '';
    name.label = part.part_number || '';
    names.append(name);
  });
}

function partRow(number) {
  return `<tr><td class="row-number">${number}</td><td><input data-part="description" list="spare-part-names" aria-label="Part description ${number}"></td><td><input data-part="number" list="spare-part-numbers" aria-label="Part number ${number}"></td><td><input data-part="quantity" aria-label="Part quantity ${number}" type="number" min="0" step="any"></td><td><input data-part="remarks" aria-label="Part remarks ${number}"></td></tr>`;
}

function message(text, isError = false) {
  const target = document.getElementById('form-message');
  target.textContent = text;
  target.style.color = isError ? '#c92532' : '#19724b';
}

function dateForInput(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function timeToMinutes(value) {
  if (!/^\d{2}:\d{2}$/.test(value || '')) return null;
  const [hours, minutes] = value.split(':').map(Number);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function updateTotalDowntime() {
  const total = [...document.querySelectorAll('.downtime')]
    .reduce((sum, input) => sum + (Number(input.value) || 0), 0);
  const output = document.getElementById('total-downtime');
  output.value = total.toFixed(2);
  output.textContent = total.toFixed(2);
}

function calculateRowDowntime(row) {
  const start = row.querySelector('[data-field="start"]').value;
  const end = row.querySelector('[data-field="end"]').value;
  const output = row.querySelector('[data-field="downtime"]');
  const startMinutes = timeToMinutes(start);
  const endMinutes = timeToMinutes(end);

  if (startMinutes === null || endMinutes === null) {
    output.value = '';
    output.dataset.calculated = 'false';
    row.classList.remove('has-downtime');
    updateTotalDowntime();
    return;
  }

  const adjustedEnd = endMinutes < startMinutes ? endMinutes + 24 * 60 : endMinutes;
  const downtime = (adjustedEnd - startMinutes) / 60;
  output.value = downtime.toFixed(2);
  output.dataset.calculated = 'true';
  output.title = `${downtime.toFixed(2)} hours calculated from ${start} to ${end}`;
  row.classList.add('has-downtime');
  updateTotalDowntime();
}

function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function selectedPlantId() {
  return document.getElementById('plant-summary').value;
}

function fillPlantSelect(selected) {
  const select = document.getElementById('plant-summary');
  select.innerHTML = `<option value="">Select plant</option>${catalog.plants.filter((plant) => plant.active !== false || plant.plant_id === selected).map((plant) => `<option value="${htmlEscape(plant.plant_id)}">${htmlEscape(plant.name)}</option>`).join('')}`;
  if (selected) select.value = selected;
}

function setRegisteredEquipment(row, equipment) {
  row.dataset.registered = 'true';
  row.dataset.equipmentId = equipment.equipment_id;
  row.dataset.plantId = equipment.plant_id || '';
  if (equipment.line_id) row.dataset.lineId = equipment.line_id;
  const name = row.querySelector('[data-field="name"]');
  name.value = equipment.equipment_name;
  name.readOnly = true;
  name.classList.add('found');
  name.classList.remove('manual');
  const line = row.querySelector('[data-field="line"]');
  if (!line.value && equipment.line_number != null) {
    line.value = equipment.line_number;
    resolveLine(row, false);
  }
}

function setManualEquipment(row) {
  row.dataset.registered = 'false';
  row.dataset.equipmentId = '';
  const name = row.querySelector('[data-field="name"]');
  if (row.dataset.assigned !== 'true') name.readOnly = false;
  name.classList.remove('found');
  name.classList.add('manual');
}

function resolveLine(row, lookup = true) {
  const number = row.querySelector('[data-field="line"]').value.trim();
  const name = row.querySelector('[data-line-name]');
  const line = catalog.lines.find((item) => item.plant_id === selectedPlantId() && String(item.line_number) === number);
  if (line) {
    row.dataset.lineId = line.line_id;
    name.textContent = line.name;
  } else {
    if (row.dataset.assigned !== 'true') row.dataset.lineId = '';
    name.textContent = number ? 'Not found' : '';
  }
  if (lookup && row.dataset.assigned !== 'true') lookupEquipment(row);
}

async function lookupEquipment(row) {
  if (row.dataset.assigned === 'true') return;
  const code = row.querySelector('[data-field="code"]').value.trim();
  if (!code) {
    setManualEquipment(row);
    return;
  }
  const params = new URLSearchParams({ code });
  if (selectedPlantId()) params.set('plant_id', selectedPlantId());
  if (row.dataset.lineId) params.set('line_id', row.dataset.lineId);
  try {
    const result = await apiRequest(`/equipment/lookup?${params.toString()}`);
    if (result.matches.length === 1) {
      setRegisteredEquipment(row, result.matches[0]);
      message(`Registered equipment: ${result.matches[0].equipment_name}`);
    } else {
      setManualEquipment(row);
      message('This code is not registered. Enter its name. It stays off the plant equipment list until an engineer approves it.');
    }
  } catch (error) {
    setManualEquipment(row);
    message(error.message || 'Could not look up the equipment code.', true);
  }
}

function bindActivityInputs(scope) {
  scope.querySelectorAll('.line-input').forEach((input) => {
    input.addEventListener('input', () => resolveLine(input.closest('tr')));
  });
  scope.querySelectorAll('.equipment-code').forEach(input => {
    input.addEventListener('input', () => {
      const row = input.closest('tr');
      if (row.dataset.registered === 'true') row.querySelector('[data-field="name"]').value = '';
      setManualEquipment(row);
    });
    input.addEventListener('change', () => lookupEquipment(input.closest('tr')));
  });
  scope.querySelectorAll('[data-field="type"]').forEach((input) => {
    input.addEventListener('change', () => issueHighWorkOrder(input.closest('tr')));
  });
  scope.querySelectorAll('.time').forEach(input => {
    ['input', 'change', 'blur'].forEach(event => {
      input.addEventListener(event, () => calculateRowDowntime(input.closest('tr')));
    });
  });
}

async function issueHighWorkOrder(row) {
  if (!row || row.dataset.assigned === 'true') return;
  const typeInput = row.querySelector('[data-field="type"]');
  const type = typeInput.value;
  const workOrder = row.querySelector('[data-field="wo"]');
  if (type !== 'Corrective' && type !== 'Emergency') {
    const current = workOrder?.value.trim() || '';
    if (workOrder) workOrder.value = '';
    if (current && row.dataset.assigned !== 'true') {
      apiRequest(`/work-orders/${encodeURIComponent(current)}/release-activity`, { method: 'POST' }).catch(() => {});
    }
    return;
  }
  if (workOrder.value.trim()) return;
  const code = row.querySelector('[data-field="code"]').value.trim();
  const name = row.querySelector('[data-field="name"]').value.trim();
  if (!code || !name) {
    typeInput.value = '';
    message('Enter the equipment code and name before choosing Corrective or Emergency.', true);
    return;
  }
  if (!selectedPlantId() && row.dataset.registered !== 'true') {
    typeInput.value = '';
    message('Select a plant at the top of the report first.', true);
    return;
  }
  try {
    const order = await apiRequest('/work-orders/from-activity', {
      method: 'POST',
      body: JSON.stringify({
        equipment_code: code,
        equipment_name: name,
        plant_id: selectedPlantId() || row.dataset.plantId || null,
        line_id: row.dataset.lineId || null,
        maintenance_type: type,
        failure_reason: row.querySelector('[data-field="failure"]').value.trim() || null,
        action_taken: row.querySelector('[data-field="action"]').value.trim() || null,
      }),
    });
    workOrder.value = order.work_order_id;
    message(`Work order ${order.work_order_id} was registered as High and added to the related records.`);
  } catch (error) {
    typeInput.value = '';
    message(error.message || 'Could not register the work order.', true);
  }
}

function writeWorkOrderNumbers(items) {
  (items || []).forEach((item, index) => {
    const row = serializedActivityRows[index];
    if (row && item.wo_id) row.querySelector('[data-field="wo"]').value = item.wo_id;
  });
}

function updatePageLabels() {
  const pages = [...document.querySelectorAll('.activity-page')];
  const total = pages.length;
  pages.forEach((page, index) => {
    const label = page.querySelector('.activity-page-label span');
    const firstRow = index * ACTIVITY_ROWS_PER_PAGE + 1;
    label.textContent = `Page ${index + 1} of ${total} · rows ${firstRow}–${firstRow + ACTIVITY_ROWS_PER_PAGE - 1}`;
  });
  document.getElementById('page-count').textContent = `1 of ${total}`;
}

function addActivityPage() {
  const pages = document.getElementById('activity-pages');
  const pageNumber = pages.querySelectorAll('.activity-page').length + 1;
  pages.insertAdjacentHTML('beforeend', activityPage(pageNumber));
  if (typeof applyLanguage === 'function') applyLanguage();
  const page = pages.lastElementChild;
  bindActivityInputs(page);
  updatePageLabels();
  page.querySelector('.equipment-code').focus();
  message(`Activity page ${pageNumber} added. You can enter 10 more maintenance activities.`);
}

function serializeParts() {
  const parts = [...document.querySelectorAll('#parts-rows tr')].map(row => ({
    description: row.querySelector('[data-part="description"]').value.trim(),
    part_number: row.querySelector('[data-part="number"]').value.trim(),
    quantity: row.querySelector('[data-part="quantity"]').value.trim(),
    remarks: row.querySelector('[data-part="remarks"]').value.trim(),
  })).filter(part => Object.values(part).some(Boolean));
  return parts.length
    ? parts.map(part => `${part.description || 'Part'} | No: ${part.part_number || '—'} | Qty: ${part.quantity || '—'} | ${part.remarks || ''}`).join('\n')
    : null;
}

function serializeActivities() {
  const parts = serializeParts();
  const activities = [];
  serializedActivityRows = [];
  for (const row of document.querySelectorAll('#activity-pages tr[data-row]')) {
    const get = field => row.querySelector(`[data-field="${field}"]`).value.trim();
    const code = get('code');
    const name = get('name');
    const selected = [code, name, get('type'), get('failure'), get('action'), get('start'), get('end'), get('downtime')].some(Boolean);
    if (!selected) continue;
    if (!selectedPlantId()) throw new Error('Select a plant at the top of the report.');
    if (!code || !name || !get('type')) {
      throw new Error(`Activity row ${row.dataset.row}: equipment code, machine name, and maintenance type are required.`);
    }
    const start = get('start') || null;
    const end = get('end') || null;
    activities.push({
      equipment_id: row.dataset.registered === 'true' ? row.dataset.equipmentId : null,
      equipment_code: code,
      equipment_name: name,
      plant_id: row.dataset.registered === 'true' ? (row.dataset.plantId || selectedPlantId()) : selectedPlantId(),
      line_id: row.dataset.lineId || null,
      entered_line_number: get('line') || null,
      is_manual_entry: row.dataset.registered !== 'true',
      maintenance_type: get('type'),
      // Start/end are used by the work order and by the downtime engine.
      maintenance_start: start,
      maintenance_end: end,
      downtime_start: start,
      downtime_end: end,
      downtime_h: get('downtime') ? Number(get('downtime')) : null,
      failure_reason: get('failure') || null,
      action_taken: get('action') || null,
      wo_id: get('wo') || null,
      spare_parts: parts,
      maintenance_completed: true,
    });
    serializedActivityRows.push(row);
  }
  if (!activities.length) throw new Error('Enter at least one maintenance activity.');
  return activities;
}

function lockAssignedRow(row) {
  row.dataset.assigned = 'true';
  const open = new Set(['type', 'action', 'start', 'end']);
  row.querySelectorAll('input, select').forEach((input) => {
    if (!input.dataset.field || input.dataset.field === 'downtime') return;
    input.disabled = !open.has(input.dataset.field);
  });
}

function valueOf(item, name) {
  return item?.[name] ? String(item[name]).slice(0, 5) : '';
}

function fillReport(detail) {
  currentReport = detail.report;
  document.getElementById('approved-by').textContent = currentReport.approved_by || '—';
  document.getElementById('report-state').textContent = currentReport.status;
  document.getElementById('report-date').value = String(currentReport.report_date).slice(0, 10);
  document.getElementById('report-date').disabled = true;
  document.getElementById('meta-date').textContent = new Date(`${String(currentReport.report_date).slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB');
  if (currentReport.shift) document.getElementById('shift').value = currentReport.shift;
  if (currentReport.general_notes) document.getElementById('general-notes').value = currentReport.general_notes;
  const items = detail.items || [];
  fillPlantSelect(currentReport.plant_id || items.find((item) => item.plant_id)?.plant_id || '');
  const pageCount = Math.max(1, Math.ceil(items.length / ACTIVITY_ROWS_PER_PAGE));
  const pages = document.getElementById('activity-pages');
  pages.innerHTML = Array.from({ length: pageCount }, (_, index) => activityPage(index + 1)).join('');
  if (typeof applyLanguage === 'function') applyLanguage();
  bindActivityInputs(pages);
  updatePageLabels();
  const rows = [...pages.querySelectorAll('tr[data-row]')];
  items.forEach((item, index) => {
    const row = rows[index];
    if (!row) return;
    const set = (field, value) => {
      const input = row.querySelector(`[data-field="${field}"]`);
      if (input) input.value = value || '';
    };
    row.dataset.registered = item.is_manual_entry ? 'false' : 'true';
    row.dataset.equipmentId = item.equipment_id || '';
    row.dataset.plantId = item.plant_id || '';
    row.dataset.lineId = item.line_id || '';
    const knownLine = catalog.lines.find((line) => line.line_id === item.line_id);
    set('line', knownLine?.line_number ?? item.entered_line_number ?? '');
    resolveLine(row, false);
    set('code', item.equipment_code || item.equipment_id);
    set('name', item.equipment_name);
    const nameInput = row.querySelector('[data-field="name"]');
    nameInput.readOnly = row.dataset.registered === 'true';
    nameInput.classList.toggle('found', row.dataset.registered === 'true');
    nameInput.classList.toggle('manual', row.dataset.registered !== 'true');
    set('type', item.maintenance_type);
    set('wo', item.wo_id);
    set('failure', item.failure_reason);
    set('action', item.action_taken);
    set('start', valueOf(item, 'maintenance_start'));
    set('end', valueOf(item, 'maintenance_end'));
    if (item.downtime_h != null) set('downtime', Number(item.downtime_h).toFixed(2));
    if (item.wo_id) lockAssignedRow(row);
  });
  updateTotalDowntime();
}

function blankReport() {
  currentReport = null;
  const today = dateForInput(new Date());
  document.getElementById('report-date').disabled = false;
  document.getElementById('report-date').value = today;
  document.getElementById('meta-date').textContent = new Date().toLocaleDateString('en-GB');
  document.getElementById('approved-by').textContent = '—';
  document.getElementById('report-state').textContent = t('Draft report');
  document.getElementById('save-draft').disabled = false;
  document.getElementById('submit-report').disabled = false;
  const pages = document.getElementById('activity-pages');
  pages.innerHTML = activityPage(1);
  if (typeof applyLanguage === 'function') applyLanguage();
  bindActivityInputs(pages);
  updatePageLabels();
}

async function drawMyReports() {
  if (currentUser?.role !== 'TECHNICIAN') return;
  const box = document.getElementById('my-reports');
  if (!box) return;
  box.hidden = false;
  const reports = await apiRequest('/daily-reports');
  const openId = currentReport?.report_id || '';
  const buttons = reports.map((report) => {
    const day = String(report.report_date).slice(0, 10);
    const label = new Date(`${day}T00:00:00`).toLocaleDateString('en-GB');
    return `<button type="button" data-report="${htmlEscape(report.report_id)}" class="${report.report_id === openId ? 'selected' : ''}">${htmlEscape(label)} · ${htmlEscape(t(report.status || 'Draft'))}</button>`;
  }).join('');
  box.innerHTML = `<b>${htmlEscape(t('My Reports'))}</b><button type="button" id="open-today">${htmlEscape(t('Today'))}</button>${buttons}`;
  document.getElementById('open-today')?.addEventListener('click', openToday);
  box.querySelectorAll('[data-report]').forEach((button) => button.addEventListener('click', () => openSavedReport(button.dataset.report)));
}

async function openSavedReport(reportId) {
  fillReport(await apiRequest(`/daily-reports/${encodeURIComponent(reportId)}`));
  await drawMyReports();
}

async function openToday() {
  blankReport();
  await loadTodaysReport();
  await drawMyReports();
}

async function loadTodaysReport() {
  const today = document.getElementById('report-date').value;
  const reports = await apiRequest('/daily-reports');
  const todays = reports.filter((report) => String(report.report_date).slice(0, 10) === today);
  const mine = todays.find((report) => report.status === 'Draft' || report.status === 'Returned') || todays[0];
  if (!mine) return;
  fillReport(await apiRequest(`/daily-reports/${encodeURIComponent(mine.report_id)}`));
  message('Accepted work orders show the equipment, failure reason, and work order number. Enter the repair actions and the repair time.');
}

async function saveReport(submit) {
  if (currentReport && currentReport.status !== 'Draft' && currentReport.status !== 'Returned') {
    message('This report can no longer be edited.', true);
    return;
  }
  if (currentReport) {
    try {
      const payload = {
        plant_id: selectedPlantId() || null,
        general_notes: document.getElementById('general-notes').value.trim() || null,
        items: serializeActivities(),
      };
      message(submit ? 'Saving repair actions and sending the report…' : 'Saving repair actions…');
      const response = await apiRequest(`/daily-reports/${encodeURIComponent(currentReport.report_id)}`, { method: 'PUT', body: JSON.stringify(payload) });
      currentReport = response.report;
      writeWorkOrderNumbers(response.items);
      if (submit) {
        await apiRequest(`/daily-reports/${encodeURIComponent(currentReport.report_id)}/submit`, { method: 'POST' });
        document.getElementById('report-state').textContent = 'Submitted for engineer approval';
        document.getElementById('submit-report').disabled = true;
        message('Report sent to the maintenance engineer for approval.');
      } else {
        document.getElementById('report-state').textContent = currentReport.status;
        message('Repair actions saved.');
      }
      drawMyReports();
    } catch (error) {
      message(error.message || 'Could not save the daily report.', true);
    }
    return;
  }

  try {
    const payload = {
      report_date: document.getElementById('report-date').value,
      plant_id: selectedPlantId() || null,
      shift: document.getElementById('shift').value,
      general_notes: document.getElementById('general-notes').value.trim() || null,
      items: serializeActivities(),
    };
    if (!payload.report_date) throw new Error('Report date is required.');
    message('Saving daily report…');
    const response = await apiRequest('/daily-reports', { method: 'POST', body: JSON.stringify(payload) });
    currentReport = response.report;
    document.getElementById('approved-by').textContent = currentReport.approved_by || '—';
    document.getElementById('report-state').textContent = currentReport.status;
    writeWorkOrderNumbers(response.items);
    if (submit) {
      await apiRequest(`/daily-reports/${encodeURIComponent(currentReport.report_id)}/submit`, { method: 'POST' });
      document.getElementById('report-state').textContent = 'Submitted for engineer approval';
      message('Report sent to the maintenance engineer for approval.');
    } else {
      message('Draft saved successfully. You can now submit it for engineer approval.');
    }
    drawMyReports();
    document.getElementById('save-draft').disabled = true;
    document.getElementById('submit-report').disabled = submit;
  } catch (error) {
    message(error.message || 'Could not save the daily report.', true);
  }
}

async function initializeForm() {
  if (!hasSavedSession()) return location.replace('login.html');
  if (!(await restoreSession())) return location.replace('login.html');
  try {
    currentUser = await getCurrentUser();
    if (currentUser.role === 'TECHNICIAN') {
      location.replace('index.html#daily-reports');
      return;
    }
    message('Daily Report entry is available to a Technician account. Select a technician account to submit a report.', true);
    document.getElementById('technician-name').value = currentUser.full_name || 'Technician';
  } catch (_) {
    logout();
    return location.replace('login.html');
  }

  catalog.plants = await apiRequest('/plants');
  catalog.lines = await apiRequest('/lines');
  try {
    catalog.parts = await apiRequest('/spare-parts/catalog');
  } catch (_) {
    catalog.parts = [];
  }
  fillSpareLists();
  fillPlantSelect('');
  document.getElementById('plant-summary').addEventListener('change', () => {
    document.querySelectorAll('#activity-pages tr[data-row]').forEach((row) => resolveLine(row));
  });
  const today = dateForInput(new Date());
  document.getElementById('report-date').value = today;
  document.getElementById('meta-date').textContent = new Date().toLocaleDateString('en-GB');
  try {
    const forms = await apiRequest('/form-numbers');
    const slot = document.getElementById('daily-form-no');
    if (slot && forms?.daily) slot.textContent = forms.daily;
  } catch (_) {}
  const pages = document.getElementById('activity-pages');
  pages.innerHTML = activityPage(1);
  if (typeof applyLanguage === 'function') applyLanguage();
  bindActivityInputs(pages);
  updatePageLabels();
  document.getElementById('parts-rows').innerHTML = Array.from({ length: PART_ROWS }, (_, index) => partRow(index + 1)).join('');
  document.getElementById('report-date').addEventListener('change', event => {
    document.getElementById('meta-date').textContent = new Date(`${event.target.value}T00:00:00`).toLocaleDateString('en-GB');
  });
  document.getElementById('add-activity-page').addEventListener('click', addActivityPage);
  document.getElementById('save-draft').addEventListener('click', () => saveReport(false));
  document.getElementById('submit-report').addEventListener('click', () => saveReport(true));
  document.getElementById('print-report').addEventListener('click', () => {
    if (currentReport) window.open(`daily-report-print.html?report=${encodeURIComponent(currentReport.report_id)}`, '_blank');
  });
  try {
    await loadTodaysReport();
    await drawMyReports();
  } catch (error) {
    message(error.message || 'Could not load the assigned work orders.', true);
  }
}

document.addEventListener('DOMContentLoaded', initializeForm);
document.addEventListener('cmms-language', () => {
  document.querySelectorAll('.activity-page').forEach((page, index) => {
    const label = page.querySelector('.activity-page-label span');
    if (label) label.textContent = `${t('Activity page')} ${index + 1}`;
  });
});
