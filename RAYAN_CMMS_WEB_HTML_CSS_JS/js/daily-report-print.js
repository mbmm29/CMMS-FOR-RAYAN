const PRINT_ROWS_PER_PAGE = 10;

function text(value) {
  const element = document.createElement('span');
  element.textContent = value ?? '—';
  return element.innerHTML;
}

function time(value) {
  return value ? String(value).slice(0, 5) : '—';
}

function parts(value) {
  const values = String(value || '')
    .split('\n')
    .filter(Boolean)
    .map(line => line.split('|').map(part => part.trim()));
  return Array.from({ length: 5 }, (_, index) => {
    const part = values[index] || [];
    const description = part[0] || '—';
    const number = part[1]?.replace(/^No:\s*/i, '') || '—';
    const quantity = part[2]?.replace(/^Qty:\s*/i, '') || '—';
    const remarks = part[3] || '—';
    return `<tr><td class="row-number">${index + 1}</td><td>${text(description)}</td><td>${text(number)}</td><td>${text(quantity)}</td><td>${text(remarks)}</td></tr>`;
  }).join('');
}

function activityHeader() {
  return `<thead><tr><th rowspan="2">No.</th><th rowspan="2">Line</th><th colspan="2">Machine</th><th rowspan="2">Maintenance<br>Type</th><th rowspan="2">Work Order<br>No.</th><th rowspan="2">Failure Reason</th><th rowspan="2">Repair Actions</th><th rowspan="2">Start<br>Time</th><th rowspan="2">End<br>Time</th><th rowspan="2">Downtime<br>(hrs)</th></tr><tr><th>Code</th><th>Name</th></tr></thead>`;
}

function activityRows(items, firstRow) {
  return Array.from({ length: PRINT_ROWS_PER_PAGE }, (_, index) => {
    const item = items[index];
    const downtime = item?.downtime_h == null ? '—' : Number(item.downtime_h).toFixed(2);
    return `<tr><td class="row-number">${firstRow + index}</td><td>${text(item?.line_id)}</td><td>${text(item?.equipment_code || item?.equipment_id)}</td><td>${text(item?.equipment_name)}</td><td>${text(item?.maintenance_type)}</td><td>${text(item?.wo_id)}</td><td>${text(item?.failure_reason)}</td><td>${text(item?.action_taken)}</td><td>${time(item?.downtime_start || item?.maintenance_start)}</td><td>${time(item?.downtime_end || item?.maintenance_end)}</td><td>${downtime}</td></tr>`;
  }).join('');
}

function activityPages(items) {
  const pageCount = Math.max(1, Math.ceil(items.length / PRINT_ROWS_PER_PAGE));
  const pages = Array.from({ length: pageCount }, (_, index) => {
    const firstRow = index * PRINT_ROWS_PER_PAGE + 1;
    const pageItems = items.slice(index * PRINT_ROWS_PER_PAGE, firstRow - 1 + PRINT_ROWS_PER_PAGE);
    return `<section class="activity-page"><div class="activity-page-label"><strong>DAILY MAINTENANCE REPORT</strong><span>Page ${index + 1} of ${pageCount} · rows ${firstRow}–${firstRow + PRINT_ROWS_PER_PAGE - 1}</span></div><table class="activity-table">${activityHeader()}<tbody>${activityRows(pageItems, firstRow)}</tbody></table></section>`;
  }).join('');
  return { markup: pages, pageCount };
}

async function loadPrintReport() {
  const query = new URLSearchParams(location.search);
  const reportIds = query.getAll('report').concat((query.get('reports') || '').split(',').filter(Boolean));
  if (!reportIds.length) throw new Error('Report number is missing.');

  const plants = await apiRequest('/plants');
  const forms = await apiRequest('/form-numbers').catch(() => ({}));
  const dailyFormNo = forms.daily || 'DR';
  const paper = document.getElementById('print-paper');
  const rendered = [];
  for (const reportId of reportIds) {
    const data = await apiRequest(`/daily-reports/${encodeURIComponent(reportId)}`);
    const report = data.report;
    if (report.status !== 'Approved') throw new Error(`Report ${report.report_id} must be approved before export.`);
    const items = data.items || [];
    const total = items.reduce((sum, item) => sum + (Number(item.downtime_h) || 0), 0);
    const first = items[0] || {};
    const pages = activityPages(items);
    const technician = report.technician_name || report.technician_id;
    const plantId = report.plant_id || first.plant_id || '';
    const plantName = plants.find((plant) => plant.plant_id === plantId)?.name || plantId || '—';
    const photoMarkup = await photoPages(report.report_id, data.photos || []);
    rendered.push(`<section class="selected-report"><header class="report-head"><div class="company-logo"><img src="logo-rayan.png?v=2" alt="Rayan"></div><div class="report-title"><h1>DAILY MAINTENANCE REPORT</h1><h2>Mechanical Maintenance Department</h2></div><div class="daily-document-box"><div class="daily-document-row"><span>Form No.:</span><strong>${text(dailyFormNo)}</strong></div><div class="daily-document-row"><span>Approved by</span><strong>${text(String(report.approved_by || '').trim() || '—')}</strong></div></div></header><section class="report-info"><div class="info-column"><label>Technician's name:<input value="${text(technician)}" readonly></label><label>Shift:<input value="${text(report.shift)}" readonly></label></div><div class="info-column"><label>Plant:<input value="${text(plantName)}" readonly></label><label>Report No.:<input value="${text(report.report_id)}" readonly></label></div></section><section class="activity-section">${pages.markup}</section><section class="report-bottom"><table class="parts-table"><thead><tr><th colspan="5">SPARE PARTS USED</th></tr><tr><th>No.</th><th>Part Name / Description</th><th>Part No.</th><th>Qty</th><th>Remarks</th></tr></thead><tbody>${parts(first.spare_parts)}</tbody></table><section class="notes-box"><div class="notes-heading"><b>GENERAL NOTES</b><span>TOTAL DOWNTIME: <output>${total.toFixed(2)}</output> HRS</span></div><textarea readonly>${text(report.general_notes || '').replace(/<br>/g, '\n')}</textarea></section></section>${photoMarkup}</section>`);
  }
  paper.classList.toggle('single-sheet', rendered.length === 1);
  paper.innerHTML = rendered.join('');
  document.getElementById('print-message').textContent = rendered.length === 1 ? `Approved report: ${reportIds[0]}` : `Approved reports: ${reportIds.length}`;
  if (query.get('autoprint') === '1') {
    await Promise.all([...paper.images].map(image => image.complete ? Promise.resolve() : new Promise(resolve => {
      image.addEventListener('load', resolve, { once: true });
      image.addEventListener('error', resolve, { once: true });
      setTimeout(resolve, 2500);
    })));
    setTimeout(() => window.print(), 300);
  }
}

async function photoPages(reportId, photos) {
  const pages = [];
  for (const photo of photos) {
    const blob = await apiRequest(`/daily-reports/${encodeURIComponent(reportId)}/photos/${photo.id}`, { blob: true });
    const sized = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const image = new Image();
      image.onload = () => resolve({ url, width: image.naturalWidth || 1, height: image.naturalHeight || 1 });
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('The photo could not be read.'));
      };
      image.src = url;
    });
    pages.push(`<section class="report-photo-page${sized.width > sized.height ? ' landscape' : ''}"><img src="${sized.url}" alt=""></section>`);
  }
  return pages.join('');
}

document.addEventListener('DOMContentLoaded', () => {
  loadPrintReport().catch(error => {
    document.getElementById('print-message').textContent = error.message;
  });
});
