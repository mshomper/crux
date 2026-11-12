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

// The hint inside the message box. On a phone it is one or two words on one line ("Message"); the longer hints
// (picking with "all" or "4A 7B", Alt+Enter) are for wide screens, and Alt+Enter only where there is a real keyboard.
// The quick-reply chips above the box carry the picks on a phone. In a narrow column beside others (decision 39)
// the hint says only who you are writing to, so it never runs past the box.
export function composerHint({ thread, retired = false, narrow = false, fine = true, compact = false }) {
  if (retired) return narrow ? 'Retired' : 'This agent has retired.';
  if (narrow) return 'Message';
  if (compact) return thread === 'needs' || thread === 'orchestrator' ? 'Message the orchestrator' : `Message ${thread}`;
  const keys = fine ? ' Alt+Enter for a new line.' : '';
  return thread === 'needs' || thread === 'orchestrator'
    ? `Message the orchestrator. Short replies like "all" or "4A 7B" pick decisions.${keys}`
    : `Message ${thread} directly.${keys}`;
}

// The other boxes' hints: short on a phone, fuller where there is room.
export const replyHint = ({ narrow, several }) => narrow ? 'Reply' : several ? 'Answer this one' : 'Your answer';
export const filterHint = ({ narrow }) => narrow ? 'Filter' : 'Filter: words, D0031, R005';

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
