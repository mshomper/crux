// The page's cursor on the live stream: which message it has applied, and what to do with the next one.
// Pure (no page objects) so a test runs it. `s` is { seq, seqSeen, boot2 }.

// A resync comes first and always: after a restart the new hub's ids start again from a small number, below this page's,
// so the id check would throw it away. A message with an id this page has already applied (it was in the state it read)
// is dropped. Returns 'resync' (read the state again), 'drop' or 'apply'.
export function streamStep(s, id, ev) {
  if (ev?.type === 'resync') { s.seq = 0; s.seqSeen = 0; return 'resync'; }
  if (id && id <= s.seq) return 'drop';
  if (id) { s.seq = id; s.seqSeen = Math.max(s.seqSeen, id); }
  return 'apply';
}

// After a state read: the stream picks up from where that state was taken. True when the stream had already run ahead of
// it (messages came while it was on its way), so the link should reconnect and resume from the state's id.
export function afterStateRead(s, stream) {
  const ahead = s.seqSeen > (stream?.seq || 0);
  s.boot2 = stream?.boot || null;
  s.seq = stream?.seq || 0;
  s.seqSeen = s.seq;
  return ahead;
}

// The address the page connects to: resuming after the last message applied, when it knows which hub it was.
export const streamUrl = s => (s.boot2 ? `/api/stream?boot=${encodeURIComponent(s.boot2)}&last=${s.seq}` : '/api/stream');
