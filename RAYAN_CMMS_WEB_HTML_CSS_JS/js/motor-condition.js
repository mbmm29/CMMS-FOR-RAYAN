let motorCatalog = null;
let motorSheets = [];
const motorUi = { group: 'pm', place: 'sheet', date: '', id: '', query: '' };

function motorGroup(key) {
  return motorCatalog?.groups.find((group) => group.key === key) || null;
}

function motorPlace(groupKey, placeKey) {
  return motorGroup(groupKey)?.places.find((place) => place.key === placeKey) || null;
}

function motorSheetMatch(group, place, day) {
  return motorSheets.find((sheet) => sheet.group_key === group && sheet.place_key === place && sheet.report_date === day) || null;
}

function motorChoice(name, value, options) {
  const choices = [`<option value="">${esc(t('Select'))}</option>`, ...options.map(([key, text]) => `<option value="${esc(key)}"${value === key ? ' selected' : ''}>${esc(t(text))}</option>`)];
  return `<select data-motor="${name}">${choices.join('')}</select>`;
}

function motorKey(row) {
  return row?.equipment_id || String(row?.machine || '').split('—')[0].trim();
}

function motorReadyRows(due, readings) {
  const saved = new Map();
  (readings || []).forEach((row) => {
    const key = motorKey(row);
    if (key) saved.set(key, row);
  });
  const used = new Set();
  const rows = (due || []).map((item) => {
    used.add(item.equipment_id);
    const found = saved.get(item.equipment_id) || {};
    return {
      equipment_id: item.equipment_id,
      name: item.name || '',
      machine: item.label,
      plant: item.plant_name || '',
      line_number: item.line_name || item.line_number || '',
      temp_1: found.temp_1 || '',
      temp_2: found.temp_2 || '',
      oil_level: found.oil_level || '',
      oil_condition: found.oil_condition || '',
      inspection_time: found.inspection_time || '',
    };
  });
  (readings || []).forEach((row) => {
    const key = motorKey(row);
    if (!key || used.has(key)) return;
    used.add(key);
    const machine = String(row.machine || '');
    const named = machine.includes('—') ? machine.split('—').slice(1).join('—').trim() : machine;
    rows.push({
      equipment_id: row.equipment_id || key,
      name: row.name || named,
      machine,
      plant: row.plant || '',
      line_number: row.line_name || row.line_number || '',
      temp_1: row.temp_1 || '',
      temp_2: row.temp_2 || '',
      oil_level: row.oil_level || '',
      oil_condition: row.oil_condition || '',
      inspection_time: row.inspection_time || '',
    });
  });
  return rows;
}

function motorReportText(sheet) {
  return [
    sheet.report_id,
    sheet.report_date,
    fmtDate(sheet.report_date),
    sheet.inspector_name,
    motorSheetLabel(sheet),
    ...(sheet.equipment || []),
    ...(sheet.plants || []),
    ...(sheet.lines || []),
  ].join(' ').toLowerCase();
}

function motorVisibleSheets() {
  const query = motorUi.query.trim().toLowerCase();
  if (!query) return motorSheets;
  return motorSheets.filter((sheet) => motorReportText(sheet).includes(query));
}

function motorReportButton(sheet, selected) {
  const names = sheet.equipment || [];
  const shown = names.slice(0, 2).join(' · ');
  const more = names.length > 2 ? ` +${names.length - 2}` : '';
  const detail = [sheet.inspector_name, shown].filter(Boolean).join(' · ');
  return `<button type="button" class="lube-open${selected ? ' selected' : ''}" data-motor-sheet="${esc(sheet.report_id)}"><b>${esc(fmtDate(sheet.report_date))}</b>${detail ? `<small>${esc(detail)}${esc(more)}</small>` : ''}</button>`;
}

function paintMotorReports(currentId) {
  const list = document.getElementById('motor-sheet-list');
  if (!list) return;
  const visible = motorVisibleSheets();
  if (!motorSheets.length) {
    list.innerHTML = `<p class="live-note">${esc(t('No reports yet.'))}</p>`;
  } else if (!visible.length) {
    list.innerHTML = `<p class="live-note">${esc(t('No matching reports.'))}</p>`;
  } else {
    list.innerHTML = visible.map((sheet) => motorReportButton(sheet, sheet.report_id === currentId)).join('');
  }
  list.querySelectorAll('[data-motor-sheet]').forEach((button) => button.addEventListener('click', () => {
    motorUi.id = button.dataset.motorSheet;
    drawMotorCondition();
  }));
}

function motorSheetLabel(sheet) {
  if (sheet.group_key === 'pm') return t('Preventive maintenance');
  const group = t(motorGroup(sheet.group_key)?.title || sheet.group_key);
  if (!sheet.place_key || sheet.place_key === 'sheet') return group;
  const title = motorPlace(sheet.group_key, sheet.place_key)?.title || sheet.place_key;
  return `${group} · ${t(title)}`;
}

function motorField(name, index, value, extra) {
  return `<input data-motor="${name}" data-row="${index}" ${extra || ''} value="${esc(value || '')}">`;
}

function motorLocked(name, index, value) {
  return `<input data-motor="${name}" data-row="${index}" value="${esc(value || '')}" readonly tabindex="-1">`;
}

function motorTableRow(row, index) {
  const cell = (label, inner) => `<td data-label="${esc(t(label))}">${inner}</td>`;
  const identity = `<input type="hidden" data-motor="equipment_id" value="${esc(row.equipment_id || '')}">`;
  return `<tr>${cell('Equipment number', `${identity}${motorLocked('equipment_code', index, row.equipment_id)}`)}${cell('Equipment name', motorLocked('machine', index, row.name))}${cell('Plant', motorLocked('plant', index, row.plant))}${cell('Line', motorLocked('line_number', index, row.line_number))}${cell('Temperature 1', motorField('temp_1', index, row.temp_1, 'inputmode="decimal"'))}${cell('Temperature 2', motorField('temp_2', index, row.temp_2, 'inputmode="decimal"'))}${cell('Oil level', motorChoice('oil_level', row.oil_level || '', [['good', 'Oil good'], ['add', 'Needs adding']]))}${cell('Oil condition', motorChoice('oil_condition', row.oil_condition || '', [['good', 'Oil good'], ['critical', 'Oil critical'], ['change', 'Needs replacement']]))}${cell('Inspection time', motorField('inspection_time', index, row.inspection_time, 'type="time"'))}</tr>`;
}

async function drawMotorCondition() {
  if (!motorCatalog) motorCatalog = await apiRequest('/motor-condition/catalog');
  motorSheets = await apiRequest('/motor-condition');
  if (!motorUi.date) motorUi.date = isoDate(new Date());
  if (!motorUi.place) motorUi.place = 'sheet';
  if (!motorUi.group) motorUi.group = 'pm';
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
  const due = await apiRequest(`/motor-condition/due?on=${encodeURIComponent(motorUi.date)}`);
  const ready = motorReadyRows(due, current?.readings || []);
  const recorded = ready.filter((row) => row.temp_1 || row.temp_2 || row.oil_level || row.oil_condition || row.inspection_time).length;
  document.getElementById('metric-grid').innerHTML = metrics([
    ['Machines', String(ready.length), '⚙', 'blue', ''],
    ['Recorded', String(recorded), '✓', 'green', ''],
    ['Reports', String(motorSheets.length), '▤', 'purple', ''],
  ]);
  const rows = ready.length
    ? ready.map(motorTableRow).join('')
    : `<tr><td class="live-note" colspan="9">${esc(t('No equipment is scheduled from preventive maintenance for this day.'))}</td></tr>`;
  const inspector = current?.inspector_name || getSavedUser()?.full_name || '';
  const groupKey = current?.group_key || motorUi.group || 'pm';
  const placeKey = current?.place_key || motorUi.place || 'sheet';
  document.getElementById('workspace').className = 'workspace lube-board';
  document.getElementById('workspace').innerHTML = `<aside class="panel lube-list motor-reports"><div class="lube-list-head"><b>${esc(t('Reports'))}</b><button type="button" class="detail-button" id="motor-new">${esc(t('New report'))}</button></div><label class="daily-filter"><span>${esc(t('Search reports'))}</span><input id="motor-search" type="search" value="${esc(motorUi.query)}" placeholder="${esc(t('Date, equipment, plant, or inspector'))}"></label><div id="motor-sheet-list"></div></aside><form id="motor-form" class="lube-paper daily-paper motor-paper" data-report-id="${esc(current?.report_id || '')}"><header class="lube-head"><img src="logo-rayan.png?v=2" alt="Rayan"><div><h2>${esc(t('Motor condition'))}</h2><p>${esc(t(motorCatalog.inspection))}</p><small>${esc(t('Mechanical Maintenance Department'))}</small></div><dl><div><dt>${esc(t('Form No.:'))}</dt><dd>${esc(motorCatalog.form_no)}</dd></div><div><dt>${esc(t('Rev.'))}</dt><dd>${esc(motorCatalog.revision)}</dd></div></dl></header><div class="lube-meta"><label><span>${esc(t('Date'))}</span><input id="motor-date" type="date" value="${esc(motorUi.date)}" required></label><label><span>${esc(t('Inspector'))}</span><input id="motor-inspector" value="${esc(inspector)}" required></label></div><input type="hidden" id="motor-group" value="${esc(groupKey)}"><input type="hidden" id="motor-place" value="${esc(placeKey)}"><div class="sheet-scroll"><table class="lube-table motor-table"><colgroup><col class="m-code"><col class="m-name"><col class="m-plant"><col class="m-line"><col class="m-temp"><col class="m-temp"><col class="m-oil"><col class="m-oil"><col class="m-time"></colgroup><thead><tr><th>${esc(t('Equipment number'))}</th><th>${esc(t('Equipment name'))}</th><th>${esc(t('Plant'))}</th><th>${esc(t('Line'))}</th><th>${esc(t('Temperature 1'))}</th><th>${esc(t('Temperature 2'))}</th><th>${esc(t('Oil level'))}</th><th>${esc(t('Oil condition'))}</th><th>${esc(t('Inspection time'))}</th></tr></thead><tbody>${rows}</tbody></table></div><label class="daily-notes"><span>${esc(t('General notes'))}</span><textarea id="motor-notes">${esc(current?.notes || '')}</textarea></label><p id="motor-error" class="form-error"></p></form>`;
  document.getElementById('motor-date').addEventListener('change', (event) => {
    motorUi.date = event.target.value;
    motorUi.group = 'pm';
    motorUi.place = 'sheet';
    motorUi.id = '';
    drawMotorCondition();
  });
  document.getElementById('motor-new').addEventListener('click', () => {
    motorUi.id = '';
    motorUi.group = 'pm';
    motorUi.place = 'sheet';
    motorUi.date = isoDate(new Date());
    drawMotorCondition();
  });
  paintMotorReports(current?.report_id || '');
  document.getElementById('motor-search').addEventListener('input', (event) => {
    motorUi.query = event.target.value;
    paintMotorReports(current?.report_id || '');
  });
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
      equipment_id: value('equipment_id'),
      machine: value('machine'),
      plant: value('plant'),
      line_number: value('line_number'),
      temp_1: value('temp_1'),
      temp_2: value('temp_2'),
      oil_level: value('oil_level'),
      oil_condition: value('oil_condition'),
      inspection_time: value('inspection_time'),
    };
  }).filter((row) => row.equipment_id && (row.temp_1 || row.temp_2 || row.oil_level || row.oil_condition || row.inspection_time));
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
    toast(t('Motor report saved.'));
    await drawMotorCondition();
  } catch (exception) {
    if (error) error.textContent = t(exception.message);
  }
}
