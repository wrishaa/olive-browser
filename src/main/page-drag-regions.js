// web pages must never drag the olive window.
//
// electron (44.x) keeps one draggable region per webContents (WebContents::draggable_region_,
// set in DraggableRegionsChanged) and the window hit test asks every WebContentsView for it,
// in insertion order, regardless of z-order (NativeWindow::NonClientHitTest ->
// WebContentsView::NonClientHitTest -> HTCAPTION). blink only reports regions for a document
// that uses -webkit-app-region at all (LocalFrameView::UpdateDocumentDraggableRegions bails out
// on !HasDraggableRegions), and electron never clears the region on navigation. so after a page
// with a drag region (teams' shell, a splash, a title bar), the next document in that tab that
// has no app-region css never sends an update: the old region stays live over the new page.
// a mouse-down there is a window drag (the window moves, the page gets no mousedown) while
// keyboard input still works. seen on microsoft's sign-in / "keep your account secure" pages.
//
// fix: a user-origin sheet on every main document. `none !important` turns off every page drag
// region (user !important beats author !important); `no-drag` on <html> makes the document
// count as having regions, so blink reports one no-drag rect and electron's region becomes
// empty, replacing whatever the previous document left behind.
const PAGE_DRAG_CSS = '*, *::before, *::after { -webkit-app-region: none !important; } html { -webkit-app-region: no-drag !important; }';

function wirePageDragRegions(wc) {
  const reset = () => {
    if (wc.isDestroyed()) return;
    wc.insertCSS(PAGE_DRAG_CSS, { cssOrigin: 'user' }).catch(() => {});
  };
  // did-navigate: the new main document has committed, before its first layout in most cases.
  // dom-ready: again once the document is parsed, in case the first insert raced the commit.
  wc.on('did-navigate', reset);
  wc.on('dom-ready', reset);
}

module.exports = { PAGE_DRAG_CSS, wirePageDragRegions };
