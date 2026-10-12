let motorCatalog = null;
let motorSheets = [];
let motorDayTimer = 0;
const motorUi = { group: 'pm', place: 'sheet', date: '', id: '', query: '' };

function plantClock(options) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Baghdad', ...options }).formatToParts(new Date());
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function plantToday() {
  const value = plantClock({ year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${value.year}-${value.month}-${value.day}`;
}

function msUntilPlantMidnight() {
  const value = plantClock({ hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const hour = Number(value.hour) % 24;
  const minute = Number(value.minute);
  const second = Number(value.second);
  return ((23 - hour) * 3600 + (59 - minute) * 60 + (60 - second)) * 1000;
}

function armMotorMidnight() {
  window.clearTimeout(motorDayTimer);
  motorDayTimer = window.setTimeout(() => {
    motorUi.date = plantToday();
    motorUi.id = '';
    motorUi.group = 'pm';
    motorUi.place = 'sheet';
    drawMotorCondition();
  }, Math.max(1000, msUntilPlantMidnight()));
}

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
      plant_id: item.plant_id || '',
      line_id: item.line_id || '',
      section_id: item.section_id || '',
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
      plant_id: row.plant_id || '',
      line_id: row.line_id || '',
      section_id: row.section_id || '',
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

function motorPageFilters() {
  if (typeof currentFilters !== 'function') return { plantId: '', lineId: '', sectionId: '', equipmentId: '' };
  return currentFilters();
}

function motorScope(row, scope) {
  const filter = scope || motorPageFilters();
  if (filter.plantId && row.plant_id !== filter.plantId) return false;
  if (filter.lineId && row.line_id !== filter.lineId) return false;
  if (filter.sectionId && row.section_id !== filter.sectionId) return false;
  if (filter.equipmentId && row.equipment_id !== filter.equipmentId) return false;
  return true;
}

function motorSheetInScope(sheet) {
  const filter = motorPageFilters();
  const has = (list, id) => !id || (sheet[list] || []).includes(id);
  return has('plant_ids', filter.plantId) && has('line_ids', filter.lineId) && has('section_ids', filter.sectionId) && has('equipment_ids', filter.equipmentId);
}

function motorVisibleSheets() {
  const query = motorUi.query.trim().toLowerCase();
  return motorSheets.filter((sheet) => motorSheetInScope(sheet) && (!query || motorReportText(sheet).includes(query)));
}

function motorReportButton(sheet, selected) {
  const names = sheet.equipment || [];
  const shown = names.slice(0, 2).join(' · ');
  const more = names.length > 2 ? ` +${names.length - 2}` : '';
  const detail = [sheet.inspector_name, shown].filter(Boolean).join(' · ');
  const remove = typeof canMaintain === 'function' && canMaintain()
    ? `<button type="button" class="motor-delete" data-motor-delete="${esc(sheet.report_id)}">${esc(t('Delete'))}</button>`
    : '';
  return `<div class="motor-report-row"><button type="button" class="lube-open${selected ? ' selected' : ''}" data-motor-sheet="${esc(sheet.report_id)}"><b>${esc(fmtDate(sheet.report_date))}</b>${detail ? `<small>${esc(detail)}${esc(more)}</small>` : ''}</button>${remove}</div>`;
}

async function deleteMotorReport(reportId) {
  if (typeof canMaintain === 'function' && !canMaintain()) return;
  if (!reportId) return;
  if (!window.confirm(t('Delete this motor report?'))) return;
  try {
    await apiRequest(`/motor-condition/${encodeURIComponent(reportId)}`, { method: 'DELETE' });
    if (motorUi.id === reportId) motorUi.id = '';
    toast(t('Deleted.'));
    await drawMotorCondition();
  } catch (error) {
    toast(t(error.message));
  }
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
  list.querySelectorAll('[data-motor-delete]').forEach((button) => button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    deleteMotorReport(button.dataset.motorDelete);
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

function motorTempText(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  const text = Number.isInteger(number) ? String(number) : String(Math.round(number * 10) / 10);
  return `${text}°C`;
}

function motorMachineLabel(row) {
  if (!row) return '';
  const code = row.equipment_id || '';
  const name = row.name && row.name !== code ? row.name : '';
  return [code, name].filter(Boolean).join(' · ');
}

function motorUseCard(title, row, emptyKey, tone) {
  if (!row) {
    return `<article class="motor-spot ${tone}"><h3>${esc(t(title))}</h3><b>—</b><span>${esc(t(emptyKey))}</span></article>`;
  }
  const qty = Number(row.quantity);
  const value = Number.isFinite(qty) && qty > 0
    ? (Number.isInteger(qty) ? String(qty) : String(Math.round(qty * 1000) / 1000))
    : `${row.times || 0} ${t('times')}`;
  return `<article class="motor-spot ${tone}"><h3>${esc(t(title))}</h3><b>${esc(value)}</b><span>${esc(motorMachineLabel(row))}</span></article>`;
}

function motorHighlights(data) {
  const hottest = data?.hottest;
  const five = data?.hottest_five || [];
  const rows = five.map((row, index) => `<li><b>${index + 1}</b><span>${esc(motorMachineLabel(row))}</span><em>${esc(motorTempText(row.temperature))}</em></li>`).join('');
  const list = rows || `<li class="motor-empty">${esc(t('No temperature readings yet.'))}</li>`;
  return `<section class="motor-highlights"><article class="motor-spot hot"><h3>${esc(t('Hottest machine'))}</h3><b>${esc(hottest ? motorTempText(hottest.temperature) : '—')}</b><span>${esc(hottest ? motorMachineLabel(hottest) : t('No temperature readings yet.'))}</span></article><article class="motor-rank"><h3>${esc(t('Top 5 hottest machines'))}</h3><ol>${list}</ol></article>${motorUseCard('Most oil used', data?.most_oil, 'No oil changes yet.', 'oil')}${motorUseCard('Most grease used', data?.most_grease, 'No grease changes yet.', 'grease')}</section>`;
}

function motorTempsMissing(row) {
  return !String(row?.temp_1 || '').trim() && !String(row?.temp_2 || '').trim();
}

function motorTempMark() {
  const label = t('Temperature was not recorded');
  return `<span class="temp-missing no-print" title="${esc(label)}" aria-label="${esc(label)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2.5a3.2 3.2 0 0 0-3.2 3.2v7.2a5 5 0 1 0 6.4 0V5.7A3.2 3.2 0 0 0 12 2.5zm0 2.2a1 1 0 0 1 1 1v7.7l.5.4a2.8 2.8 0 1 1-3 0l.5-.4V5.7a1 1 0 0 1 1-1z"/></svg></span>`;
}

function refreshMotorTempIcon(row) {
  if (!row) return;
  const first = row.querySelector('[data-motor="temp_1"]')?.value.trim() || '';
  const second = row.querySelector('[data-motor="temp_2"]')?.value.trim() || '';
  row.classList.toggle('needs-temp', !first && !second);
}

function bindMotorTempIcons(form) {
  form?.addEventListener('input', (event) => {
    const name = event.target?.dataset?.motor;
    if (name === 'temp_1' || name === 'temp_2') refreshMotorTempIcon(event.target.closest('tr'));
  });
}

function motorTableRow(row, index, extraClass) {
  const cell = (label, inner) => `<td data-label="${esc(t(label))}">${inner}</td>`;
  const identity = `<input type="hidden" data-motor="equipment_id" value="${esc(row.equipment_id || '')}">`;
  const classes = [extraClass, motorTempsMissing(row) ? 'needs-temp' : ''].filter(Boolean).join(' ');
  const number = `<span class="motor-id">${motorTempMark()}${identity}${motorLocked('equipment_code', index, row.equipment_id)}</span>`;
  return `<tr${classes ? ` class="${classes}"` : ''}>${cell('Equipment number', number)}${cell('Equipment name', motorLocked('machine', index, row.name))}${cell('Plant', motorLocked('plant', index, row.plant))}${cell('Line', motorLocked('line_number', index, row.line_number))}${cell('Temperature 1', motorField('temp_1', index, row.temp_1, 'inputmode="decimal"'))}${cell('Temperature 2', motorField('temp_2', index, row.temp_2, 'inputmode="decimal"'))}${cell('Oil level', motorChoice('oil_level', row.oil_level || '', [['good', 'Oil good'], ['add', 'Needs adding']]))}${cell('Oil condition', motorChoice('oil_condition', row.oil_condition || '', [['good', 'Oil good'], ['critical', 'Oil critical'], ['change', 'Needs replacement']]))}${cell('Inspection time', motorField('inspection_time', index, row.inspection_time, 'type="time"'))}</tr>`;
}

async function drawMotorCondition() {
  if (!motorCatalog) motorCatalog = await apiRequest('/motor-condition/catalog');
  motorSheets = await apiRequest('/motor-condition');
  if (!motorUi.date) motorUi.date = plantToday();
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
  const scope = motorPageFilters();
  const highlightQuery = new URLSearchParams();
  if (scope.plantId) highlightQuery.set('plant_id', scope.plantId);
  if (scope.lineId) highlightQuery.set('line_id', scope.lineId);
  if (scope.sectionId) highlightQuery.set('section_id', scope.sectionId);
  if (scope.equipmentId) highlightQuery.set('equipment_id', scope.equipmentId);
  const highlightPath = `/motor-condition/highlights${highlightQuery.toString() ? `?${highlightQuery}` : ''}`;
  let highlights = { hottest: null, hottest_five: [], most_oil: null, most_grease: null };
  try {
    highlights = await apiRequest(highlightPath);
  } catch (_) {
    highlights = { hottest: null, hottest_five: [], most_oil: null, most_grease: null };
  }
  const ready = motorReadyRows(due, current?.readings || []);
  const matched = ready.filter((row) => motorScope(row, scope));
  const kept = ready.filter((row) => !motorScope(row, scope));
  const recorded = matched.filter((row) => row.temp_1 || row.temp_2 || row.oil_level || row.oil_condition || row.inspection_time).length;
  document.getElementById('metric-grid').innerHTML = `${metrics([
    ['Machines', String(matched.length), '⚙', 'blue', ''],
    ['Recorded', String(recorded), '✓', 'green', ''],
    ['Reports', String(motorVisibleSheets().length), '▤', 'purple', ''],
  ])}${motorHighlights(highlights)}`;
  const emptyNote = ready.length ? 'No equipment matches this filter.' : 'No equipment is scheduled from preventive maintenance for this day.';
  const rows = `${matched.length ? matched.map(motorTableRow).join('') : `<tr><td class="live-note" colspan="9">${esc(t(emptyNote))}</td></tr>`}${kept.map((row, index) => motorTableRow(row, index + 1000, 'motor-kept')).join('')}`;
  const openToday = motorUi.date === plantToday();
  const dayNote = openToday
    ? 'This report can be updated until midnight. A new form opens at 12:00 AM.'
    : "This day's report is closed. A new form opens at 12:00 AM.";
  const inspector = current?.inspector_name || getSavedUser()?.full_name || '';
  const groupKey = current?.group_key || motorUi.group || 'pm';
  const placeKey = current?.place_key || motorUi.place || 'sheet';
  document.getElementById('workspace').className = 'workspace lube-board';
  document.getElementById('workspace').innerHTML = `${typeof filtersHtml === 'function' ? filtersHtml() : ''}<aside class="panel lube-list motor-reports"><div class="lube-list-head"><b>${esc(t('Reports'))}</b><button type="button" class="detail-button" id="motor-new">${esc(t('New report'))}</button></div><label class="daily-filter"><span>${esc(t('Search reports'))}</span><input id="motor-search" type="search" value="${esc(motorUi.query)}" placeholder="${esc(t('Date, equipment, plant, or inspector'))}"></label><div id="motor-sheet-list"></div></aside><form id="motor-form" class="lube-paper daily-paper motor-paper" data-report-id="${esc(current?.report_id || '')}"><header class="lube-head"><img src="logo-rayan.png?v=2" alt="Rayan"><div><h2>${esc(t('Motor condition'))}</h2><p>${esc(t(motorCatalog.inspection))}</p><small>${esc(t('Mechanical Maintenance Department'))}</small></div><dl><div><dt>${esc(t('Form No.:'))}</dt><dd>${esc(motorCatalog.form_no)}</dd></div><div><dt>${esc(t('Rev.'))}</dt><dd>${esc(motorCatalog.revision)}</dd></div></dl></header><div class="lube-meta"><label><span>${esc(t('Date'))}</span><input id="motor-date" type="date" value="${esc(motorUi.date)}" required></label><label><span>${esc(t('Inspector'))}</span><input id="motor-inspector" value="${esc(inspector)}" required></label></div><p class="motor-day no-print">${esc(t(dayNote))}</p><input type="hidden" id="motor-group" value="${esc(groupKey)}"><input type="hidden" id="motor-place" value="${esc(placeKey)}"><div class="sheet-scroll"><table class="lube-table motor-table"><colgroup><col class="m-code"><col class="m-name"><col class="m-plant"><col class="m-line"><col class="m-temp"><col class="m-temp"><col class="m-oil"><col class="m-oil"><col class="m-time"></colgroup><thead><tr><th>${esc(t('Equipment number'))}</th><th>${esc(t('Equipment name'))}</th><th>${esc(t('Plant'))}</th><th>${esc(t('Line'))}</th><th>${esc(t('Temperature 1'))}</th><th>${esc(t('Temperature 2'))}</th><th>${esc(t('Oil level'))}</th><th>${esc(t('Oil condition'))}</th><th>${esc(t('Inspection time'))}</th></tr></thead><tbody>${rows}</tbody></table></div><label class="daily-notes"><span>${esc(t('General notes'))}</span><textarea id="motor-notes">${esc(current?.notes || '')}</textarea></label>${current && typeof canMaintain === 'function' && canMaintain() ? `<div class="lube-actions no-print"><button type="button" class="detail-button danger" id="motor-delete">${esc(t('Delete'))}</button></div>` : ''}<p id="motor-error" class="form-error"></p></form>`;
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
    motorUi.date = plantToday();
    drawMotorCondition();
  });
  paintMotorReports(current?.report_id || '');
  if (typeof bindFilters === 'function') bindFilters();
  document.getElementById('motor-delete')?.addEventListener('click', () => {
    const reportId = document.getElementById('motor-form')?.dataset.reportId || '';
    if (reportId) deleteMotorReport(reportId);
  });
  document.getElementById('motor-search').addEventListener('input', (event) => {
    motorUi.query = event.target.value;
    paintMotorReports(current?.report_id || '');
  });
  const motorForm = document.getElementById('motor-form');
  bindMotorTempIcons(motorForm);
  motorForm.addEventListener('submit', (event) => {
    event.preventDefault();
    saveMotorCondition();
  });
  if (!openToday) {
    document.querySelectorAll('#motor-form input, #motor-form select, #motor-form textarea').forEach((node) => {
      if (node.id !== 'motor-date') node.disabled = true;
    });
  }
  armMotorMidnight();
}

async function saveMotorCondition() {
  const form = document.getElementById('motor-form');
  const error = document.getElementById('motor-error');
  if (!form) return;
  if (document.getElementById('motor-date').value !== plantToday()) {
    if (error) error.textContent = t("This day's report is closed. A new form opens at 12:00 AM.");
    return;
  }
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
