// A notice clicked on this PC (decision 58): the desktop app hands the open hub page the card's address with
// window.postMessage, so the card opens without reloading the page (an unsent message and its pictures survive).
// The page marks itself ready with this flag on <html>; without it the app loads the address instead.
// Plain module with no page code, so the tests can import it.
export const READY_FLAG = 'cruxOpenCard';

// The card address from an 'open-card' message the page sent itself, or null for anything else (another frame,
// another origin, another kind of message).
export function openCardUrl(e, win) {
  if (!e || e.source !== win || e.origin !== win.location.origin) return null;
  const d = e.data;
  return d && d.type === 'open-card' && typeof d.url === 'string' ? d.url : null;
}
