document.addEventListener('DOMContentLoaded', async () => {
  const state = { reports: [], filtered: [], page: 1, rows: 10, status: 'all', user: null, selected: null };
  const body = document.getElementById('reportsTableBody');
  const search = document.getElementById('globalSearch');
  const from = document.getElementById('dateFrom');
  const to = document.getElementById('dateTo');
  const tabs = [...document.querySelectorAll('.report-tab')];

  const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  const formatDate = value => value ? new Date(`${String(value).slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB') : '-';
  const formatDateTime = value => value ? new Date(value).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '-';
  const isEngineer = () => ['SYSTEM_DEVELOPER', 'MAINTENANCE_ENGINEER'].includes(state.user?.role);
  const statusText = status => ({ Submitted: 'Pending Approval', Approved: 'Approved', Returned: 'Returned', Draft: 'Draft' }[status] || status || '-');
  const statusClass = status => ({ Submitted: 'pending', Approved: 'approved', Returned: 'returned', Draft: 'draft' }[status] || 'draft');
  const badge = status => `<span class="status ${statusClass(status)}">${escapeHtml(statusText(status))}</span>`;
  const asHours = value => Number(value || 0).toFixed(2);

  function setText(id, value) { const element = document.getElementById(id); if (element) element.textContent = value; }
  function emptyDetails() {
    state.selected = null;
    document.getElementById('detailsContent').innerHTML = '<div class="empty-details"><div>Report</div><p>Select a report to view its details.</p></div>';
  }

  async function loadReports() {
    body.innerHTML = '<tr><td colspan="11" class="loading-cell">Loading reports from the CMMS...</td></tr>';
    const summaries = await apiRequest('/daily-reports');
    state.reports = await Promise.all(summaries.map(async summary => {
      const detail = await apiRequest(`/daily-reports/${encodeURIComponent(summary.report_id)}`);
      const report = detail.report;
      const items = detail.items || [];
      const first = items[0] || {};
      const workOrders = [...new Set(items.map(item => item.wo_id).filter(Boolean))];
      const plantLine = [...new Set(items.map(item => [item.plant_id, item.line_id].filter(Boolean).join(' / ')).filter(Boolean))].join(', ') || '-';
      return {
        id: report.report_id,
        date: report.report_date,
        status: report.status,
        shift: report.shift,
        technician: report.technician_name || report.technician_id || summary.technician_id || '-',
        technicianCode: report.technician_code || summary.technician_id || '',
        plantLine,
        workOrders,
        downtime: items.reduce((total, item) => total + (Number(item.downtime_h) || 0), 0),
        submittedAt: report.submitted_at,
        approvedBy: report.approved_by,
        approvedAt: report.approved_at,
        shiftEngineer: report.shift_engineer,
        notes: report.general_notes,
        items,
        first,
      };
    }));
    updateStatistics();
    applyFilters();
  }

  function updateStatistics() {
    const reports = state.reports;
    const average = reports.length ? reports.reduce((sum, report) => sum + report.downtime, 0) / reports.length : 0;
    setText('totalReports', reports.length);
    setText('completedReports', reports.filter(report => report.status === 'Approved').length);
    setText('inProgressReports', reports.filter(report => report.status === 'Draft').length);
    setText('pendingReports', reports.filter(report => report.status === 'Submitted').length);
    setText('rejectedReports', reports.filter(report => report.status === 'Returned').length);
    setText('averageDowntime', average.toFixed(2));
  }

  function applyFilters() {
    const term = search.value.trim().toLowerCase();
    state.filtered = state.reports.filter(report => {
      const statusMatch = state.status === 'all' || (state.status === 'mine' ? report.technicianCode === state.user?.technician_id : report.status === state.status);
      const date = String(report.date || '').slice(0, 10);
      const dateMatch = (!from.value || date >= from.value) && (!to.value || date <= to.value);
      const searchable = `${report.id} ${report.technician} ${report.technicianCode} ${report.plantLine} ${report.status}`.toLowerCase();
      return statusMatch && dateMatch && (!term || searchable.includes(term));
    }).sort((a, b) => new Date(b.submittedAt || b.date) - new Date(a.submittedAt || a.date));
    state.page = 1;
    renderTable();
  }

  function renderTable() {
    const start = (state.page - 1) * state.rows;
    const pageReports = state.filtered.slice(start, start + state.rows);
    body.innerHTML = pageReports.length ? pageReports.map(report => `<tr>
      <td><input type="checkbox" class="report-checkbox" data-id="${escapeHtml(report.id)}"></td>
      <td><button class="report-link" data-view="${escapeHtml(report.id)}">${escapeHtml(report.id)}</button></td>
      <td>${formatDate(report.date)}</td>
      <td>${escapeHtml(report.shift || '-')}</td>
      <td>${escapeHtml(report.technician)}</td>
      <td>${escapeHtml(report.plantLine)}</td>
      <td>${report.workOrders.length ? report.workOrders.map(escapeHtml).join(', ') : '-'}</td>
      <td>${badge(report.status)}</td>
      <td>${asHours(report.downtime)}</td>
      <td>${formatDateTime(report.submittedAt)}</td>
      <td><button class="view-button" type="button" data-view="${escapeHtml(report.id)}" title="Review report">Review</button></td>
    </tr>`).join('') : '<tr><td colspan="11" class="loading-cell">No reports match this view.</td></tr>';
    body.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => showDetails(state.reports.find(report => report.id === button.dataset.view))));
    document.getElementById('selectAll').checked = false;
    renderPagination();
  }

  function renderPagination() {
    const total = state.filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / state.rows));
    if (state.page > totalPages) state.page = totalPages;
    const first = total ? ((state.page - 1) * state.rows) + 1 : 0;
    const last = Math.min(state.page * state.rows, total);
    setText('paginationInfo', `Showing ${first} to ${last} of ${total} entries`);
    document.getElementById('paginationControls').innerHTML = Array.from({ length: totalPages }, (_, index) => `<button class="page-button ${state.page === index + 1 ? 'active' : ''}" data-page="${index + 1}">${index + 1}</button>`).join('');
    document.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => { state.page = Number(button.dataset.page); renderTable(); }));
  }

  function showDetails(report) {
    if (!report) return;
    state.selected = report;
    const activities = report.items.map((item, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(item.equipment_name || item.equipment_code || '-')}</td><td>${escapeHtml(item.maintenance_type || '-')}</td><td>${asHours(item.downtime_h)}</td></tr>`).join('') || '<tr><td colspan="4">No activities</td></tr>';
    const actions = [];
    if (report.status === 'Submitted' && isEngineer()) {
      actions.push('<button type="button" class="decision approve" id="approve-report">Approve report</button>');
      actions.push('<button type="button" class="decision return" id="return-report">Return to technician</button>');
    }
    if (report.status === 'Approved') actions.push('<button type="button" class="decision print" id="print-report">Print A4 report</button>');
    document.getElementById('detailsContent').innerHTML = `<div class="detail-number"><strong>${escapeHtml(report.id)}</strong>${badge(report.status)}</div>
      <div class="detail-list">
        <div class="detail-row"><span class="detail-label">Technician</span><span class="detail-value">${escapeHtml(report.technician)}</span></div>
        <div class="detail-row"><span class="detail-label">Date / Shift</span><span class="detail-value">${formatDate(report.date)} / ${escapeHtml(report.shift || '-')}</span></div>
        <div class="detail-row"><span class="detail-label">Plant / Line</span><span class="detail-value">${escapeHtml(report.plantLine)}</span></div>
        <div class="detail-row"><span class="detail-label">Total downtime</span><span class="detail-value">${asHours(report.downtime)} hrs</span></div>
        <div class="detail-row"><span class="detail-label">Engineer</span><span class="detail-value">${escapeHtml(report.approvedBy || report.shiftEngineer || '-')}</span></div>
      </div>
      <div class="detail-notes"><strong>General notes</strong><p>${escapeHtml(report.notes || '-')}</p></div>
      <div class="activity-preview"><strong>Maintenance activities</strong><table><thead><tr><th>#</th><th>Equipment</th><th>Type</th><th>Downtime</th></tr></thead><tbody>${activities}</tbody></table></div>
      <div class="report-actions">${actions.join('')}</div>`;
    document.getElementById('approve-report')?.addEventListener('click', approveSelected);
    document.getElementById('return-report')?.addEventListener('click', returnSelected);
    document.getElementById('print-report')?.addEventListener('click', () => { window.location.href = `daily-report-print.html?report=${encodeURIComponent(report.id)}`; });
  }

  async function approveSelected() {
    if (!state.selected) return;
    const reportId = state.selected.id;
    const button = document.getElementById('approve-report');
    button.disabled = true;
    button.textContent = 'Approving...';
    try {
      await apiRequest(`/daily-reports/${encodeURIComponent(reportId)}/approve`, { method: 'POST' });
      state.status = 'Approved';
      tabs.forEach(tab => tab.classList.toggle('active', tab.dataset.status === 'Approved'));
      emptyDetails();
      await loadReports();
      showNotice(`Report ${reportId} was approved and moved to Approved Reports.`);
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Approve report';
      showNotice(error.message, true);
    }
  }

  async function returnSelected() {
    if (!state.selected) return;
    const reason = window.prompt('Reason for returning this report to the technician:');
    if (reason === null) return;
    try {
      await apiRequest(`/daily-reports/${encodeURIComponent(state.selected.id)}/return?reason=${encodeURIComponent(reason)}`, { method: 'POST' });
      state.status = 'Returned';
      tabs.forEach(tab => tab.classList.toggle('active', tab.dataset.status === 'Returned'));
      emptyDetails();
      await loadReports();
      showNotice('Report was returned to the technician.');
    } catch (error) { showNotice(error.message, true); }
  }

  function showNotice(message, isError = false) {
    const target = document.getElementById('detailsContent');
    if (!state.selected) target.innerHTML = `<div class="notice ${isError ? 'error' : ''}">${escapeHtml(message)}</div>`;
  }

  function bindControls() {
    tabs.forEach(tab => tab.addEventListener('click', () => { state.status = tab.dataset.status; tabs.forEach(item => item.classList.toggle('active', item === tab)); applyFilters(); }));
    search.addEventListener('input', applyFilters);
    from.addEventListener('change', applyFilters);
    to.addEventListener('change', applyFilters);
    document.getElementById('rowsPerPage').addEventListener('change', event => { state.rows = Number(event.target.value); applyFilters(); });
    document.getElementById('filterButton').addEventListener('click', () => {
      if (search.value || from.value || to.value) { search.value = ''; from.value = ''; to.value = ''; applyFilters(); }
      else from.focus();
    });
    document.getElementById('newReportButton').addEventListener('click', () => { window.location.href = 'daily-report-form.html'; });
    document.getElementById('closeDetails').addEventListener('click', emptyDetails);
    document.getElementById('selectAll').addEventListener('change', event => body.querySelectorAll('.report-checkbox').forEach(box => { box.checked = event.target.checked; }));
  }

  function applyTechnicianInterface() {
    if (state.user?.role !== 'TECHNICIAN') return;

    document.body.classList.add('technician-interface');
    const allowedNavigation = new Set(['Work Orders', 'Daily Reports']);
    document.querySelectorAll('.sidebar-nav a').forEach(link => {
      link.hidden = ![...allowedNavigation].some(label => link.textContent.includes(label));
    });

    // The API already returns only this technician's reports. Start on the
    // matching view so the interface states that scope clearly.
    state.status = 'mine';
    tabs.forEach(tab => tab.classList.toggle('active', tab.dataset.status === 'mine'));
  }

  function bindNavigation() {
    const routes = {
      Dashboard: 'index.html#dashboard', 'Work Orders': 'index.html#work-orders', 'PM Schedule': 'index.html#pm-schedule',
      'Daily Reports': 'daily-reports.html',
      Equipment: 'index.html#equipment', 'Spare Parts': 'index.html#spare-parts', Technicians: 'index.html#technicians',
      KPI: 'index.html#kpi', Reports: 'index.html#reports', SOP: 'index.html#sop', 'Machine Records': 'index.html#machine-records', Settings: 'index.html#settings',
    };
    document.querySelectorAll('.sidebar-nav a').forEach(link => {
      const target = Object.entries(routes).find(([label]) => link.textContent.includes(label))?.[1];
      if (target) link.href = target;
    });
    const card = document.querySelector('.user-card');
    const signout = document.createElement('button');
    signout.type = 'button'; signout.className = 'signout-button'; signout.textContent = 'Sign out';
    signout.addEventListener('click', () => { logout(); location.replace('login.html'); });
    card?.append(signout);
  }

  try {
    if (!getSavedUser()) return location.replace('login.html');
    state.user = await getCurrentUser();
    setText('sidebarUsername', state.user.full_name || state.user.username);
    setText('sidebarRole', state.user.role.replaceAll('_', ' '));
    applyTechnicianInterface();
    bindControls();
    bindNavigation();
    emptyDetails();
    await loadReports();
  } catch (error) {
    body.innerHTML = `<tr><td colspan="11" class="loading-cell error">${escapeHtml(error.message || 'Could not load reports.')}</td></tr>`;
  }
});
