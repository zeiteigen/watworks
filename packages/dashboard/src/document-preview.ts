/** Shared, keyboard-accessible overlays. Document URLs live only as long as their preview. */
export const DOCUMENT_PREVIEW_SCRIPT = String.raw`
  let activeDialog;
  function openDialog(title) {
    if (activeDialog) activeDialog.close();
    const previousFocus = document.activeElement;
    const heading = el('h2', { id: 'dialog-title' }, title);
    const body = el('div', { class: 'dialog-body' });
    const dialog = el('dialog', { class: 'overlay', 'aria-labelledby': 'dialog-title' },
      el('div', { class: 'dialog-header' }, heading,
        el('button', { type: 'button', class: 'secondary', onclick: () => close() }, 'Close')),
      body);
    let disposed = false;
    const cleanups = [];
    function close() {
      if (disposed) return;
      disposed = true;
      cleanups.forEach(cleanup => cleanup());
      if (typeof dialog.close === 'function') dialog.close();
      dialog.remove();
      document.body.classList.remove('overlay-open');
      if (previousFocus?.isConnected) previousFocus.focus();
      if (activeDialog?.dialog === dialog) activeDialog = undefined;
    }
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
    document.body.append(dialog);
    document.body.classList.add('overlay-open');
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    activeDialog = { dialog, body, close, cleanups, isClosed: () => disposed };
    return activeDialog;
  }

  async function preview(path, title = 'Document preview') {
    const view = openDialog(title);
    view.dialog.classList.add('document-overlay');
    view.body.append(el('p', { class: 'meta', role: 'status' }, 'Loading document…'));
    try {
      const blob = await api(path);
      if (view.isClosed()) return;
      const url = URL.createObjectURL(blob);
      view.cleanups.push(() => URL.revokeObjectURL(url));
      view.body.replaceChildren(el('iframe', { class: 'preview', src: url, title }));
    } catch (error) {
      if (!view.isClosed()) view.body.replaceChildren(el('p', { class: 'blockers', role: 'alert' }, error.message));
    }
  }
`;
