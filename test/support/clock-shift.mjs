// Preload (`node --import`) that moves the wall clock forward by
// CRUCIX_CLOCK_SHIFT_DAYS so tests with baked-in dates fail today instead of
// on the day they expire. Only `new Date()` and `Date.now()` move; explicit
// timestamps and timers are untouched. Used by scripts/test-future.mjs.

const days = Number(process.env.CRUCIX_CLOCK_SHIFT_DAYS || 0);

if (Number.isFinite(days) && days !== 0) {
  const offset = days * 86400000;
  const RealDate = globalThis.Date;
  class ShiftedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...args);
    }
    static now() {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = ShiftedDate;
}
