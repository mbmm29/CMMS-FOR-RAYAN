let motorCatalog = null;
let motorSheets = [];
const motorUi = { group: 'A', place: 'sheet', date: '', id: '' };
const MOTOR_ROWS = 15;
const MOTOR_ROW_CAP = 40;

function motorGroup(key) {
  return motorCatalog?.groups.find((group) => group.key === key) || null;
}

function motorPlace(groupKey, placeKey) {
  return motorGroup(groupKey)?.places.find((place) => place.key === placeKey) || null;
}

function motorSheetMatch(group, place, day) {
  return motorSheets.find((sheet) => sheet.group_key === group && sheet.place_key === place && sheet.report_date === day) || null;
}

function motorOptions(items, selected, label) {
  return items.map((item) => `<option value="${esc(item.key)}"${item.key === selected ? ' selected' : ''}>${esc(t(label(item)))}</option>`).join('');
}

function motorChoice(name, value, options) {
  const choices = [`<option value="">${esc(t('Select'))}</option>`, ...options.map(([key, text]) => `<option value="${esc(key)}"${value === key ? ' selected' : ''}>${esc(t(text))}</option>`)];
  return `<select data-motor="${name}">${choices.join('')}</select>`;
}

function motorBlank() {
  return { machine: '', plant: '', line_number: '', temp_1: '', temp_2: '', oil_level: '', oil_condition: '', inspection_time: '' };
}

function motorLines(readings) {
  const saved = (readings || []).map((row) => ({
    machine: row.machine || '',
    plant: row.plant || '',
    line_number: row.line_number || '',
    temp_1: row.temp_1 || '',
    temp_2: row.temp_2 || '',
    oil_level: row.oil_level || '',
    oil_condition: row.oil_condition || '',
    inspection_time: row.inspection_time || '',
  }));
  const count = Math.min(MOTOR_ROW_CAP, Math.max(MOTOR_ROWS, saved.length + (saved.length >= MOTOR_ROWS ? 1 : 0)));
  while (saved.length < count) saved.push(motorBlank());
  return saved.slice(0, count);
}

function motorSheetLabel(sheet) {
  const group = t(motorGroup(sheet.group_key)?.title || sheet.group_key);
  if (!sheet.place_key || sheet.place_key === 'sheet') return group;
  const title = motorPlace(sheet.group_key, sheet.place_key)?.title || sheet.place_key;
  return `${group} · ${t(title)}`;
}

function motorField(name, index, value, extra) {
  return `<input data-motor="${name}" data-row="${index}" ${extra || ''} value="${esc(value || '')}">`;
}

function motorTableRow(row, index) {
  return `<tr><td>${motorField('machine', index, row.machine)}</td><td>${motorField('plant', index, row.plant)}</td><td>${motorField('line_number', index, row.line_number)}</td><td>${motorField('temp_1', index, row.temp_1, 'inputmode="decimal"')}</td><td>${motorField('temp_2', index, row.temp_2, 'inputmode="decimal"')}</td><td>${motorChoice('oil_level', row.oil_level || '', [['good', 'Oil good'], ['add', 'Needs adding']])}</td><td>${motorChoice('oil_condition', row.oil_condition || '', [['good', 'Oil good'], ['critical', 'Oil critical'], ['change', 'Needs replacement']])}</td><td>${motorField('inspection_time', index, row.inspection_time, 'type="time"')}</td></tr>`;
}

async function drawMotorCondition() {
  if (!motorCatalog) motorCatalog = await apiRequest('/motor-condition/catalog');
  motorSheets = await apiRequest('/motor-condition');
  const today = isoDate(new Date());
  if (!motorUi.date) motorUi.date = today;
  const group = motorGroup(motorUi.group) || motorCatalog.groups[0];
  motorUi.group = group.key;
  if (!motorUi.place) motorUi.place = 'sheet';
  let current = null;
  if (motorUi.id) {
    current = await apiRequest(`/motor-condition/${encodeURIComponent(motorUi.id)}`);
    motorUi.group = current.group_key;
    motorUi.place = current.place_key || 'sheet';
    motorUi.date = current.report_date;
  } else {
    const existing = motorSheetMatch(motorUi.group, motorUi.place, motorUi.date);
    if (existing) current = await apiRequest(`/motor-condition/${encodeURIComponent(existing.report_id)}`);
  }
  const readings = current?.readings || [];
  const named = readings.filter((row) => row.machine).length;
  const filled = readings.filter((row) => row.temp_1 || row.temp_2 || row.oil_level || row.oil_condition || row.inspection_time).length;
  document.getElementById('metric-grid').innerHTML = metrics([
    ['Machines', String(named), '⚙', 'blue', ''],
    ['Recorded', String(filled), '✓', 'green', ''],
    ['Sheets', String(motorSheets.length), '▤', 'purple', ''],
  ]);
  const rows = motorLines(readings).map(motorTableRow).join('');
  const list = motorSheets.map((sheet) => {
    const selected = current && current.report_id === sheet.report_id;
    return `<button type="button" class="lube-open${selected ? ' selected' : ''}" data-motor-sheet="${esc(sheet.report_id)}"><b>${esc(fmtDate(sheet.report_date))}</b><small>${esc(motorSheetLabel(sheet))}</small></button>`;
  }).join('') || `<p class="live-note">${esc(t('No motor sheets yet.'))}</p>`;
  const inspector = current?.inspector_name || getSavedUser()?.full_name || '';
  const placeKey = current?.place_key || motorUi.place || 'sheet';
  document.getElementById('workspace').className = 'workspace lube-board';
  document.getElementById('workspace').innerHTML = `<aside class="panel lube-list"><div class="lube-list-head"><b>${esc(t('Sheets'))}</b><button type="button" class="detail-button" id="motor-new">${esc(t('New sheet'))}</button></div><div id="motor-sheet-list">${list}</div></aside><form id="motor-form" class="lube-paper daily-paper motor-paper" data-report-id="${esc(current?.report_id || '')}"><header class="lube-head"><img src="logo-rayan.png?v=2" alt="Rayan"><div><h2>${esc(t('Motor condition'))}</h2><p>${esc(t(motorCatalog.inspection))}</p><small>${esc(t('Mechanical Maintenance Department'))}</small></div><dl><div><dt>${esc(t('Form No.:'))}</dt><dd>${esc(motorCatalog.form_no)}</dd></div><div><dt>${esc(t('Rev.'))}</dt><dd>${esc(motorCatalog.revision)}</dd></div></dl></header><div class="lube-meta"><label><span>${esc(t('Group'))}</span><select id="motor-group">${motorOptions(motorCatalog.groups, motorUi.group, (item) => item.title)}</select></label><label><span>${esc(t('Date'))}</span><input id="motor-date" type="date" value="${esc(motorUi.date)}" required></label><label><span>${esc(t('Inspector'))}</span><input id="motor-inspector" value="${esc(inspector)}" required></label></div><input type="hidden" id="motor-place" value="${esc(placeKey)}"><div class="sheet-scroll"><table class="lube-table motor-table"><colgroup><col class="m-equip"><col class="m-plant"><col class="m-line"><col class="m-temp"><col class="m-temp"><col class="m-oil"><col class="m-oil"><col class="m-time"></colgroup><thead><tr><th>${esc(t('Equipment'))}</th><th>${esc(t('Plant'))}</th><th>${esc(t('Line number'))}</th><th>${esc(t('Temperature 1'))}</th><th>${esc(t('Temperature 2'))}</th><th>${esc(t('Oil level'))}</th><th>${esc(t('Oil condition'))}</th><th>${esc(t('Inspection time'))}</th></tr></thead><tbody>${rows}</tbody></table></div><label class="daily-notes"><span>${esc(t('General notes'))}</span><textarea id="motor-notes">${esc(current?.notes || '')}</textarea></label><p id="motor-error" class="form-error"></p></form>`;
  document.getElementById('motor-group').addEventListener('change', (event) => {
    motorUi.group = event.target.value;
    motorUi.place = 'sheet';
    motorUi.id = '';
    drawMotorCondition();
  });
  document.getElementById('motor-date').addEventListener('change', (event) => {
    motorUi.date = event.target.value;
    motorUi.place = 'sheet';
    motorUi.id = '';
    drawMotorCondition();
  });
  document.getElementById('motor-new').addEventListener('click', () => {
    motorUi.id = '';
    motorUi.place = 'sheet';
    motorUi.date = isoDate(new Date());
    drawMotorCondition();
  });
  document.querySelectorAll('[data-motor-sheet]').forEach((button) => button.addEventListener('click', () => {
    motorUi.id = button.dataset.motorSheet;
    drawMotorCondition();
  }));
  document.getElementById('motor-form').addEventListener('submit', (event) => {
    event.preventDefault();
    saveMotorCondition();
  });
}

async function saveMotorCondition() {
  const form = document.getElementById('motor-form');
  const error = document.getElementById('motor-error');
  if (!form) return;
  const readings = [...form.querySelectorAll('tbody tr')].map((row) => {
    const value = (name) => row.querySelector(`[data-motor="${name}"]`)?.value.trim() || '';
    return {
      machine: value('machine'),
      plant: value('plant'),
      line_number: value('line_number'),
      temp_1: value('temp_1'),
      temp_2: value('temp_2'),
      oil_level: value('oil_level'),
      oil_condition: value('oil_condition'),
      inspection_time: value('inspection_time'),
    };
  }).filter((row) => Object.values(row).some(Boolean));
  try {
    const saved = await apiRequest('/motor-condition', {
      method: 'PUT',
      body: JSON.stringify({
        report_date: document.getElementById('motor-date').value,
        inspection_time: '',
        inspector_name: document.getElementById('motor-inspector').value.trim(),
        group_key: document.getElementById('motor-group').value,
        place_key: document.getElementById('motor-place').value || 'sheet',
        notes: document.getElementById('motor-notes').value.trim(),
        readings,
      }),
    });
    motorUi.id = saved.report_id;
    motorUi.place = saved.place_key || 'sheet';
    motorUi.date = saved.report_date;
    toast(t('Motor sheet saved.'));
    await drawMotorCondition();
  } catch (exception) {
    if (error) error.textContent = t(exception.message);
  }
}
