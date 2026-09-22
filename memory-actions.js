/* Memory regeneration, sharing and local PDF export.
 * Sharing is always user initiated. PDF rendering stays in the browser.
 */
(function (root) {
  'use strict';

  const list = (value) => (Array.isArray(value) ? value : []);
  const clean = (value) => String(value ?? '').trim();
  const trimShare = (value, max) => {
    const text = clean(value);
    return text.length > max ? text.slice(0, Math.max(0, max - 18)).trimEnd() + '\n\n[Memory shortened]' : text;
  };

  function title(record) {
    return (
      clean(record?.meeting?.title) ||
      clean(record?.name) ||
      'Synap memory'
    );
  }

  function hasMemory(record) {
    return Boolean(record && (record.meeting || clean(record.summary)));
  }

  function ready(record) {
    if (!hasMemory(record)) return false;
    if (record.localOnly) return true;
    return record.processingStage === 'ready' || record.processingState === 'done';
  }

  function canRebuild(record) {
    return Boolean(
      ready(record) &&
        !record.localOnly &&
        (record.processingStage === 'ready' || record.processingState === 'done') &&
        root.SynapAuth?.isSignedIn?.() &&
        record?.id,
    );
  }

  function when(record) {
    const value = record?.createdAt || record?.startedAt;
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString([], {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function statements(record, key) {
    const conversations = list(record?.meeting?.conversations || record?.conversations);
    return conversations.flatMap((conversation) =>
      list(conversation?.[key]).map((item) => clean(item?.text || item)).filter(Boolean),
    );
  }

  function actions(record) {
    const conversations = list(record?.meeting?.conversations || record?.conversations);
    return conversations.flatMap((conversation) =>
      list(conversation?.action_items)
        .map((item) => {
          const task = clean(item?.task);
          if (!task) return '';
          const owner = clean(item?.owner);
          const due = clean(item?.due_date);
          return task + (owner ? ' — ' + owner : '') + (due ? ' · ' + due : '');
        })
        .filter(Boolean),
    );
  }

  function followUps(record) {
    const conversations = list(record?.meeting?.conversations || record?.conversations);
    return conversations.flatMap((conversation) =>
      list(conversation?.follow_ups)
        .map((item) => clean(item?.text || item))
        .filter(Boolean),
    );
  }

  function memorySections(record) {
    const meeting = record?.meeting || {};
    const sections = [];
    const add = (heading, values) => {
      const items = list(values).map(clean).filter(Boolean);
      if (items.length) sections.push({ heading, items });
    };

    const overview =
      clean(meeting.executive_summary) ||
      clean(record?.summary).split(/\n\s*(?:Key points|Decisions|Action items|Follow-ups)\s*\n/i)[0];
    if (overview) sections.push({ heading: 'Overview', items: [overview], plain: true });
    add('Key points', meeting.key_points);
    add('Decisions', statements(record, 'decisions'));
    add('Action items', actions(record));
    add('Follow-ups', followUps(record));

    const people = list(meeting.people || record?.people)
      .map((person) => clean(person?.name || person))
      .filter(Boolean);
    add('People', [...new Set(people)]);

    const topics = list(meeting.topics)
      .map(clean)
      .filter(Boolean);
    add('Topics', topics);

    return sections;
  }

  function shareText(record) {
    const lines = [title(record)];
    const date = when(record);
    if (date) lines.push(date);
    for (const section of memorySections(record)) {
      lines.push('', section.heading);
      for (const item of section.items) lines.push(section.plain ? item : '• ' + item);
    }
    lines.push('', 'Shared from Synap · infinite memories');
    return lines.join('\n').trim();
  }

  function safeFilename(record) {
    const base = title(record)
      .normalize('NFKD')
      .replace(/[^a-zA-Z0-9 _-]+/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 64)
      .toLowerCase();
    const date = (() => {
      const d = new Date(record?.createdAt || Date.now());
      return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10) + '-';
    })();
    return 'synap-memory-' + date + (base || 'memory') + '.pdf';
  }

  function openExternal(url) {
    const opened = root.open?.(url, '_blank', 'noopener,noreferrer');
    return opened !== null && opened !== undefined;
  }

  function shareWhatsApp(record) {
    const text = trimShare(shareText(record), 12000);
    openExternal('https://wa.me/?text=' + encodeURIComponent(text));
  }

  function shareGmail(record) {
    const subject = 'Synap memory — ' + title(record);
    const body = trimShare(shareText(record), 18000);
    const url =
      'https://mail.google.com/mail/?view=cm&fs=1&tf=1&su=' +
      encodeURIComponent(subject) +
      '&body=' +
      encodeURIComponent(body);
    if (!openExternal(url)) root.location.href = 'mailto:?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
  }

  function splitWords(ctx, text, maxWidth) {
    const source = clean(text).replace(/\s+/g, ' ');
    if (!source) return [];
    const words = source.split(' ');
    const lines = [];
    let line = '';
    for (const word of words) {
      const next = line ? line + ' ' + word : word;
      if (!line || ctx.measureText(next).width <= maxWidth) {
        line = next;
        continue;
      }
      lines.push(line);
      line = word;
    }
    if (line) lines.push(line);
    return lines;
  }

  async function canvasJpeg(canvas) {
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error('Could not render PDF page.'))),
        'image/jpeg',
        0.88,
      );
    });
    return new Uint8Array(await blob.arrayBuffer());
  }

  async function renderPdfPages(record) {
    const width = 1050;
    const height = 1485;
    const margin = 86;
    const bottom = 90;
    const pages = [];
    let canvas;
    let ctx;
    let y = 0;

    function startPage() {
      canvas = root.document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('PDF export is not supported in this browser.');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#1f2924';
      ctx.font = '700 34px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.fillText('synap', margin, 70);
      ctx.fillStyle = '#69736d';
      ctx.font = '600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.fillText('infinite memories', margin, 92);
      y = 138;
    }

    async function finishPage() {
      ctx.fillStyle = '#7b847f';
      ctx.font = '500 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.fillText('Synap memory', margin, height - 38);
      pages.push(await canvasJpeg(canvas));
    }

    async function ensure(space) {
      if (y + space <= height - bottom) return;
      await finishPage();
      startPage();
    }

    async function paragraph(text, bullet) {
      ctx.font = '400 22px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      const bulletWidth = bullet ? 28 : 0;
      const lines = splitWords(ctx, text, width - margin * 2 - bulletWidth);
      for (let index = 0; index < lines.length; index++) {
        await ensure(34);
        ctx.fillStyle = '#24302a';
        if (bullet && index === 0) ctx.fillText('•', margin, y);
        ctx.fillText(lines[index], margin + bulletWidth, y);
        y += 32;
      }
      y += 10;
    }

    startPage();
    ctx.fillStyle = '#17211c';
    ctx.font = '700 42px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    for (const line of splitWords(ctx, title(record), width - margin * 2)) {
      await ensure(52);
      ctx.fillText(line, margin, y);
      y += 50;
    }
    const date = when(record);
    if (date) {
      ctx.fillStyle = '#66716b';
      ctx.font = '500 17px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.fillText(date, margin, y + 4);
      y += 42;
    }
    y += 12;

    for (const section of memorySections(record)) {
      await ensure(70);
      ctx.fillStyle = '#17211c';
      ctx.font = '700 25px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.fillText(section.heading, margin, y);
      y += 40;
      for (const item of section.items) await paragraph(item, !section.plain);
      y += 8;
    }

    await finishPage();
    return { width, height, pages };
  }

  function ascii(value) {
    return new TextEncoder().encode(value);
  }

  function concat(chunks) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  function buildPdfBinary(rendered) {
    const pageCount = rendered.pages.length;
    const objectCount = 2 + pageCount * 3;
    const objects = new Array(objectCount + 1);
    objects[1] = ascii('<< /Type /Catalog /Pages 2 0 R >>');
    const kids = [];
    for (let index = 0; index < pageCount; index++) kids.push(3 + index * 3 + ' 0 R');
    objects[2] = ascii('<< /Type /Pages /Count ' + pageCount + ' /Kids [' + kids.join(' ') + '] >>');

    for (let index = 0; index < pageCount; index++) {
      const pageId = 3 + index * 3;
      const imageId = pageId + 1;
      const contentId = pageId + 2;
      const name = 'Im' + (index + 1);
      const jpeg = rendered.pages[index];
      objects[pageId] = ascii(
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /' +
          name +
          ' ' +
          imageId +
          ' 0 R >> >> /Contents ' +
          contentId +
          ' 0 R >>',
      );
      objects[imageId] = concat([
        ascii(
          '<< /Type /XObject /Subtype /Image /Width ' +
            rendered.width +
            ' /Height ' +
            rendered.height +
            ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' +
            jpeg.byteLength +
            ' >>\nstream\n',
        ),
        jpeg,
        ascii('\nendstream'),
      ]);
      const stream = 'q\n595.28 0 0 841.89 0 0 cm\n/' + name + ' Do\nQ\n';
      objects[contentId] = ascii('<< /Length ' + ascii(stream).byteLength + ' >>\nstream\n' + stream + 'endstream');
    }

    const chunks = [ascii('%PDF-1.4\n%Synap\n')];
    const offsets = new Array(objectCount + 1).fill(0);
    let length = chunks[0].byteLength;
    for (let id = 1; id <= objectCount; id++) {
      offsets[id] = length;
      const header = ascii(id + ' 0 obj\n');
      const footer = ascii('\nendobj\n');
      chunks.push(header, objects[id], footer);
      length += header.byteLength + objects[id].byteLength + footer.byteLength;
    }
    const xrefOffset = length;
    let xref = 'xref\n0 ' + (objectCount + 1) + '\n0000000000 65535 f \n';
    for (let id = 1; id <= objectCount; id++) {
      xref += String(offsets[id]).padStart(10, '0') + ' 00000 n \n';
    }
    xref +=
      'trailer\n<< /Size ' +
      (objectCount + 1) +
      ' /Root 1 0 R >>\nstartxref\n' +
      xrefOffset +
      '\n%%EOF';
    chunks.push(ascii(xref));
    return concat(chunks);
  }

  async function pdfBlob(record) {
    if (!root.document?.createElement) throw new Error('PDF export needs the Synap app.');
    const rendered = await renderPdfPages(record);
    return new Blob([buildPdfBinary(rendered)], { type: 'application/pdf' });
  }

  async function downloadPdf(record) {
    const blob = await pdfBlob(record);
    const url = root.URL.createObjectURL(blob);
    try {
      const link = root.document.createElement('a');
      link.href = url;
      link.download = safeFilename(record);
      link.rel = 'noopener';
      root.document.body.appendChild(link);
      link.click();
      link.remove();
    } finally {
      root.setTimeout(() => root.URL.revokeObjectURL(url), 1000);
    }
  }

  async function recreate(record, status) {
    if (!canRebuild(record)) {
      throw new Error('Sign in and open a ready cloud memory before recreating it.');
    }
    const api = root.SynapBackend;
    if (!api?.rebuildMemory) throw new Error('Memory recreation is unavailable in this app version.');
    if (status) status.textContent = 'Recreating unified memory…';
    const result = await api.rebuildMemory(String(record.id));
    if (!result?.rebuilt) throw new Error('The memory was not rebuilt.');
    const restored = await root.SynapCloudHistory?.restoreRecording?.(String(record.id), true);
    if (restored?.error) throw restored.error;
    if (typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function')
      root.dispatchEvent(
      new root.CustomEvent('synap-memory-rebuilt', {
        detail: {
          recordingId: String(record.id),
          reusedTranscriptSegments: Number(result.reused_transcript_segments || 0),
        },
      }),
    );
    if (status) {
      status.textContent =
        'Memory recreated from ' +
        Number(result.reused_transcript_segments || 0) +
        ' merged transcript segment' +
        (Number(result.reused_transcript_segments || 0) === 1 ? '' : 's') +
        '.';
    }
    return result;
  }

  function actionButton(label, disabled) {
    const button = root.document.createElement('button');
    button.type = 'button';
    button.className = 'memory-action-button';
    button.textContent = label;
    button.disabled = Boolean(disabled);
    return button;
  }

  function decorate(card, record) {
    if (!card || !record || !ready(record)) return;
    const content = card.querySelector('.recording-content');
    if (!content) return;
    let panel = content.querySelector('.memory-actions-panel');
    if (!panel) {
      panel = root.document.createElement('section');
      panel.className = 'memory-actions-panel';
      panel.setAttribute('aria-label', 'Memory actions');
      const heading = root.document.createElement('div');
      heading.className = 'memory-actions-heading';
      heading.innerHTML = '<strong>Memory actions</strong><span>Recreate from the complete transcript or share this memory.</span>';
      const controls = root.document.createElement('div');
      controls.className = 'memory-actions-controls';
      const status = root.document.createElement('p');
      status.className = 'memory-action-status';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      panel.append(heading, controls, status);
      content.append(panel);
    }

    const controls = panel.querySelector('.memory-actions-controls');
    const status = panel.querySelector('.memory-action-status');
    const signature = [String(record.id || ''), String(record.processedAt || ''), String(root.SynapAuth?.isSignedIn?.())].join('|');
    if (panel.dataset.signature === signature) return;
    panel.dataset.signature = signature;
    controls.replaceChildren();

    const wrap = (button, run, pending, success) => {
      button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (button.disabled) return;
        const buttons = [...controls.querySelectorAll('button')];
        buttons.forEach((node) => (node.disabled = true));
        status.textContent = pending || '';
        try {
          await run();
          if (success) status.textContent = success;
        } catch (error) {
          status.textContent = error?.message || 'Memory action failed.';
        } finally {
          buttons.forEach((node) => {
            node.disabled = node.dataset.rebuild === 'true' ? !canRebuild(record) : false;
          });
        }
      });
    };

    const rebuild = actionButton('Recreate memory', !canRebuild(record));
    rebuild.dataset.rebuild = 'true';
    rebuild.title = 'Rebuild from the complete merged transcript without retranscribing audio.';
    wrap(rebuild, () => recreate(record, status), 'Recreating unified memory…');

    const whatsapp = actionButton('WhatsApp', false);
    wrap(whatsapp, () => shareWhatsApp(record), 'Opening WhatsApp…', 'Opened WhatsApp.');

    const gmail = actionButton('Gmail', false);
    wrap(gmail, () => shareGmail(record), 'Opening Gmail…', 'Opened Gmail.');

    const pdf = actionButton('PDF', false);
    wrap(pdf, () => downloadPdf(record), 'Creating PDF…', 'PDF downloaded.');

    controls.append(rebuild, whatsapp, gmail, pdf);
  }

  root.SynapMemoryActions = Object.freeze({
    hasMemory,
    ready,
    canRebuild,
    title,
    memorySections,
    shareText,
    safeFilename,
    shareWhatsApp,
    shareGmail,
    pdfBlob,
    downloadPdf,
    recreate,
    decorate,
    buildPdfBinary,
  });

  if (typeof module !== 'undefined') module.exports = root.SynapMemoryActions;
})(globalThis);
