/**
 * Business-date utilities for Tropicool Treats.
 *
 * All stocktakes, cash counts, history, and expiry calculations must key off
 * the Australia/Brisbane calendar date, not the device's local timezone and
 * not raw UTC. Brisbane (Queensland) does not observe daylight saving, so
 * this timezone is a fixed UTC+10 offset year-round -- but the *device*
 * running this code can be in any timezone, including ones that do observe
 * daylight saving. Every function here derives the Brisbane date from the
 * absolute instant (epoch milliseconds) via Intl.DateTimeFormat, which is
 * timezone-correct regardless of the device's local clock/offset. Never
 * derive a business date from `new Date().getHours()`, `getDate()`, or
 * manual UTC offset arithmetic -- both silently break the moment a staff
 * member's phone is set to a different timezone or a browser polyfill fakes
 * `Date`.
 */
  var BRISBANE_TZ = 'Australia/Brisbane';

  var partsFormatter = new Intl.DateTimeFormat('en-AU', {
    timeZone: BRISBANE_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });

  function pad2(n) { return String(n).padStart(2, '0'); }

  /**
   * Returns the Brisbane wall-clock date/time components for `instant`.
   * @param {Date} [instant]
   */
  function getBrisbaneParts(instant) {
    instant = instant || new Date();
    var parts = partsFormatter.formatToParts(instant);
    var map = {};
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type !== 'literal') map[parts[i].type] = parts[i].value;
    }
    // Some ICU implementations render midnight as hour "24" with hour12:false.
    var hour = map.hour === '24' ? 0 : Number(map.hour);
    return {
      year: Number(map.year),
      month: Number(map.month),
      day: Number(map.day),
      hour: hour,
      minute: Number(map.minute),
      second: Number(map.second)
    };
  }

  /** Australia/Brisbane calendar date for `instant`, as 'YYYY-MM-DD'. */
  function brisbaneDateISO(instant) {
    var p = getBrisbaneParts(instant);
    return p.year + '-' + pad2(p.month) + '-' + pad2(p.day);
  }

  /** Australia/Brisbane wall-clock time for `instant`, as 'HH:MM' (24h). */
  function brisbaneTimeHM(instant) {
    var p = getBrisbaneParts(instant);
    return pad2(p.hour) + ':' + pad2(p.minute);
  }

  /**
   * The business date a stocktake/cash-count/expiry check should be filed
   * under. Defaults to the plain Brisbane calendar date (`cutoverHour = 0`).
   * If a trading day runs past midnight (e.g. closes 1am), pass a
   * `cutoverHour` (1-23) so counts taken after midnight but before that hour
   * roll back onto the previous business date instead of starting a new one.
   * @param {Date} [instant]
   * @param {number} [cutoverHour] 0-23, default 0 (no rollover)
   */
  function brisbaneBusinessDate(instant, cutoverHour) {
    instant = instant || new Date();
    cutoverHour = cutoverHour || 0;
    if (cutoverHour === 0) return brisbaneDateISO(instant);
    var p = getBrisbaneParts(instant);
    if (p.hour < cutoverHour) {
      var shifted = new Date(instant.getTime() - 24 * 3600 * 1000);
      return brisbaneDateISO(shifted);
    }
    return brisbaneDateISO(instant);
  }

  /** True if `dateISO` ('YYYY-MM-DD') is today's Brisbane calendar date. */
  function isBrisbaneToday(dateISO, instant) {
    return dateISO === brisbaneDateISO(instant);
  }

  function isoToUTCMidnight(dateISO) {
    var parts = dateISO.split('-').map(Number);
    return Date.UTC(parts[0], parts[1] - 1, parts[2]);
  }

  /** Calendar-accurate whole days between two 'YYYY-MM-DD' dates (b - a). */
  function daysBetween(aISO, bISO) {
    return Math.round((isoToUTCMidnight(bISO) - isoToUTCMidnight(aISO)) / 86400000);
  }

  /** Add `n` calendar days to a 'YYYY-MM-DD' date, returning 'YYYY-MM-DD'. */
  function addDays(dateISO, n) {
    var ms = isoToUTCMidnight(dateISO) + n * 86400000;
    var d = new Date(ms);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  /**
   * Human-friendly Brisbane-local formatting of a 'YYYY-MM-DD' business date,
   * e.g. for headings. Always renders as the Brisbane calendar date -- never
   * shifts to an adjacent day even when formatted on a device far from UTC+10,
   * because it's anchored to UTC noon of that calendar day before formatting.
   */
  function formatBrisbaneDate(dateISO, opts) {
    opts = opts || { weekday: 'short', month: 'short', day: 'numeric' };
    var parts = dateISO.split('-').map(Number);
    var noonUTC = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12, 0, 0));
    var fmt = Object.assign({}, opts, { timeZone: BRISBANE_TZ });
    return new Intl.DateTimeFormat('en-AU', fmt).format(noonUTC);
  }

  /**
   * Human-friendly Brisbane-local formatting of a full ISO instant (e.g.
   * occurred_at/created_at timestamps), not a pre-computed business-date
   * field. Converts via brisbaneDateISO first rather than naively slicing
   * the instant's UTC date -- an instant logged 10am Brisbane or earlier
   * is still "yesterday" in UTC, which a plain slice would get wrong.
   */
  function formatBrisbaneInstant(isoInstant, opts) {
    return formatBrisbaneDate(brisbaneDateISO(new Date(isoInstant)), opts);
  }

  export {
    BRISBANE_TZ,
    getBrisbaneParts,
    brisbaneDateISO,
    brisbaneTimeHM,
    brisbaneBusinessDate,
    isBrisbaneToday,
    daysBetween,
    addDays,
    formatBrisbaneDate,
    formatBrisbaneInstant,
  };
