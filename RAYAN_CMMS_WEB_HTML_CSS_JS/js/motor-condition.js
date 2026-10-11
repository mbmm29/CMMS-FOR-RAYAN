let motorCatalog = null;
let motorSheets = [];
const motorUi = { group: 'A', place: 'feed-1', date: '', id: '' };

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

async function drawMotorCondition() {
  if (!motorCatalog) motorCatalog = await apiRequest('/motor-condition/catalog');
  motorSheets = await apiRequest('/motor-condition');
  const today = isoDate(new Date());
  if (!motorUi.date) motorUi.date = today;
  const group = motorGroup(motorUi.group) || motorCatalog.groups[0];
  motorUi.group = group.key;
  const place = motorPlace(motorUi.group, motorUi.place) || group.places[0];
  motorUi.place = place.key;
  let current = null;
  if (motorUi.id) {
    current = await apiRequest(`/motor-condition/${encodeURIComponent(motorUi.id)}`);
    motorUi.group = current.group_key;
    motorUi.place = current.place_key;
    motorUi.date = current.report_date;
  } else {
    const existing = motorSheetMatch(motorUi.group, motorUi.place, motorUi.date);
    if (existing) current = await apiRequest(`/motor-condition/${encodeURIComponent(existing.report_id)}`);
  }
  const activeGroup = motorGroup(motorUi.group);
  const activePlace = motorPlace(motorUi.group, motorUi.place);
  const saved = Object.fromEntries((current?.readings || []).map((row) => [row.machine, row]));
  const filled = (current?.readings || []).filter((row) => row.temp_1 || row.temp_2 || row.oil_level || row.oil_condition || row.inspection_time).length;
  document.getElementById('metric-grid').innerHTML = metrics([
    ['Machines', String(activePlace.machines.length), '⚙', 'blue', ''],
    ['Recorded', String(filled), '✓', 'green', ''],
    ['Sheets', String(motorSheets.length), '▤', 'purple', ''],
  ]);
  const rows = activePlace.machines.map((machine) => {
    const row = saved[machine] || {};
    return `<tr><th>${esc(machine)}</th><td><input data-motor="temp_1" data-machine="${esc(machine)}" inputmode="decimal" value="${esc(row.temp_1 || '')}"></td><td><input data-motor="temp_2" data-machine="${esc(machine)}" inputmode="decimal" value="${esc(row.temp_2 || '')}"></td><td>${motorChoice('oil_level', row.oil_level || '', [['good', 'Oil good'], ['add', 'Needs adding']])}</td><td>${motorChoice('oil_condition', row.oil_condition || '', [['good', 'Oil good'], ['critical', 'Oil critical'], ['change', 'Needs replacement']])}</td><td><input data-motor="inspection_time" data-machine="${esc(machine)}" type="time" value="${esc(row.inspection_time || '')}"></td></tr>`;
  }).join('');
  const list = motorSheets.map((sheet) => {
    const title = motorPlace(sheet.group_key, sheet.place_key)?.title || sheet.place_key;
    const selected = current && current.report_id === sheet.report_id;
    return `<button type="button" class="lube-open${selected ? ' selected' : ''}" data-motor-sheet="${esc(sheet.report_id)}"><b>${esc(fmtDate(sheet.report_date))}</b><small>${esc(t(motorGroup(sheet.group_key)?.title || sheet.group_key))} · ${esc(t(title))}</small></button>`;
  }).join('') || `<p class="live-note">${esc(t('No motor sheets yet.'))}</p>`;
  const inspector = current?.inspector_name || getSavedUser()?.full_name || '';
  document.getElementById('workspace').className = 'workspace lube-board';
  document.getElementById('workspace').innerHTML = `<aside class="panel lube-list"><div class="lube-list-head"><b>${esc(t('Sheets'))}</b><button type="button" class="detail-button" id="motor-new">${esc(t('New sheet'))}</button></div><div id="motor-sheet-list">${list}</div></aside><form id="motor-form" class="lube-paper daily-paper motor-paper" data-report-id="${esc(current?.report_id || '')}"><header class="lube-head"><img src="logo-rayan.png?v=2" alt="Rayan"><div><h2>${esc(t('Motor condition'))}</h2><p>${esc(t(motorCatalog.inspection))}</p><small>${esc(t('Mechanical Maintenance Department'))}</small></div><dl><div><dt>${esc(t('Form No.:'))}</dt><dd>${esc(motorCatalog.form_no)}</dd></div><div><dt>${esc(t('Rev.'))}</dt><dd>${esc(motorCatalog.revision)}</dd></div></dl></header><div class="lube-meta"><label><span>${esc(t('Group'))}</span><select id="motor-group">${motorOptions(motorCatalog.groups, motorUi.group, (item) => item.title)}</select></label><label><span>${esc(t('Location'))}</span><select id="motor-place">${motorOptions(activeGroup.places, motorUi.place, (item) => item.title)}</select></label><label><span>${esc(t('Date'))}</span><input id="motor-date" type="date" value="${esc(motorUi.date)}" required></label><label><span>${esc(t('Inspection time'))}</span><input id="motor-time" type="time" value="${esc(current?.inspection_time || '')}"></label><label><span>${esc(t('Inspector'))}</span><input id="motor-inspector" value="${esc(inspector)}" required></label><label><span>${esc(t('Frequency'))}</span><input value="${esc(t(motorCatalog.frequency))}" readonly></label></div><div class="sheet-scroll"><table class="lube-table motor-table"><thead><tr><th>${esc(t('Equipment'))}</th><th>${esc(t('Temperature 1'))}</th><th>${esc(t('Temperature 2'))}</th><th>${esc(t('Oil level'))}</th><th>${esc(t('Oil condition'))}</th><th>${esc(t('Inspection time'))}</th></tr></thead><tbody>${rows}</tbody></table></div><label class="daily-notes"><span>${esc(t('General notes'))}</span><textarea id="motor-notes">${esc(current?.notes || '')}</textarea></label><p id="motor-error" class="form-error"></p></form>`;
  document.getElementById('motor-group').addEventListener('change', (event) => {
    motorUi.group = event.target.value;
    motorUi.place = motorGroup(motorUi.group)?.places[0]?.key || '';
    motorUi.id = '';
    drawMotorCondition();
  });
  document.getElementById('motor-place').addEventListener('change', (event) => {
    motorUi.place = event.target.value;
    motorUi.id = '';
    drawMotorCondition();
  });
  document.getElementById('motor-date').addEventListener('change', (event) => {
    motorUi.date = event.target.value;
    motorUi.id = '';
    drawMotorCondition();
  });
  document.getElementById('motor-new').addEventListener('click', () => {
    motorUi.id = '';
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
  const place = motorPlace(document.getElementById('motor-group').value, document.getElementById('motor-place').value);
  const readings = (place?.machines || []).map((machine) => {
    const temp = (name) => form.querySelector(`[data-motor="${name}"][data-machine="${CSS.escape(machine)}"]`)?.value.trim() || '';
    const row = form.querySelector(`[data-machine="${CSS.escape(machine)}"]`)?.closest('tr');
    const select = (name) => row?.querySelector(`[data-motor="${name}"]`)?.value || '';
    return { machine, temp_1: temp('temp_1'), temp_2: temp('temp_2'), oil_level: select('oil_level'), oil_condition: select('oil_condition'), inspection_time: temp('inspection_time') };
  });
  try {
    const saved = await apiRequest('/motor-condition', {
      method: 'PUT',
      body: JSON.stringify({
        report_date: document.getElementById('motor-date').value,
        inspection_time: document.getElementById('motor-time').value,
        inspector_name: document.getElementById('motor-inspector').value.trim(),
        group_key: document.getElementById('motor-group').value,
        place_key: document.getElementById('motor-place').value,
        notes: document.getElementById('motor-notes').value.trim(),
        readings,
      }),
    });
    motorUi.id = saved.report_id;
    motorUi.date = saved.report_date;
    toast(t('Motor sheet saved.'));
    await drawMotorCondition();
  } catch (exception) {
    if (error) error.textContent = exception.message;
  }
}
