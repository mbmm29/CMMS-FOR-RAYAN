const ACTIVITY_ROWS_PER_PAGE = 10;
const PART_ROWS = 5;
let currentUser = null;
let currentReport = null;
let serializedActivityRows = [];

function activityRow(number) {
  return `<tr data-row="${number}"><td class="row-number">${number}</td><td><input class="line-input" data-field="line" aria-label="Line ${number}"></td><td><input class="equipment-code" data-field="code" aria-label="Equipment code ${number}" placeholder="Code"></td><td><input class="equipment-name" data-field="name" aria-label="Equipment name ${number}" placeholder="Name"></td><td><select data-field="type" aria-label="Maintenance type ${number}"><option value="">Select</option><option value="Preventive">Preventive</option><option value="Corrective">Corrective</option><option value="Routine">Routine</option><option value="Inspection">Inspection</option></select></td><td><input class="work-order" data-field="wo" aria-label="Work order ${number}" readonly></td><td><input data-field="failure" aria-label="Failure reason ${number}"></td><td><input data-field="action" aria-label="Repair actions ${number}"></td><td><input class="time" data-field="start" type="time" step="60" aria-label="Start time (hours and minutes) ${number}"></td><td><input class="time" data-field="end" type="time" step="60" aria-label="End time (hours and minutes) ${number}"></td><td><input class="downtime" data-field="downtime" aria-label="Downtime (hours) ${number}" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.00" readonly title="Calculated from start and end time"></td></tr>`;
}

function activityHeader() {
  return `<thead><tr><th rowspan="2">No.</th><th rowspan="2">Line</th><th colspan="2">Machine</th><th rowspan="2">Maintenance<br>Type</th><th rowspan="2">Work Order<br>No.</th><th rowspan="2">Failure Reason</th><th rowspan="2">Repair Actions</th><th rowspan="2">Start<br>Time</th><th rowspan="2">End<br>Time</th><th rowspan="2">Downtime<br>(hrs)</th></tr><tr><th>Code</th><th>Name</th></tr></thead>`;
}

function activityPage(pageNumber) {
  const firstRow = (pageNumber - 1) * ACTIVITY_ROWS_PER_PAGE + 1;
  const rows = Array.from(
    { length: ACTIVITY_ROWS_PER_PAGE },
    (_, index) => activityRow(firstRow + index)
  ).join('');

  return `<section class="activity-page" data-page="${pageNumber}"><div class="activity-page-label"><strong>DAILY MAINTENANCE REPORT</strong><span>Activity page ${pageNumber} · rows ${firstRow}–${firstRow + ACTIVITY_ROWS_PER_PAGE - 1}</span></div><table class="activity-table">${activityHeader()}<tbody>${rows}</tbody></table></section>`;
}

function partRow(number) {
  return `<tr><td class="row-number">${number}</td><td><input data-part="description" aria-label="Part description ${number}"></td><td><input data-part="number" aria-label="Part number ${number}"></td><td><input data-part="quantity" aria-label="Part quantity ${number}" type="number" min="0" step="any"></td><td><input data-part="remarks" aria-label="Part remarks ${number}"></td></tr>`;
}

function message(text, isError = false) {
  const target = document.getElementById('form-message');
  target.textContent = text;
  target.style.color = isError ? '#c92532' : '#19724b';
}

function dateForInput(date) {
  return date.toISOString().slice(0, 10);
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

function setRegisteredEquipment(row, equipment) {
  row.dataset.registered = 'true';
  row.dataset.equipmentId = equipment.equipment_id;
  row.dataset.plantId = equipment.plant_id || '';
  row.dataset.lineId = equipment.line_id || '';
  const code = row.querySelector('[data-field="code"]');
  const name = row.querySelector('[data-field="name"]');
  const line = row.querySelector('[data-field="line"]');
  code.value = equipment.equipment_code;
  name.value = equipment.equipment_name;
  name.readOnly = true;
  line.value = equipment.line_name || equipment.line_id || '';
  line.readOnly = true;
  name.classList.add('found');
  name.classList.remove('manual');
  updatePlantSummary();
}

function setManualEquipment(row) {
  row.dataset.registered = 'false';
  row.dataset.equipmentId = '';
  row.dataset.plantId = '';
  row.dataset.lineId = '';
  const name = row.querySelector('[data-field="name"]');
  const line = row.querySelector('[data-field="line"]');
  name.readOnly = false;
  line.readOnly = false;
  name.classList.remove('found');
  name.classList.add('manual');
  updatePlantSummary();
}

async function lookupEquipment(row) {
  const code = row.querySelector('[data-field="code"]').value.trim();
  if (!code) {
    setManualEquipment(row);
    return;
  }
  message('Looking up equipment code…');
  try {
    const result = await apiRequest(`/equipment/lookup?code=${encodeURIComponent(code)}`);
    if (result.matches.length === 1) {
      setRegisteredEquipment(row, result.matches[0]);
      message(`Registered equipment found: ${result.matches[0].equipment_name}`);
    } else if (result.matches.length > 1) {
      setManualEquipment(row);
      message('More than one registered item has this code. Enter its line to identify it.', true);
    } else {
      setManualEquipment(row);
      message('Equipment is not registered. Enter its name and line as a manual report entry.');
    }
  } catch (error) {
    setManualEquipment(row);
    message(`Cannot look up equipment: ${error.message}`, true);
  }
}

function updatePlantSummary() {
  const plants = [...document.querySelectorAll('#activity-pages tr[data-registered="true"]')]
    .map(row => row.dataset.plantId)
    .filter(Boolean);
  document.getElementById('plant-summary').value = [...new Set(plants)].join(', ') || '';
}

function bindActivityInputs(scope) {
  scope.querySelectorAll('.equipment-code').forEach(input => {
    input.addEventListener('input', () => setManualEquipment(input.closest('tr')));
    input.addEventListener('change', () => lookupEquipment(input.closest('tr')));
  });
  scope.querySelectorAll('.time').forEach(input => {
    ['input', 'change', 'blur'].forEach(event => {
      input.addEventListener(event, () => calculateRowDowntime(input.closest('tr')));
    });
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
    if (!code || !name || !get('type')) {
      throw new Error(`Activity row ${row.dataset.row}: code, machine name, and maintenance type are required.`);
    }
    const start = get('start') || null;
    const end = get('end') || null;
    activities.push({
      equipment_id: row.dataset.registered === 'true' ? row.dataset.equipmentId : null,
      equipment_code: code,
      equipment_name: name,
      plant_id: row.dataset.registered === 'true' ? row.dataset.plantId || null : null,
      line_id: row.dataset.registered === 'true' ? row.dataset.lineId || null : get('line') || null,
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
      spare_parts: parts,
      maintenance_completed: true,
    });
    serializedActivityRows.push(row);
  }
  if (!activities.length) throw new Error('Enter at least one maintenance activity.');
  return activities;
}

async function saveReport(submit) {
  if (currentReport) {
    if (!submit) {
      message('This report is already saved as a draft. You can now send it for engineer approval.');
      return;
    }
    try {
      message('Sending daily report for engineer approval…');
      await apiRequest(`/daily-reports/${encodeURIComponent(currentReport.report_id)}/submit`, { method: 'POST' });
      document.getElementById('report-state').textContent = 'Submitted for engineer approval';
      document.getElementById('submit-report').disabled = true;
      message('Report sent to the maintenance engineer for approval.');
    } catch (error) {
      message(error.message || 'Could not submit the daily report.', true);
    }
    return;
  }

  try {
    const payload = {
      report_date: document.getElementById('report-date').value,
      shift: document.getElementById('shift').value,
      shift_engineer: document.getElementById('shift-engineer').value.trim() || null,
      general_notes: document.getElementById('general-notes').value.trim() || null,
      items: serializeActivities(),
    };
    if (!payload.report_date) throw new Error('Report date is required.');
    message('Saving daily report…');
    const response = await apiRequest('/daily-reports', { method: 'POST', body: JSON.stringify(payload) });
    currentReport = response.report;
    document.getElementById('report-number').textContent = currentReport.report_id;
    document.getElementById('report-state').textContent = currentReport.status;
    response.items.forEach((item, index) => {
      const row = serializedActivityRows[index];
      if (row && item.wo_id) row.querySelector('[data-field="wo"]').value = item.wo_id;
    });
    if (submit) {
      await apiRequest(`/daily-reports/${encodeURIComponent(currentReport.report_id)}/submit`, { method: 'POST' });
      document.getElementById('report-state').textContent = 'Submitted for engineer approval';
      message('Report sent to the maintenance engineer for approval.');
    } else {
      message('Draft saved successfully. You can now submit it for engineer approval.');
    }
    document.getElementById('save-draft').disabled = true;
    document.getElementById('submit-report').disabled = submit;
  } catch (error) {
    message(error.message || 'Could not save the daily report.', true);
  }
}

async function initializeForm() {
  if (!getSavedUser()) return location.replace('login.html');
  try {
    currentUser = await getCurrentUser();
    if (currentUser.role !== 'TECHNICIAN') {
      message('Daily Report entry is available to a Technician account. Select a technician account to submit a report.', true);
    }
    document.getElementById('technician-name').value = currentUser.full_name || 'Technician';
  } catch (_) {
    logout();
    return location.replace('login.html');
  }

  const today = dateForInput(new Date());
  document.getElementById('report-date').value = today;
  document.getElementById('meta-date').textContent = new Date().toLocaleDateString('en-GB');
  const pages = document.getElementById('activity-pages');
  pages.innerHTML = activityPage(1);
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
}

document.addEventListener('DOMContentLoaded', initializeForm);
