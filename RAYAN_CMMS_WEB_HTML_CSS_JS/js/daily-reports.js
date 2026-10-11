document.addEventListener('DOMContentLoaded', async () => {
  const state = { reports: [], filtered: [], page: 1, rows: 10, status: 'all', user: null, selected: null };
  const body = document.getElementById('reportsTableBody');
  const search = document.getElementById('globalSearch');
  const from = document.getElementById('dateFrom');
  const to = document.getElementById('dateTo');
  const technicianFilter = document.getElementById('technicianFilter');
  const tabs = [...document.querySelectorAll('.report-tab')];

  const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  const formatDate = value => value ? new Date(`${String(value).slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB') : '-';
  const formatDateTime = value => value ? new Date(value).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '-';
  const isEngineer = () => ['SYSTEM_DEVELOPER', 'MAINTENANCE_ENGINEER'].includes(state.user?.role);
  const statusText = status => t(({ Submitted: 'Pending Approval', Approved: 'Approved', Returned: 'Returned', Draft: 'Draft' }[status] || status || '-'));
  const statusClass = status => ({ Submitted: 'pending', Approved: 'approved', Returned: 'returned', Draft: 'draft' }[status] || 'draft');
  const badge = status => `<span class="status ${statusClass(status)}">${escapeHtml(statusText(status))}</span>`;
  const asHours = value => Number(value || 0).toFixed(2);

  function setText(id, value) { const element = document.getElementById(id); if (element) element.textContent = value; }
  function emptyDetails() {
    state.selected = null;
    closeReview();
  }

  async function loadTechnicians() {
    const people = await apiRequest('/technicians');
    const chosen = technicianFilter.value;
    const options = [`<option value="" data-i18n-option="All technicians">${escapeHtml(t('All technicians'))}</option>`];
    people.slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))).forEach(person => {
      options.push(`<option value="${escapeHtml(person.technician_id)}">${escapeHtml(person.name)}</option>`);
    });
    technicianFilter.innerHTML = options.join('');
    if ([...technicianFilter.options].some(option => option.value === chosen)) technicianFilter.value = chosen;
    renderTechnicianMenu();
  }

  function renderTechnicianMenu() {
    const menu = document.getElementById('technicianFilterMenu');
    const button = document.getElementById('technicianFilterButton');
    const selected = technicianFilter.value;
    menu.innerHTML = [...technicianFilter.options].map(option => `<li><button type="button" role="option" data-tech="${escapeHtml(option.value)}" aria-selected="${option.value === selected ? 'true' : 'false'}">${escapeHtml(option.value ? option.textContent : t('All technicians'))}</button></li>`).join('');
    const current = [...technicianFilter.options].find(option => option.value === selected);
    button.textContent = current && current.value ? current.textContent : t('All technicians');
    menu.querySelectorAll('button').forEach(item => item.addEventListener('click', () => {
      technicianFilter.value = item.dataset.tech || '';
      menu.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      renderTechnicianMenu();
      applyFilters();
    }));
  }

  async function loadReports() {
    body.innerHTML = `<tr><td colspan="11" class="loading-cell">${t('Loading reports from the CMMS...')}</td></tr>`;
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
        returnReason: report.return_reason,
        plantId: report.plant_id,
        items,
        first,
      };
    }));
    updateStatistics();
    applyFilters();
  }

  function reportsForScope() {
    return state.reports.filter(report => {
      const date = String(report.date || '').slice(0, 10);
      const dateMatch = (!from.value || date >= from.value) && (!to.value || date <= to.value);
      const technicianMatch = !technicianFilter.value || report.technicianCode === technicianFilter.value;
      return dateMatch && technicianMatch;
    });
  }

  function updateStatistics() {
    const reports = reportsForScope();
    const totalDown = reports.reduce((sum, report) => sum + report.downtime, 0);
    const average = reports.length ? totalDown / reports.length : 0;
    const parts = reports.reduce((sum, report) => sum + reviewParts((report.items || []).find(item => item.spare_parts)?.spare_parts || '').length, 0);
    setText('totalReports', reports.length);
    setText('completedReports', reports.filter(report => report.status === 'Approved').length);
    setText('inProgressReports', reports.filter(report => report.status === 'Draft').length);
    setText('pendingReports', reports.filter(report => report.status === 'Submitted').length);
    setText('rejectedReports', reports.filter(report => report.status === 'Returned').length);
    setText('averageDowntime', average.toFixed(2));
    setText('totalDowntime', totalDown.toFixed(2));
    setText('sparePartsUsed', parts);
  }

  function applyFilters() {
    const term = search.value.trim().toLowerCase();
    state.filtered = state.reports.filter(report => {
      const statusMatch = state.status === 'all' || (state.status === 'mine' ? report.technicianCode === state.user?.technician_id : report.status === state.status);
      const date = String(report.date || '').slice(0, 10);
      const dateMatch = (!from.value || date >= from.value) && (!to.value || date <= to.value);
      const technicianMatch = !technicianFilter.value || report.technicianCode === technicianFilter.value;
      const searchable = `${report.id} ${report.technician} ${report.technicianCode} ${report.plantLine} ${report.status}`.toLowerCase();
      return statusMatch && dateMatch && technicianMatch && (!term || searchable.includes(term));
    }).sort((a, b) => new Date(b.submittedAt || b.date) - new Date(a.submittedAt || a.date));
    state.page = 1;
    updateStatistics();
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
    body.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => openReview(state.reports.find(report => report.id === button.dataset.view))));
    document.getElementById('selectAll').checked = false;
    renderPagination();
  }

  function renderPagination() {
    const total = state.filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / state.rows));
    if (state.page > totalPages) state.page = totalPages;
    const first = total ? ((state.page - 1) * state.rows) + 1 : 0;
    const last = Math.min(state.page * state.rows, total);
    setText('paginationInfo', `${t('Showing')} ${first} ${t('to')} ${last} ${t('of')} ${total} ${t('entries')}`);
    document.getElementById('paginationControls').innerHTML = Array.from({ length: totalPages }, (_, index) => `<button class="page-button ${state.page === index + 1 ? 'active' : ''}" data-page="${index + 1}">${index + 1}</button>`).join('');
    document.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => { state.page = Number(button.dataset.page); renderTable(); }));
  }

  const REVIEW_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function reviewParts(text) {
    const rows = String(text || '').split('\n').map(line => line.trim()).filter(Boolean).map(line => {
      const match = line.match(/^(.*?) \| No: (.*?) \| Qty: (.*?)(?: \| .*)?$/);
      if (!match) return { description: line, number: '', quantity: '' };
      return {
        description: match[1] === 'Part' ? '' : match[1],
        number: match[2] === '—' ? '' : match[2],
        quantity: match[3] === '—' ? '' : match[3],
      };
    }).filter(part => part.description || part.number || part.quantity);
    return rows;
  }

  function reviewValue(value) {
    return value ? String(value).slice(0, 5) : '';
  }

  function openReview(report) {
    if (!report) return;
    state.selected = report;
    const day = new Date(`${String(report.date).slice(0, 10)}T00:00:00`);
    const dayName = REVIEW_DAYS[day.getDay()] || '';
    const activityRows = report.items.map((item, index) => `<tr>
      <td class="lube-no">${index + 1}</td>
      <td class="lube-machine"><input value="${escapeHtml(item.equipment_code || item.equipment_id || '')}" readonly><input value="${escapeHtml(item.equipment_name || '')}" readonly><input value="${escapeHtml(item.entered_line_number || '')}" readonly></td>
      <td><input value="${escapeHtml(t(item.maintenance_type || ''))}" readonly>${item.wo_id ? `<small class="lube-order">${escapeHtml(item.wo_id)}</small>` : ''}</td>
      <td class="daily-work"><input value="${escapeHtml(item.failure_reason || '')}" readonly><input value="${escapeHtml(item.action_taken || '')}" readonly></td>
      <td><input value="${escapeHtml(reviewValue(item.maintenance_start))}" readonly></td>
      <td><input value="${escapeHtml(reviewValue(item.maintenance_end))}" readonly></td>
      <td><input value="${item.downtime_h != null ? asHours(item.downtime_h) : ''}" readonly></td>
    </tr>`).join('') || `<tr><td class="annual-empty" colspan="7">${escapeHtml(t('No activities'))}</td></tr>`;
    const parts = reviewParts(report.items.find(item => item.spare_parts)?.spare_parts || '');
    const partRows = parts.map((part, index) => `<tr><td class="lube-no">${index + 1}</td><td><input value="${escapeHtml(part.description)}" readonly></td><td><input value="${escapeHtml(part.number)}" readonly></td><td><input value="${escapeHtml(part.quantity)}" readonly></td></tr>`).join('') || `<tr><td class="annual-empty" colspan="4">${escapeHtml(t('No spare parts'))}</td></tr>`;
    const decisions = report.status === 'Submitted' && isEngineer()
      ? `<button type="button" class="decision approve" id="review-approve">${escapeHtml(t('Approve report'))}</button><button type="button" class="decision return" id="review-reject">${escapeHtml(t('Reject report'))}</button>`
      : '';
    const layout = document.querySelector('.reports-layout');
    const sheet = document.getElementById('detailsContent');
    if (!sheet) return;
    layout?.classList.add('reviewing');
    sheet.innerHTML = `<div class="review-bar no-print"><button type="button" id="review-close">${escapeHtml(t('Back to reports'))}</button>${decisions}</div>
      <form class="lube-paper daily-paper" id="review-paper">
        <header class="lube-head"><img src="logo-rayan.png?v=2" alt="Rayan"><div><h2>${escapeHtml(t('DAILY MAINTENANCE REPORT'))}</h2><p>${escapeHtml(t(report.status || 'Draft'))}</p><small>${escapeHtml(t('Mechanical Maintenance Department'))}</small></div><dl><div><dt>${escapeHtml(t('Form No.:'))}</dt><dd>DR</dd></div><div><dt>${escapeHtml(t('Report No.'))}</dt><dd>${escapeHtml(report.id)}</dd></div></dl></header>
        <div class="lube-meta">
          <label><span>${escapeHtml(t('Shift'))}</span><input value="${escapeHtml(t(report.shift || ''))}" readonly></label>
          <label><span>${escapeHtml(t("Technician's name"))}</span><input value="${escapeHtml(report.technician)}" readonly></label>
          <label><span>${escapeHtml(t('Plant'))}</span><input value="${escapeHtml(report.plantLine && report.plantLine !== '-' ? report.plantLine : (report.plantId || ''))}" readonly></label>
          <label><span>${escapeHtml(t('Date'))}</span><input value="${escapeHtml(formatDate(report.date))}" readonly></label>
          <label><span>${escapeHtml(t('Day'))}</span><input value="${escapeHtml(t(dayName))}" readonly></label>
          <label><span>${escapeHtml(t('Maintenance Engineer'))}</span><input value="${escapeHtml(report.shiftEngineer || '')}" readonly></label>
        </div>
        <table class="lube-table"><thead><tr><th>${escapeHtml(t('Seq.'))}</th><th>${escapeHtml(t('Machine'))}</th><th>${escapeHtml(t('Maintenance Type'))}</th><th>${escapeHtml(t('Repair Actions'))}</th><th>${escapeHtml(t('Start Time'))}</th><th>${escapeHtml(t('End Time'))}</th><th>${escapeHtml(t('Downtime (hrs)'))}</th></tr></thead><tbody>${activityRows}</tbody></table>
        <section class="daily-parts"><h3>${escapeHtml(t('SPARE PARTS USED'))}</h3><table class="lube-table"><thead><tr><th>${escapeHtml(t('No.'))}</th><th>${escapeHtml(t('Part'))}</th><th>${escapeHtml(t('Part No.'))}</th><th>${escapeHtml(t('Qty'))}</th></tr></thead><tbody>${partRows}</tbody></table></section>
        <label class="daily-notes"><span>${escapeHtml(t('GENERAL NOTES'))}</span><div class="daily-note-box"><textarea readonly>${escapeHtml(report.notes || '')}</textarea><b class="daily-tdt">TDT: <span>${asHours(report.downtime)}</span></b></div></label>
        ${report.returnReason ? `<p class="daily-return">${escapeHtml(t('Rejection reason'))}: ${escapeHtml(report.returnReason)}</p>` : ''}
      </form>
      <form class="review-reason no-print" id="reject-box" hidden>
        <div class="review-reason-head"><b>${escapeHtml(t('Rejection reason'))}</b><small>${escapeHtml(t('The technician sees this reason on the returned report.'))}</small></div>
        <textarea id="reject-reason" required placeholder="${escapeHtml(t('Enter the reason for rejecting this report.'))}"></textarea>
        <p id="reject-error" class="form-error"></p>
        <div class="review-reason-actions"><button type="submit" class="decision return" id="reject-send">${escapeHtml(t('Return to technician'))}</button></div>
      </form>`;
    document.getElementById('review-close')?.addEventListener('click', closeReview);
    document.getElementById('review-approve')?.addEventListener('click', approveSelected);
    document.getElementById('review-reject')?.addEventListener('click', () => {
      const box = document.getElementById('reject-box');
      if (!box) return;
      box.hidden = false;
      box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      document.getElementById('reject-reason')?.focus();
    });
    document.getElementById('reject-box')?.addEventListener('submit', event => {
      event.preventDefault();
      returnSelected(document.getElementById('reject-reason')?.value || '');
    });
  }

  function closeReview() {
    document.querySelector('.reports-layout')?.classList.remove('reviewing');
    const sheet = document.getElementById('detailsContent');
    if (sheet) sheet.innerHTML = '';
  }

  function showDetails(report) {
    if (!report) return;
    state.selected = report;
    const activities = report.items.map((item, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(item.equipment_name || item.equipment_code || '-')}</td><td>${escapeHtml(t(item.maintenance_type || '-'))}</td><td>${asHours(item.downtime_h)}</td></tr>`).join('') || `<tr><td colspan="4">${t('No activities')}</td></tr>`;
    const actions = [];
    if (report.status === 'Submitted' && isEngineer()) {
      actions.push(`<button type="button" class="decision approve" id="approve-report">${t('Approve report')}</button>`);
      actions.push(`<button type="button" class="decision return" id="return-report">${t('Return to technician')}</button>`);
    }
    if (report.status === 'Approved') actions.push(`<button type="button" class="decision print" id="print-report">${t('Print A4 report')}</button>`);
    document.getElementById('detailsContent').innerHTML = `<div class="detail-number"><strong>${escapeHtml(report.id)}</strong>${badge(report.status)}</div>
      <div class="detail-list">
        <div class="detail-row"><span class="detail-label">${t('Technician')}</span><span class="detail-value">${escapeHtml(report.technician)}</span></div>
        <div class="detail-row"><span class="detail-label">${t('Date / Shift')}</span><span class="detail-value">${formatDate(report.date)} / ${escapeHtml(t(report.shift || '-'))}</span></div>
        <div class="detail-row"><span class="detail-label">${t('Plant / Line')}</span><span class="detail-value">${escapeHtml(report.plantLine)}</span></div>
        <div class="detail-row"><span class="detail-label">${t('Total downtime')}</span><span class="detail-value">${asHours(report.downtime)} ${t('HRS')}</span></div>
        <div class="detail-row"><span class="detail-label">${t('Engineer')}</span><span class="detail-value">${escapeHtml(report.approvedBy || report.shiftEngineer || '-')}</span></div>
      </div>
      <div class="detail-notes"><strong>${t('General notes')}</strong><p>${escapeHtml(report.notes || '-')}</p></div>
      <div class="activity-preview"><strong>${t('Maintenance activities')}</strong><table><thead><tr><th>#</th><th>${t('Equipment')}</th><th>${t('Type')}</th><th>${t('Downtime')}</th></tr></thead><tbody>${activities}</tbody></table></div>
      <div class="report-actions">${actions.join('')}</div>`;
    document.getElementById('approve-report')?.addEventListener('click', approveSelected);
    document.getElementById('return-report')?.addEventListener('click', returnSelected);
    document.getElementById('print-report')?.addEventListener('click', () => { window.location.href = `daily-report-print.html?report=${encodeURIComponent(report.id)}`; });
  }

  async function approveSelected() {
    if (!state.selected) return;
    const reportId = state.selected.id;
    const button = document.getElementById('review-approve') || document.getElementById('approve-report');
    button.disabled = true;
    button.textContent = 'Approving...';
    try {
      await apiRequest(`/daily-reports/${encodeURIComponent(reportId)}/approve`, { method: 'POST' });
      state.status = 'Approved';
      tabs.forEach(tab => tab.classList.toggle('active', tab.dataset.status === 'Approved'));
      closeReview();
      emptyDetails();
      await loadReports();
      showNotice(`Report ${reportId} was approved and moved to Approved Reports.`);
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Approve report';
      showNotice(error.message, true);
    }
  }

  async function returnSelected(reasonText) {
    if (!state.selected) return;
    const reason = String(reasonText ?? '').trim();
    if (!reason) {
      const error = document.getElementById('reject-error');
      if (error) error.textContent = t('Enter the reason for rejecting this report.');
      document.getElementById('reject-reason')?.focus();
      return;
    }
    try {
      await apiRequest(`/daily-reports/${encodeURIComponent(state.selected.id)}/return?reason=${encodeURIComponent(reason)}`, { method: 'POST' });
      state.status = 'Returned';
      tabs.forEach(tab => tab.classList.toggle('active', tab.dataset.status === 'Returned'));
      closeReview();
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
    technicianFilter.addEventListener('change', applyFilters);
    const technicianButton = document.getElementById('technicianFilterButton');
    const technicianMenu = document.getElementById('technicianFilterMenu');
    technicianButton.addEventListener('click', () => {
      technicianMenu.hidden = !technicianMenu.hidden;
      technicianButton.setAttribute('aria-expanded', String(!technicianMenu.hidden));
    });
    document.addEventListener('click', event => {
      if (event.target.closest('.tech-filter')) return;
      technicianMenu.hidden = true;
      technicianButton.setAttribute('aria-expanded', 'false');
    });
    document.getElementById('rowsPerPage').addEventListener('change', event => { state.rows = Number(event.target.value); applyFilters(); });
    document.getElementById('filterButton').addEventListener('click', () => {
      if (search.value || from.value || to.value || technicianFilter.value) { search.value = ''; from.value = ''; to.value = ''; technicianFilter.value = ''; renderTechnicianMenu(); applyFilters(); }
      else from.focus();
    });
    document.getElementById('closeDetails').addEventListener('click', emptyDetails);
    document.getElementById('selectAll').addEventListener('change', event => body.querySelectorAll('.report-checkbox').forEach(box => { box.checked = event.target.checked; }));
  }

  function applyTechnicianInterface() {
    if (state.user?.role !== 'TECHNICIAN') return;
    location.replace('index.html#daily-reports');
  }

  function bindNavigation() {
    const routes = {
      KPI: 'index.html#dashboard', 'Work Orders': 'index.html#work-orders', 'PM Schedule': 'index.html#pm-schedule',
      'Daily Reports': 'daily-reports.html', Plants: 'index.html#plants', 'New equipment': 'index.html#new-equipment',
      Equipment: 'index.html#equipment', SOP: 'index.html#sop', 'Machine Records': 'index.html#machine-records', Users: 'index.html#users',
    };
    document.querySelectorAll('.developer-only').forEach(link => { link.hidden = state.user.role !== 'SYSTEM_DEVELOPER'; });
    document.querySelectorAll('.engineer-only').forEach(link => { link.hidden = !['SYSTEM_DEVELOPER', 'MAINTENANCE_ENGINEER'].includes(state.user.role); });
    document.querySelectorAll('.sidebar-nav a').forEach(link => {
      const key = link.querySelector('[data-i18n]')?.dataset.i18n;
      if (routes[key]) link.href = routes[key];
    });
    const card = document.querySelector('.user-card');
    const signout = document.createElement('button');
    signout.type = 'button'; signout.className = 'signout-button'; signout.dataset.i18n = 'Sign out'; signout.textContent = t('Sign out');
    signout.addEventListener('click', () => { logout(); location.replace('login.html'); });
    card?.append(signout);
  }

  try {
    if (!getSavedUser()) return location.replace('login.html');
    state.user = await getCurrentUser();
    setText('sidebarUsername', state.user.full_name || state.user.username);
    setText('sidebarRole', t(state.user.role.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())));
    applyTechnicianInterface();
    bindControls();
    bindNavigation();
    emptyDetails();
    await loadTechnicians();
    await loadReports();
    document.addEventListener('cmms-language', () => {
      renderTechnicianMenu();
      applyFilters();
      if (state.selected) showDetails(state.selected);
    });
  } catch (error) {
    body.innerHTML = `<tr><td colspan="11" class="loading-cell error">${escapeHtml(error.message || 'Could not load reports.')}</td></tr>`;
  }
});
