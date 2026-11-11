// Keeps the names on a map readable. A label that would run off the right edge, or land on a
// label already placed, moves to the left of its pin. If it still covers another label, it is
// hidden, and it shows again on hover or keyboard focus. The pin still has its name as a tooltip.
// The most important labels are placed first, ranked by data-p on the pin (higher first).

// labels may touch by a few pixels (their white boxes still read apart); more than that is a clash
const SLACK = 3;
const overlaps = (a, b) => a.left < b.right - SLACK && a.right > b.left + SLACK && a.top < b.bottom - SLACK && a.bottom > b.top + SLACK;

/**
 * @param {L.Map} map
 * @param {{ pin: string, label: string }} sel CSS selectors for a pin and, inside it, its label
 */
export function tidyLabels(map, { pin, label }) {
  const box = map.getContainer().getBoundingClientRect();
  const edge = { left: box.left + 4, right: box.right - 4, top: box.top, bottom: box.bottom };
  const pins = [...map.getContainer().querySelectorAll(pin)]
    .map((el, i) => ({ el, i, p: Number(el.dataset.p || 0) }))
    .sort((a, b) => b.p - a.p || a.i - b.i);
  const placed = [];
  const clash = (r) => placed.some((q) => overlaps(r, q));
  const fits = (r) => r.left >= edge.left && r.right <= edge.right;

  for (const { el } of pins) {
    el.classList.remove('is-left', 'lbl-off');
    const lab = el.querySelector(label);
    if (!lab) continue;
    let r = lab.getBoundingClientRect();
    if (!(r.right > edge.left && r.left < edge.right && r.bottom > edge.top && r.top < edge.bottom)) continue; // off screen
    if (!fits(r) || clash(r)) {
      el.classList.add('is-left');
      const left = lab.getBoundingClientRect();
      if (fits(left) && !clash(left)) r = left;
      else if (!fits(r) && fits(left)) r = left;
      else { el.classList.remove('is-left'); r = lab.getBoundingClientRect(); }
    }
    if (clash(r)) { el.classList.add('lbl-off'); continue; }
    placed.push(r);
  }
}

/** Tidies now and after every pan or zoom. Returns a function that tidies again. */
export function keepLabelsTidy(map, sel) {
  let frame = 0;
  const run = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => tidyLabels(map, sel));
  };
  map.on('moveend zoomend resize', run);
  run();
  return run;
}
