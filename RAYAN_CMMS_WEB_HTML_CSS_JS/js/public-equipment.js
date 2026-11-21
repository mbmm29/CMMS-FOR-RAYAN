(() => {
  const tr = value => window.t ? window.t(value) : value;
  const token = new URLSearchParams(location.search).get('token');
  const summary = document.getElementById('equipment-summary');
  const tabs = document.getElementById('equipment-tabs');
  const content = document.getElementById('equipment-content');
  let payload = null;
  const esc = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
  const empty = message => `<p class="public-empty">${esc(message)}</p>`;
  const fileUrl = file => `/public/equipment/${encodeURIComponent(token)}/manual${file.file_id ? `?file_id=${encodeURIComponent(file.file_id)}` : '?legacy=true'}`;

  function renderHeader(equipment) {
    summary.innerHTML = `<h1>${esc(equipment.equipment_id)} — ${esc(equipment.name)}</h1><p>${esc(equipment.category || '')}</p><div class="equipment-facts">${[
      ['Plant',equipment.plant],['Line',equipment.line_number ? `${equipment.line_number} — ${equipment.line || ''}` : equipment.line],['Section',equipment.section],['Manufacturer',equipment.manufacturer],['Model',equipment.model],['Serial number',equipment.serial_number],['Status',equipment.status],
    ].filter(([,value]) => value).map(([label,value]) => `<span><b>${esc(tr(label))}:</b> ${esc(value)}</span>`).join('')}</div>`;
  }

  function renderManual() {
    const files = payload.manual_files || [];
    if (!files.length) { content.innerHTML = empty(tr('No manual has been published for this equipment category.')); return; }
    content.innerHTML = `<div class="public-files">${files.map((file,index) => {
      const url = fileUrl(file);
      const isPdf = /pdf/i.test(file.content_type || '') || /\.pdf$/i.test(file.filename || '');
      return `<a class="public-file" href="${esc(url)}" ${isPdf ? 'data-manual-preview' : 'target="_blank" rel="noopener"'} data-index="${index}"><span>${esc(file.filename || tr('Manual'))}</span><b>${esc(tr(isPdf ? 'Preview' : 'Open'))}</b></a>`;
    }).join('')}</div><div id="manual-viewer"></div>`;
    content.querySelectorAll('[data-manual-preview]').forEach(link => link.addEventListener('click', event => {
      event.preventDefault();
      content.querySelectorAll('[data-manual-preview]').forEach(item => item.classList.remove('active'));
      link.classList.add('active');
      content.querySelector('#manual-viewer').innerHTML = `<iframe class="public-viewer" title="${esc(link.textContent)}" src="${esc(link.href)}"></iframe>`;
    }));
    const firstPdf = content.querySelector('[data-manual-preview]');
    firstPdf?.click();
  }

  function renderSop() {
    if (!payload.sop) { content.innerHTML = empty(tr('No SOP has been published for this equipment.')); return; }
    let doc = {};
    try { doc = JSON.parse(payload.sop.document || '{}'); } catch (_) { doc = {}; }
    const paragraphs = (doc.paragraphs || []).map(item => `<li>${esc(item)}</li>`).join('');
    const steps = (doc.steps || []).map((item,index) => `<article class="public-record"><h3>${esc(item.phase || item.action || `Step ${index+1}`)}</h3>${item.action ? `<p>${esc(item.action)}</p>` : ''}${item.standard ? `<p><b>Standard:</b> ${esc(item.standard)}</p>` : ''}${item.notes ? `<p><b>Notes:</b> ${esc(item.notes)}</p>` : ''}</article>`).join('');
    const safety = (doc.safety || []).map(item => `<article class="public-record"><h3>${esc(item.detail || item.category || 'Safety')}</h3><p>${esc(item.description || '')}</p></article>`).join('');
    content.innerHTML = `<article class="public-sop"><h2>${esc(payload.sop.title || doc.title || tr('Standard operating procedure'))}</h2>${payload.sop.revision ? `<p>${esc(tr('Revision'))}: ${esc(payload.sop.revision)}</p>` : ''}${doc.subtitle ? `<p>${esc(doc.subtitle)}</p>` : ''}${paragraphs ? `<h3>${esc(tr('SOP instructions'))}</h3><ol>${paragraphs}</ol>` : ''}${steps ? `<h3>${esc(tr('Procedure and steps'))}</h3>${steps}` : ''}${safety ? `<h3>${esc(tr('Safety and tools'))}</h3>${safety}` : ''}${!paragraphs && !steps && !safety ? empty('No SOP details are available.') : ''}</article>`;
  }

  function renderRecords() {
    const records = payload.maintenance_records || [];
    if (!records.length) { content.innerHTML = empty(tr('No maintenance records have been entered for this equipment.')); return; }
    content.innerHTML = `<div class="public-records">${records.map(record => `<article class="public-record"><h3>${esc(record.date || '—')} · ${esc(tr(record.type || 'Maintenance'))}</h3>${record.technician ? `<p><b>${esc(tr('Technician(s)'))}:</b> ${esc(record.technician)}</p>` : ''}${record.work_order_id ? `<p><b>${esc(tr('Work order'))}:</b> ${esc(record.work_order_id)}</p>` : ''}${record.description ? `<p><b>${esc(tr('Failure / work'))}:</b> ${esc(record.description)}</p>` : ''}${record.cause ? `<p><b>${esc(tr('Cause'))}:</b> ${esc(record.cause)}</p>` : ''}${record.action ? `<p><b>${esc(tr('Action taken'))}:</b> ${esc(record.action)}</p>` : ''}${record.spare_parts ? `<p><b>${esc(tr('Parts used'))}:</b> ${esc(record.spare_parts)}</p>` : ''}${record.start_time || record.end_time ? `<p><b>${esc(tr('Time'))}:</b> ${esc(record.start_time || '—')} – ${esc(record.end_time || '—')}</p>` : ''}${record.downtime_hours != null ? `<p><b>${esc(tr('Downtime'))}:</b> ${esc(record.downtime_hours)} h</p>` : ''}</article>`).join('')}</div>`;
  }

  function showTab(name) {
    tabs.querySelectorAll('button').forEach(button => {
      const active = button.dataset.tab === name;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    if (name === 'manual') renderManual();
    else if (name === 'sop') renderSop();
    else renderRecords();
  }

  async function start() {
    if (!token) throw new Error('Equipment QR link is missing.');
    const response = await fetch(`/public/equipment/${encodeURIComponent(token)}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || 'Equipment information could not be loaded.');
    payload = data;
    renderHeader(data.equipment);
    tabs.hidden = false;
    tabs.querySelectorAll('button').forEach(button => button.addEventListener('click', () => showTab(button.dataset.tab)));
    showTab('records');
  }

  start().catch(error => {
    summary.innerHTML = `<div class="public-error">${esc(error.message || 'Equipment information could not be loaded.')}</div>`;
    tabs.hidden = true;
    content.innerHTML = '';
  });
})();
