/*
 * Sports Stream Cast receiver: wires engine.js into the Cast Web Receiver SDK.
 *
 * The phone sends a normal LOAD (the stream URL plus game metadata). Optional customData:
 *   { hints: { strategies: ['smart', 'direct'] }, live: true, debug: true }
 * We try each strategy on the ladder until the video is provably playing, and tell the phone how it
 * went on our namespace:
 *   status  { state: 'trying'|'playing'|'failed', strategy, attempt, reason }
 *   result  { strategy, format }      what worked, for the phone to remember per host
 *   error   { code, reason, strategy } a player error after playback had started
 *   log     { line }                   only while debug is on (customData.debug or ?debug)
 * The phone can send { type: 'refreshed', url } to swap in a fresh link (expired token) mid-game, or
 * { type: 'debug', on } to show the log on the TV.
 *
 * The log is always kept (SSEngine.lines; read it over DevTools with tools/cast-lab/cdp.py), but only
 * shows on the TV when playback fails, so a working stream is never covered by it.
 */
(function () {
  'use strict';

  var NS = 'urn:x-cast:com.shemeshapps.easystream';
  var E = window.SSEngine;
  var context = cast.framework.CastReceiverContext.getInstance();
  var player = context.getPlayerManager();
  var debugEl = document.getElementById('debug');

  // The game being played, and how far down the strategy ladder we are.
  var session = {
    media: null,
    customData: {},
    ladder: E.ladder(null),
    step: 0,
    watch: null,
    playing: false,
    debug: /[?&]debug\b/.test(location.search),
    format: E.newFormat(),
  };

  function strategy() {
    return E.STRATEGIES[session.ladder[session.step]] || E.STRATEGIES.direct;
  }

  function send(type, data) {
    var message = { type: type };
    Object.keys(data || {}).forEach(function (k) { message[k] = data[k]; });
    try { context.sendCustomMessage(NS, undefined, message); } catch (e) {}
  }

  E.onLog(function (line) {
    if (!debugEl.hidden) debugEl.textContent = E.lines.slice(-14).join('\n');
    if (session.debug) send('log', { line: line });
  });

  /** Put the log on the TV: only when playback has failed (or the phone asks), never over a working game. */
  function showLog(show) {
    debugEl.hidden = !show;
    if (show) debugEl.textContent = E.lines.slice(-14).join('\n');
  }

  // ---------------------------------------------------------------------------------------------
  // The player hooks: the engine decides, per strategy, whether to change anything.

  // The first few calls of each hook per attempt are logged, so a failure shows exactly which request
  // went where and what the rewrite saw.
  var TRACE_CALLS = 3;
  function traced(kind) {
    session.trace[kind] = (session.trace[kind] || 0) + 1;
    return session.trace[kind] <= TRACE_CALLS;
  }

  var config = new cast.framework.PlaybackConfig();
  // Buffer-first live settings (see SSEngine.shakaConfig): a few seconds behind live, never juddering.
  config.shakaConfig = E.shakaConfig();
  config.manifestRequestHandler = function (request) {
    if (traced('manifestRequest')) E.log('playlist request ' + shorten(request.url));
  };
  config.manifestHandler = function (manifest) {
    // Expected as a string; decoded if it ever arrives as bytes, and handed back the same way.
    var isText = typeof manifest === 'string';
    var text = isText ? manifest : new TextDecoder().decode(manifest);
    var out = strategy().alias ? E.rewritePlaylist(text) : { text: text, aliased: 0 };
    if (traced('manifest')) {
      E.log('playlist ' + (isText ? 'text' : Object.prototype.toString.call(manifest)) + ', ' + text.length +
        ' chars, ' + (text.indexOf('#EXTINF') >= 0 ? 'media' : 'master') + ', aliased ' + out.aliased);
    }
    session.format.aliased = Math.max(session.format.aliased, out.aliased);
    return isText ? out.text : new TextEncoder().encode(out.text);
  };
  config.segmentRequestHandler = function (request) {
    var before = request.url;
    request.url = E.unalias(before);
    if (traced('segmentRequest')) {
      E.log('segment request ' + shorten(before) + (request.url !== before ? ' -> ' + shorten(request.url) : ''));
    }
  };
  config.segmentHandler = function (data) {
    var result = E.inspectSegment(data, strategy().strip);
    E.noteSegment(session.format, result);
    return result.data;
  };

  function shorten(url) {
    var s = String(url);
    return s.length > 90 ? s.slice(0, 60) + '…' + s.slice(-25) : s;
  }

  /** Everything a player error carries (Shaka code, failing URL, HTTP status), as one short line. */
  function describe(value) {
    try {
      var seen = [];
      var json = JSON.stringify(value, function (k, v) {
        if (v && typeof v === 'object') {
          if (seen.indexOf(v) >= 0) return undefined;
          seen.push(v);
        }
        return v;
      });
      return (json || String(value)).slice(0, 400);
    } catch (e) {
      return String(value);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Loading and the ladder.

  /** Set up one attempt: the media's type, and a watch that decides whether it worked. */
  function prepare(request) {
    var media = request.media;
    media.contentType = media.contentType || (/\.mpd(\?|$)/i.test(media.contentUrl || media.contentId) ? 'application/dash+xml' : 'application/x-mpegurl');
    if (session.customData.live !== false) media.streamType = cast.framework.messages.StreamType.LIVE;
    session.playing = false;
    session.format = E.newFormat();
    session.trace = {};
    if (session.watch) session.watch.stop();
    var s = strategy();
    E.log('attempt ' + (session.step + 1) + '/' + session.ladder.length + ': ' + s.id);
    send('status', { state: 'trying', strategy: s.id, attempt: session.step + 1 });
    session.watch = new E.ProgressWatch({
      getTime: function () { return player.getCurrentTimeSec(); },
      onSuccess: function () {
        session.playing = true;
        E.log('playing with ' + s.id + ' (' + session.format.container + ', prefix ' + session.format.prefix + ')');
        send('status', { state: 'playing', strategy: s.id, attempt: session.step + 1 });
        send('result', { strategy: s.id, format: session.format });
      },
      onFail: function (reason) { next(reason); },
    }).start();
  }

  /**
   * Move to the next strategy, or give up and say why. A network error gets one more try with the same
   * strategy first: a dropped request says nothing about whether the strategy suits the stream.
   */
  function next(reason, networkError) {
    E.log('attempt ' + (session.step + 1) + ' failed: ' + reason);
    if (networkError && !session.retried) {
      session.retried = true;
      E.log('network error: retrying ' + strategy().id + ' once');
      return reload(session.media.contentUrl || session.media.contentId);
    }
    if (session.step + 1 >= session.ladder.length) {
      send('status', { state: 'failed', strategy: strategy().id, reason: reason });
      showLog(true);
      return;
    }
    session.step++;
    session.retried = false;
    reload(session.media.contentUrl || session.media.contentId);
  }

  /**
   * Load the same game again (next strategy, or a refreshed link) without the phone's help. The LOAD
   * interceptor runs for this load too, and sets the attempt up.
   */
  function reload(url) {
    var request = new cast.framework.messages.LoadRequestData();
    session.media.contentUrl = url;
    session.media.contentId = url;
    request.media = session.media;
    request.autoplay = true;
    request.customData = Object.assign({}, session.customData, { ssAttempt: session.step });
    player.load(request).catch(function (e) { E.log('reload failed: ' + describe(e)); });
  }

  player.setMessageInterceptor(cast.framework.messages.MessageType.LOAD, function (request) {
    var customData = request.customData || {};
    if (customData.ssAttempt === undefined) {
      // A new game from the phone: start at the top of the ladder.
      session.media = request.media;
      session.customData = customData;
      session.ladder = E.ladder(customData.hints);
      session.step = 0;
      session.retried = false;
      session.debug = session.debug || !!customData.debug;
      showLog(false);
      E.log('load ' + (request.media.contentUrl || request.media.contentId));
    }
    prepare(request);
    return request;
  });

  player.addEventListener(cast.framework.events.EventType.ERROR, function (event) {
    var code = event.detailedErrorCode;
    var reason = (event.error && (event.error.shakaErrorCode || event.error.reason)) || event.reason || '';
    E.log('player error ' + code + ' ' + reason);
    E.log('error detail ' + describe(event.error || event));
    if (session.watch && !session.watch.done) {
      // Shaka's network errors are 1xxx; the Cast SDK reports them as 3xx.
      var network = (code >= 300 && code < 400) || String(reason).charAt(0) === '1';
      session.watch.stop();
      session.watch.done = true;
      next('error ' + code + ' ' + reason, network);
    } else if (session.playing) {
      // Broke after it was playing, e.g. an expired token: the phone may send a fresh link.
      send('error', { code: code, reason: String(reason), strategy: strategy().id });
      showLog(true);
    }
  });

  // A pause the viewer asked for isn't a failure to start.
  player.addEventListener(cast.framework.events.EventType.PAUSE, function () {
    if (session.watch && !session.watch.done) session.watch.stop();
  });

  context.addCustomMessageListener(NS, function (event) {
    var message = event.data || {};
    if (message.type === 'refreshed' && message.url && session.media) {
      E.log('fresh link from the phone');
      reload(message.url);
    } else if (message.type === 'debug') {
      session.debug = !!message.on;
      showLog(session.debug);
    }
  });

  var options = new cast.framework.CastReceiverOptions();
  options.useShakaForHls = true;
  options.playbackConfig = config;
  options.customNamespaces = {};
  options.customNamespaces[NS] = cast.framework.system.MessageType.JSON;
  options.statusText = 'Sports Stream';
  options.versionCode = 1;
  context.start(options);
})();
