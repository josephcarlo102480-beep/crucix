// Classic script, also executable in a small VM for behavioral tests.
(function (global) {
  'use strict';
  function createLiveUpdates({
    applySnapshot, onState = () => {}, onSweep = () => {}, onError = () => {},
    fetchImpl = global.fetch.bind(global), EventSourceImpl = global.EventSource,
    schedule = global.setTimeout.bind(global), cancel = global.clearTimeout.bind(global),
    documentImpl = global.document,
  }) {
    let stream = null, retry = null, refreshRetry = null, pending = null, stopped = false, revision = 0, sweepRevision = 0;
    function refresh() {
      if (stopped || pending) return pending?.promise;
      const startedAtRevision = revision;
      const startedAtSweepRevision = sweepRevision;
      const controller = new AbortController();
      const timeout = schedule(() => controller.abort(), 10000);
      pending = { controller, promise: null };
      pending.promise = (async () => {
        try {
          const response = await fetchImpl('/api/data', { cache: 'no-store', signal: controller.signal });
          if (!response.ok) throw new Error(`Snapshot unavailable (${response.status})`);
          const data = await response.json();
          if (stopped || startedAtRevision !== revision) return;
          applySnapshot(data);
          if (startedAtSweepRevision === sweepRevision) onSweep(Boolean(data.runtime?.sweepInProgress));
          onState(stream?.readyState === 1 ? 'live' : 'reconnecting');
        } catch (error) {
          if (stopped || startedAtRevision !== revision) return;
          onState('stale');
          onError(error);
          if (!refreshRetry) refreshRetry = schedule(() => { refreshRetry = null; refresh(); }, 5000);
        } finally {
          cancel(timeout);
          pending = null;
        }
      })();
      return pending.promise;
    }
    function connect() {
      if (stopped || !EventSourceImpl) return;
      onState('connecting');
      stream = new EventSourceImpl('/events');
      stream.onopen = () => { refresh(); };
      stream.onmessage = event => {
        if (stopped) return;
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'update' && message.data) {
            revision++;
            sweepRevision++;
            applySnapshot(message.data);
            onSweep(false);
            onState('live');
          } else if (message.type === 'connected') {
            sweepRevision++;
            onSweep(Boolean(message.sweepInProgress));
          } else if (message.type === 'sweep_start') { sweepRevision++; onSweep(true); }
          else if (message.type === 'sweep_error') { sweepRevision++; onSweep(false); onError(new Error(message.error || 'Sweep failed')); }
        } catch (error) { onError(error); }
      };
      stream.onerror = () => {
        if (stopped) return;
        stream.close();
        onState('reconnecting');
        if (!retry) retry = schedule(() => { retry = null; connect(); }, 5000);
      };
    }
    function onVisibility() { if (!documentImpl.hidden) refresh(); }
    documentImpl?.addEventListener('visibilitychange', onVisibility);
    connect();
    return {
      refresh,
      stop() {
        stopped = true;
        stream?.close();
        if (retry) cancel(retry);
        if (refreshRetry) cancel(refreshRetry);
        pending?.controller.abort();
        documentImpl?.removeEventListener('visibilitychange', onVisibility);
      },
    };
  }
  global.CrucixLiveUpdates = { createLiveUpdates };
})(globalThis);
