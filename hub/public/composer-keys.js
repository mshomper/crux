// Enter in a chat box: Enter sends; Alt+Enter and Shift+Enter start a new line at the cursor.
// A phone keyboard's return key keeps the behaviour it has always had: it sends.

// What a keydown should do: 'send', 'newline' (insert one ourselves: browsers add nothing on Alt+Enter), or
// 'native' (leave it to the browser, which already adds a line on Shift+Enter).
export function enterAction(e) {
  if (e.key !== 'Enter') return 'native';
  if (e.ctrlKey || e.metaKey) return 'native';
  if (e.altKey) return 'newline';
  if (e.shiftKey) return 'native';
  return 'send';
}

// Put a line break where the cursor is, replacing any selection. insertText keeps it on the browser's undo list;
// where that is missing (or in tests), the text is spliced in directly.
export function insertLineBreak(box) {
  const doc = box.ownerDocument;
  if (doc?.activeElement === box && doc.execCommand?.('insertText', false, '\n')) return;
  const { selectionStart: a, selectionEnd: b, value } = box;
  box.value = value.slice(0, a) + '\n' + value.slice(b);
  box.selectionStart = box.selectionEnd = a + 1;
  box.dispatchEvent?.(new Event('input', { bubbles: true }));
}
