// Курсор — источник света для рёбер: его координаты (--gx/--gy на <html>) берут
// фоны с background-attachment: fixed, и рёбра граней и кромки панелей и кнопок
// загораются рядом с курсором. Обновление — раз в кадр; перерисовываются только фоны.

export function initSpotlight() {
  const root = document.documentElement;
  let raf = 0, x = -9999, y = -9999, inside = false;
  const tick = () => {
    raf = 0;
    root.style.setProperty("--gx", `${x}px`);
    root.style.setProperty("--gy", `${y}px`);
    if (inside) root.dataset.cursor = ""; else delete root.dataset.cursor;
  };
  const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };
  document.addEventListener("pointermove", (e) => { x = e.clientX; y = e.clientY; inside = true; kick(); }, { passive: true });
  // Ушёл курсор — свет плавно гаснет на месте (координаты остаются).
  root.addEventListener("pointerleave", () => { inside = false; kick(); });
  window.addEventListener("blur", () => { inside = false; kick(); });
}
