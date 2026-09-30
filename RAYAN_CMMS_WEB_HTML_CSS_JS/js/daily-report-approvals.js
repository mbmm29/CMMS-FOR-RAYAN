let reports = [];
let activeReport = null;

function showDetail(report) {
  activeReport = report;
  const firstItem = report.items?.[0];
  document.getElementById('approval-detail').innerHTML = `<h3>${report.report.report_id}</h3><p><b>Technician:</b> ${report.report.technician_id}<br><b>Date:</b> ${report.report.report_date}<br><b>Activities:</b> ${report.items.length}<br><b>First equipment:</b> ${firstItem?.equipment_name || firstItem?.equipment_code || '—'}<br><b>Notes:</b> ${report.report.general_notes || '—'}</p><div class="actions"><button class="button primary" id="approve-button">Approve &amp; Print</button><button class="button danger" id="return-button">Return</button></div>`;
  document.getElementById('approve-button').addEventListener('click', approveActive);
  document.getElementById('return-button').addEventListener('click', returnActive);
}

async function approveActive() {
  if (!activeReport) return;
  try {
    await apiRequest(`/daily-reports/${encodeURIComponent(activeReport.report.report_id)}/approve`, { method: 'POST' });
    window.open(`daily-report-print.html?report=${encodeURIComponent(activeReport.report.report_id)}`, '_blank');
    document.getElementById('approval-detail').innerHTML = '<p>Report approved. The print view opened in a new tab.</p>';
    await loadInbox();
  } catch (error) {
    document.getElementById('approval-detail').innerHTML = `<p class="error">${error.message}</p>`;
  }
}

async function returnActive() {
  if (!activeReport) return;
  const reason = window.prompt('Reason for returning this report to the technician:');
  if (reason === null) return;
  try {
    await apiRequest(`/daily-reports/${encodeURIComponent(activeReport.report.report_id)}/return?reason=${encodeURIComponent(reason)}`, { method: 'POST' });
    document.getElementById('approval-detail').innerHTML = '<p>Report returned to the technician.</p>';
    await loadInbox();
  } catch (error) {
    document.getElementById('approval-detail').innerHTML = `<p class="error">${error.message}</p>`;
  }
}

async function loadInbox() {
  const body = document.getElementById('approval-rows');
  try {
    const items = await apiRequest('/daily-reports?status=Submitted');
    reports = await Promise.all(items.map(item => apiRequest(`/daily-reports/${encodeURIComponent(item.report_id)}`)));
    body.innerHTML = reports.length ? reports.map((data, index) => `<tr><td class="code">${data.report.report_id}</td><td>${data.report.report_date}</td><td>${data.report.technician_id}</td><td>${data.report.shift || '—'}</td><td>${data.items[0]?.equipment_name || data.items[0]?.equipment_code || '—'}</td><td><button class="button" data-report-index="${index}">Review</button></td></tr>`).join('') : '<tr><td colspan="6">No submitted reports are awaiting approval.</td></tr>';
    body.querySelectorAll('[data-report-index]').forEach(button => button.addEventListener('click', () => showDetail(reports[Number(button.dataset.reportIndex)])));
  } catch (error) { body.innerHTML = `<tr><td colspan="6" class="error">${error.message}</td></tr>`; }
}

document.addEventListener('DOMContentLoaded', async () => {
  if (!getSavedUser()) return location.replace('login.html');
  try {
    const user = await getCurrentUser();
    if (!['SYSTEM_DEVELOPER', 'MAINTENANCE_ENGINEER'].includes(user.role)) throw new Error('Only a maintenance engineer can approve daily reports.');
    document.getElementById('account-name').textContent = `${user.full_name} · ${user.role.replaceAll('_', ' ')}`;
    loadInbox();
  } catch (error) { document.getElementById('approval-rows').innerHTML = `<tr><td colspan="6" class="error">${error.message}</td></tr>`; }
});
