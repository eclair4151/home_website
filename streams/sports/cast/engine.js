/*
 * Sports Stream receiver engine.
 *
 * Works out what a stream really is from its playlists and bytes, and rewrites them so the player can
 * play it. No Cast SDK in here: the same file runs on the Chromecast (receiver.js wires it into the
 * Cast player's hooks) and in the desktop lab (wired into Shaka's network filters).
 *
 * Everything is detected from content, never from a domain:
 *   - a segment link without a media extension (e.g. "…~tplv-origin.image?…") gets a ".ts"/".m4s"
 *     alias in the playlist, so the player doesn't guess the format from a misleading content type;
 *   - a segment with anything in front of its media (an image header, junk) is cut down to the media.
 * Both are no-ops on plain streams, so one "smart" strategy serves every stream we've seen; "direct"
 * (no changes at all) stays on the ladder as the fallback in case smart ever makes things worse.
 */
(function (root) {
  'use strict';

  // Segment paths that already tell the player what they are.
  var MEDIA_EXT = /\.(ts|m2ts|mts|m4s|mp4|m4v|m4a|mp4a|aac|ac3|ec3|mp3|vtt|webvtt|cmfv|cmfa|cmft)$/i;
  // File name of an aliased segment link; the real link rides along in its "u" parameter.
  var ALIAS = '__ss_alias';
  var BOX_TYPES = { ftyp: 1, styp: 1, moof: 1, sidx: 1, moov: 1, emsg: 1, prft: 1 };

  // ---------------------------------------------------------------------------------------------
  // Logging: kept in memory for the debug overlay and the phone.

  var lines = [];
  var listeners = [];
  function log() {
    var line = Array.prototype.map.call(arguments, function (a) {
      return typeof a === 'string' ? a : JSON.stringify(a);
    }).join(' ');
    lines.push(line);
    if (lines.length > 300) lines.shift();
    listeners.forEach(function (fn) { try { fn(line); } catch (e) {} });
  }
  function onLog(fn) { listeners.push(fn); }

  // ---------------------------------------------------------------------------------------------
  // Sniffing segment bytes.

  function isTsAt(d, i) {
    return d[i] === 0x47 && i + 376 < d.length && d[i + 188] === 0x47 && d[i + 376] === 0x47;
  }

  function u32(d, i) {
    return ((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]) >>> 0;
  }

  function isBoxAt(d, i) {
    if (i + 8 > d.length) return false;
    var type = String.fromCharCode(d[i + 4], d[i + 5], d[i + 6], d[i + 7]);
    if (!BOX_TYPES[type]) return false;
    var size = u32(d, i);
    return size >= 8 && i + size <= d.length;
  }

  function isAdtsAt(d, i) {
    if (i + 7 > d.length || d[i] !== 0xff || (d[i + 1] & 0xf6) !== 0xf0) return false;
    var len = ((d[i + 3] & 0x03) << 11) | (d[i + 4] << 3) | ((d[i + 5] & 0xe0) >> 5);
    var next = i + len;
    return len > 7 && next + 1 < d.length && d[next] === 0xff && (d[next + 1] & 0xf6) === 0xf0;
  }

  function prefixKind(d) {
    var s = String.fromCharCode.apply(null, Array.prototype.slice.call(d, 0, 12));
    if (s.slice(0, 4) === 'RIFF' && s.slice(8, 12) === 'WEBP') return 'webp';
    if (d[0] === 0x89 && s.slice(1, 4) === 'PNG') return 'png';
    if (d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff) return 'jpeg';
    if (s.slice(0, 4) === 'GIF8') return 'gif';
    if (s.slice(0, 2) === 'BM') return 'bmp';
    if (s.slice(0, 3) === 'ID3') return 'id3';
    return 'junk';
  }

  /**
   * What a segment is and where its media starts:
   * { container: 'ts'|'fmp4'|'aac'|'unknown', prefix: 'none'|'webp'|'png'|…, offset }.
   */
  function sniff(bytes) {
    var d = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var limit = Math.min(d.length, 65536);
    for (var i = 0; i < limit; i++) {
      var container = isTsAt(d, i) ? 'ts' : isBoxAt(d, i) ? 'fmp4' : isAdtsAt(d, i) ? 'aac' : null;
      if (container) return { container: container, prefix: i ? prefixKind(d) : 'none', offset: i };
    }
    return { container: 'unknown', prefix: prefixKind(d), offset: -1 };
  }

  /**
   * Cut anything in front of a segment's media. An ID3 tag in front of packed audio is part of the
   * format, so that one stays. Returns { data, info, stripped }.
   */
  function inspectSegment(bytes, strip) {
    var d = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var info = sniff(d);
    var cut = strip && info.offset > 0 && info.prefix !== 'id3';
    // slice, not subarray: players read .buffer, which must hold only the media.
    return { data: cut ? d.slice(info.offset) : d, info: info, stripped: cut ? info.offset : 0 };
  }

  // ---------------------------------------------------------------------------------------------
  // Playlists.

  function pathOf(uri) {
    try { return new URL(uri, 'https://relative.invalid/').pathname; } catch (e) { return uri; }
  }

  /**
   * Give segment links without a media extension an alias the player can read the format from.
   * The alias is relative, so it resolves against the playlist exactly like the original did.
   * Master playlists pass through untouched. Returns { text, aliased }.
   */
  function rewritePlaylist(text) {
    if (text.indexOf('#EXTINF') < 0) return { text: text, aliased: 0 };
    var ext = text.indexOf('#EXT-X-MAP') >= 0 ? '.m4s' : '.ts';
    var aliased = 0;
    var out = text.split(/\r?\n/).map(function (line) {
      var uri = line.trim();
      if (!uri || uri.charAt(0) === '#' || MEDIA_EXT.test(pathOf(uri))) return line;
      aliased++;
      return ALIAS + ext + '?u=' + encodeURIComponent(uri);
    }).join('\n');
    return { text: out, aliased: aliased };
  }

  /** The real link behind an aliased segment link; any other link comes back unchanged. */
  function unalias(url) {
    try {
      var u = new URL(url);
      var name = u.pathname.split('/').pop();
      if (name.indexOf(ALIAS + '.') !== 0) return url;
      return new URL(u.searchParams.get('u'), url).href;
    } catch (e) {
      return url;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Strategies and the ladder.

  var STRATEGIES = {
    smart: { id: 'smart', alias: true, strip: true },
    direct: { id: 'direct', alias: false, strip: false },
  };
  var DEFAULT_LADDER = ['smart', 'direct'];

  /**
   * The order to try strategies in. hints.strategies (from the phone: the catalog's rules or what
   * worked last time for this host) goes first; anything it leaves out follows in the default order.
   */
  function ladder(hints) {
    var wanted = (hints && hints.strategies) || [];
    var order = [];
    wanted.concat(DEFAULT_LADDER).forEach(function (id) {
      if (STRATEGIES[id] && order.indexOf(id) < 0) order.push(id);
    });
    return order;
  }

  /**
   * Decides whether playback really started: success once the clock has moved forward on enough
   * consecutive checks (a live stream's first time reading can jump, so one jump doesn't count),
   * failure if that hasn't happened in time.
   */
  function ProgressWatch(opts) {
    this.getTime = opts.getTime;
    this.onSuccess = opts.onSuccess;
    this.onFail = opts.onFail;
    this.needTicks = opts.needTicks || 4;
    this.timeoutSec = opts.timeoutSec || 30;
    this.done = false;
  }
  ProgressWatch.prototype.start = function () {
    var self = this;
    var started = Date.now();
    var last = null;
    var ticks = 0;
    this.timer = setInterval(function () {
      var t = Number(self.getTime());
      if (isFinite(t) && last !== null && t > last + 0.25 && t < last + 5) ticks++;
      last = isFinite(t) ? t : last;
      if (ticks >= self.needTicks) return self.finish(true);
      if ((Date.now() - started) / 1000 > self.timeoutSec) return self.finish(false, 'no progress in ' + self.timeoutSec + 's');
    }, 1000);
    return this;
  };
  ProgressWatch.prototype.finish = function (ok, reason) {
    if (this.done) return;
    this.stop();
    this.done = true;
    if (ok) this.onSuccess(); else this.onFail(reason);
  };
  ProgressWatch.prototype.stop = function () {
    clearInterval(this.timer);
  };

  /** What we've learned about the stream so far, reported to the phone for its learned cache. */
  function newFormat() {
    return { segments: 0, container: null, prefix: null, stripped: 0, aliased: 0 };
  }
  function noteSegment(format, result) {
    format.segments++;
    format.container = result.info.container;
    format.prefix = result.info.prefix;
    if (result.stripped) format.stripped = result.stripped;
    if (format.segments <= 2) {
      log('segment ' + format.segments + ': ' + result.info.container + ', prefix ' + result.info.prefix +
        (result.stripped ? ', stripped ' + result.stripped + ' bytes' : ''));
    }
  }

  root.SSEngine = {
    sniff: sniff,
    inspectSegment: inspectSegment,
    rewritePlaylist: rewritePlaylist,
    unalias: unalias,
    STRATEGIES: STRATEGIES,
    ladder: ladder,
    ProgressWatch: ProgressWatch,
    newFormat: newFormat,
    noteSegment: noteSegment,
    log: log,
    onLog: onLog,
    lines: lines,
  };
})(typeof window !== 'undefined' ? window : globalThis);
