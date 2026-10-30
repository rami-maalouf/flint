type RevisionObservation = {
  getSnapshot(): unknown;
  subscribe(listener: () => void): () => void;
  close(): void;
};

export function observeRevisions(observed: RevisionObservation, current: () => boolean, changed: () => void) {
  let previous: number | null = null;
  let closed = false;
  const receive = () => {
    const snapshot = observed.getSnapshot() as { data?: { revision: number } | null };
    if (closed || !current() || !snapshot.data) return;
    const revision = snapshot.data.revision;
    // the first snapshot closes the gap between fetching and subscribing.
    if (revision !== previous) { previous = revision; changed(); }
  };
  const unsubscribe = observed.subscribe(receive);
  receive();
  return () => { closed = true; unsubscribe(); observed.close(); };
}
