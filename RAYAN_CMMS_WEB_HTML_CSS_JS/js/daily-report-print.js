function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = value == null || value === '' ? '—' : String(value);
  return node.innerHTML;
}

function clock(value) {
  return value ? String(value).slice(0, 5) : '—';
}

function reportParts(raw) {
  return String(raw || '').split('\n').map((line) => line.trim()).filter(Boolean).map((line, index) => {
    const [description, number, quantity] = line.split('|').map((value) => value.trim());
    return `<tr><td class="lube-no">${index + 1}</td><td>${escapeHtml(description)}</td><td>${escapeHtml(number?.replace(/^No:\s*/i, ''))}</td><td>${escapeHtml(quantity?.replace(/^Qty:\s*/i, ''))}</td></tr>`;
  }).join('') || '<tr><td class="lube-no">1</td><td>—</td><td>—</td><td>—</td></tr>';
}

function activityRows(items, plants, lines) {
  return items.map((item, index) => {
    const lineRecord = lines.find((row) => row.line_id === item.line_id);
    const line = item.line_name || lineRecord?.name || item.entered_line_number || lineRecord?.line_number || item.line_number;
    const plant = item.plant_name || plants.find((row) => row.plant_id === (item.plant_id || lineRecord?.plant_id))?.name || item.plant_id;
    const machine = `<div class="lube-machine"><input value="${escapeHtml(item.equipment_code || item.equipment_id)}" readonly><input value="${escapeHtml(item.equipment_name)}" readonly><span>${escapeHtml(plant)}</span><input value="${escapeHtml(line)}" readonly></div>`;
    const work = `<div class="daily-work"><input value="${escapeHtml(item.failure_reason)}" readonly><input value="${escapeHtml(item.action_taken)}" readonly></div>`;
    const downtime = item.downtime_h == null ? '—' : `${Number(item.downtime_h).toFixed(2)} h`;
    return `<tr><td class="lube-no">${index + 1}</td><td class="lube-machine-cell">${machine}</td><td>${escapeHtml(item.maintenance_type)}</td><td>${work}</td><td>${clock(item.downtime_start || item.maintenance_start)}</td><td>${clock(item.downtime_end || item.maintenance_end)}</td><td>${escapeHtml(downtime)}</td></tr>`;
  }).join('') || '<tr><td class="lube-no">1</td><td colspan="6">—</td></tr>';
}

function reportMarkup(report, items, formNo, plantName, photos, plants, lines) {
  const technician = report.technician_name || report.technician_id;
  const total = items.reduce((sum, item) => sum + (Number(item.downtime_h) || 0), 0);
  const spareParts = items.find((item) => item.spare_parts)?.spare_parts || '';
  const metadata = `<div class="lube-meta"><label><span>Shift</span><input value="${escapeHtml(report.shift)}" readonly></label><label><span>Technician's name</span><input value="${escapeHtml(technician)}" readonly></label><label><span>Date</span><input value="${escapeHtml(String(report.report_date || '').slice(0, 10))}" readonly></label></div>`;
  const activity = `<div class="sheet-scroll"><table class="lube-table"><thead><tr><th>Seq.</th><th>Machine</th><th>Maintenance Type</th><th>Repair Actions</th><th>Start Time</th><th>End Time</th><th>Downtime (hrs)</th></tr></thead><tbody id="daily-rows">${activityRows(items, plants, lines)}</tbody></table></div>`;
  const parts = `<section class="daily-parts"><h3>SPARE PARTS USED</h3><div class="sheet-scroll"><table class="lube-table"><thead><tr><th>No.</th><th>Part</th><th>Part No.</th><th>Qty</th></tr></thead><tbody>${reportParts(spareParts)}</tbody></table></div></section>`;
  const notes = `<label class="daily-notes"><span>GENERAL NOTES</span><div class="daily-note-box"><textarea readonly>${escapeHtml(report.general_notes || '')}</textarea><b class="daily-tdt">TDT: <span>${total.toFixed(2)} h</span></b></div></label>`;
  return `<section class="daily-paper selected-report"><header class="lube-head"><img src="logo-rayan.png?v=4" alt="Rayan"><div><h2>DAILY MAINTENANCE REPORT</h2><p>${escapeHtml(report.status)}</p><small>Mechanical Maintenance Department</small></div><dl><div><dt>Form No.:</dt><dd>${escapeHtml(formNo)}</dd></div><div><dt>Approved by</dt><dd>${escapeHtml(String(report.approved_by || '').trim())}</dd></div></dl></header><div class="report-number">Report No.: ${escapeHtml(report.report_id)} <span>Plant: ${escapeHtml(plantName)}</span></div>${metadata}${activity}${parts}${notes}${photos}</section>`;
}

async function photoPages(reportId, photos) {
  const pages = [];
  for (const photo of photos) {
    const blob = await apiRequest(`/daily-reports/${encodeURIComponent(reportId)}/photos/${photo.id}`, { blob: true });
    const sized = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const image = new Image();
      image.onload = () => resolve({ url, width: image.naturalWidth || 1, height: image.naturalHeight || 1 });
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('The photo could not be read.')); };
      image.src = url;
    });
    pages.push(`<section class="report-photo-page${sized.width > sized.height ? ' landscape' : ''}"><img src="${sized.url}" alt=""></section>`);
  }
  return pages.join('');
}

async function loadPrintReport() {
  const query = new URLSearchParams(location.search);
  const reportIds = query.getAll('report').concat((query.get('reports') || '').split(',').filter(Boolean));
  if (!reportIds.length) throw new Error('Report number is missing.');

  const [plants, forms, lines] = await Promise.all([apiRequest('/plants'), apiRequest('/form-numbers').catch(() => ({})), apiRequest('/lines').catch(() => [])]);
  const paper = document.getElementById('print-paper');
  const rendered = [];
  for (const reportId of reportIds) {
    const data = await apiRequest(`/daily-reports/${encodeURIComponent(reportId)}`);
    const report = data.report;
    if (report.status !== 'Approved') throw new Error(`Report ${report.report_id} must be approved before export.`);
    const items = data.items || [];
    const plantId = report.plant_id || items[0]?.plant_id || '';
    const plantName = plants.find((plant) => plant.plant_id === plantId)?.name || plantId || '—';
    const photos = await photoPages(report.report_id, data.photos || []);
    rendered.push(reportMarkup(report, items, forms.daily || 'DR', plantName, photos, plants, lines));
  }
  paper.classList.toggle('single-sheet', rendered.length === 1);
  paper.innerHTML = rendered.join('');
  document.getElementById('print-message').textContent = rendered.length === 1 ? `Approved report: ${reportIds[0]}` : `Approved reports: ${reportIds.length}`;
  if (query.get('autoprint') === '1') {
    await Promise.all([...paper.querySelectorAll('img')].map((image) => image.complete ? Promise.resolve() : new Promise((resolve) => {
      image.addEventListener('load', resolve, { once: true });
      image.addEventListener('error', resolve, { once: true });
      setTimeout(resolve, 2500);
    })));
    setTimeout(() => window.print(), 300);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadPrintReport().catch((error) => {
    document.getElementById('print-message').textContent = error.message;
  });
});
