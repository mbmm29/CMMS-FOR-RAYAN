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
  const reportId = new URLSearchParams(location.search).get('report');
  if (!reportId) throw new Error('Report number is missing.');

  const data = await apiRequest(`/daily-reports/${encodeURIComponent(reportId)}`);
  const report = data.report;
  if (report.status !== 'Approved') throw new Error('This report must be approved before it can be printed.');

  const total = data.items.reduce((sum, item) => sum + (Number(item.downtime_h) || 0), 0);
  const first = data.items[0] || {};
  const pages = activityPages(data.items);
  const technician = report.technician_name || report.technician_id;

  document.getElementById('print-paper').innerHTML = `<header class="report-head"><div class="company-logo"><img src="logo-rayan.png" alt="Rayan"><span>FOR OIL EXTRACTION &amp; FEED MILL</span></div><div class="report-title"><h1>DAILY MAINTENANCE REPORT</h1><h2>Mechanical Maintenance Department</h2></div><dl class="form-meta"><div><dt>Form No.:</dt><dd>${text(report.report_id)}</dd></div><div><dt>Date:</dt><dd>${text(report.report_date)}</dd></div><div><dt>Pages:</dt><dd>1 of ${pages.pageCount}</dd></div></dl></header><section class="report-info"><div class="info-column"><label>Technician's name:<input value="${text(technician)}" readonly></label><label>Date:<input value="${text(report.report_date)}" readonly></label><label>Shift:<input value="${text(report.shift)}" readonly></label></div><div class="info-column"><label>Plant:<input value="${text(first.plant_id)} / ${text(first.line_id)}" readonly></label><label>Maintenance Engineer:<input value="${text(report.approved_by)}" readonly></label><label>Engineer Signature:<span class="signature-line"></span></label></div></section><section class="activity-section">${pages.markup}</section><section class="report-bottom"><table class="parts-table"><thead><tr><th colspan="5">SPARE PARTS USED</th></tr><tr><th>No.</th><th>Part Name / Description</th><th>Part No.</th><th>Qty</th><th>Remarks</th></tr></thead><tbody>${parts(first.spare_parts)}</tbody></table><section class="notes-box"><div class="notes-heading"><b>GENERAL NOTES</b><span>TOTAL DOWNTIME: <output>${total.toFixed(2)}</output> HRS</span></div><textarea readonly>${text(report.general_notes || '').replace(/<br>/g, '\n')}</textarea></section></section>`;
  document.getElementById('print-message').textContent = `Approved report: ${report.report_id}`;
}

document.addEventListener('DOMContentLoaded', () => {
  loadPrintReport().catch(error => {
    document.getElementById('print-message').textContent = error.message;
  });
});
