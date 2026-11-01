/*
 * Sports Stream Cast receiver: wires engine.js into the Cast Web Receiver SDK.
 *
 * The phone sends a normal LOAD (the stream URL plus game metadata). Optional customData:
 *   { hints: { strategies: ['smart', 'direct'] }, live: true, debug: true }
 * We try each strategy on the ladder until the video is provably playing, and tell the phone how it
 * went on our namespace:
 *   status  { state: 'trying'|'playing'|'failed'|'recovering', strategy, attempt, reason, step }
 *   result  { strategy, format }      what worked, for the phone to remember per host
 *   error   { code, reason, strategy } a player error after playback had started
 *   log     { line }                   only while debug is on (customData.debug or ?debug)
 *   refresh {}                         the link may have expired: capture a fresh one, please
 * The phone can send { type: 'refreshed', url } to swap in a fresh link (expired token) mid-game, or
 * { type: 'debug', on } to show the log on the TV.
 *
 * Once a game has played, the receiver keeps it playing without the phone (see Recovery): a stuck
 * game gets a jump to the live edge, then reloads of the same link for as long as it's on. If no
 * strategy works at all, the ladder starts over a little later. Only an expired link needs the phone,
 * which every reload asks for ('refresh').
 *
 * The log is always kept (SSEngine.lines; read it over DevTools with tools/cast-lab/cdp.py), but only
 * shows on the TV when playback fails, and comes down again once the video is moving, so a working
 * stream is never covered by it.
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
    restarts: 0,        // times the whole ladder has started over for this game
    restartTimer: null,
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

  // Watches the playhead while the log is up for a failure: a stall can throw an error and then
  // recover on its own seconds later, and the log shouldn't stay over a game that's playing again.
  var recovery = null;
  // The phone asked for the log on the TV ({ type: 'debug', on: true }), so it stays up regardless.
  var logPinned = false;

  function showFailure() {
    showLog(true);
    stopRecovery();
    recovery = new E.ProgressWatch({
      getTime: function () { return player.getCurrentTimeSec(); },
      timeoutSec: Infinity,
      onSuccess: function () {
        recovery = null;
        E.log('playing again');
        if (!session.playing) markPlaying();
        hideFailure();
      },
      onFail: function () {},
    }).start();
  }

  function stopRecovery() {
    if (recovery) recovery.stop();
    recovery = null;
  }

  function hideFailure() {
    stopRecovery();
    if (!logPinned) showLog(false);
  }

  /** The video is provably moving with the current strategy: tell the phone what worked. */
  function markPlaying() {
    var s = strategy();
    session.playing = true;
    session.restarts = 0;
    clearTimeout(session.restartTimer);
    resetRescue();
    E.log('playing with ' + s.id + ' (' + session.format.container + ', prefix ' + session.format.prefix + ')');
    send('status', { state: 'playing', strategy: s.id, attempt: session.step + 1 });
    send('result', { strategy: s.id, format: session.format });
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
    session.format = E.newFormat();
    session.trace = {};
    if (session.watch) session.watch.stop();
    // A recovery reload: this strategy has played, and the supervisor judges whether it took.
    if (request.customData && request.customData.ssRecover) return;
    session.playing = false;
    stopRecovery(); // this attempt's own watch takes the log down if it plays
    var s = strategy();
    E.log('attempt ' + (session.step + 1) + '/' + session.ladder.length + ': ' + s.id);
    send('status', { state: 'trying', strategy: s.id, attempt: session.step + 1 });
    session.watch = new E.ProgressWatch({
      getTime: function () { return player.getCurrentTimeSec(); },
      onSuccess: function () {
        markPlaying();
        hideFailure();
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
      showFailure();
      scheduleRestart();
      return;
    }
    session.step++;
    session.retried = false;
    reload(session.media.contentUrl || session.media.contentId);
  }

  /**
   * Every strategy failed: run the ladder again from the top later (30 s, 60 s, then every 2 minutes),
   * in case the source was only down. A late start in the meantime cancels it (see markPlaying).
   */
  function scheduleRestart() {
    var wait = Math.min(30 * Math.pow(2, session.restarts), 120);
    session.restarts++;
    E.log('starting over in ' + wait + 's');
    clearTimeout(session.restartTimer);
    session.restartTimer = setTimeout(function () {
      session.restartTimer = null;
      if (rescue.stopped || session.playing || !session.media) return;
      session.step = 0;
      session.retried = false;
      reload(session.media.contentUrl || session.media.contentId);
    }, wait * 1000);
  }

  /**
   * Load the same game again (next strategy, a refreshed link, or a recovery reload) without the
   * phone's help. The LOAD interceptor runs for this load too, and sets the attempt up.
   */
  function reload(url, recover) {
    var request = new cast.framework.messages.LoadRequestData();
    session.media.contentUrl = url;
    session.media.contentId = url;
    request.media = session.media;
    request.autoplay = true;
    request.customData = Object.assign({}, session.customData, { ssAttempt: session.step, ssRecover: !!recover });
    player.load(request).catch(function (e) { E.log('reload failed: ' + describe(e)); });
  }

  // ---------------------------------------------------------------------------------------------
  // Recovery: once a game has played, keep it playing without the phone.

  var PlayerState = cast.framework.messages.PlayerState;
  // How long the playhead may sit still before the game counts as stuck: 20 s in all, so Shaka can
  // refill after a short hiccup by itself (often ~10 s on these sources), but only 8 s of that while
  // the player claims to be playing (a frozen picture) or 5 s idle (an error, or an unexpected end).
  var STUCK_SEC = 20;
  var STUCK_IN_STATE_SEC = {};
  STUCK_IN_STATE_SEC[PlayerState.PLAYING] = 8;
  STUCK_IN_STATE_SEC[PlayerState.IDLE] = 5;
  var STEADY_SEC = 60; // playing this long after a step, and the next stall starts again at step 1

  var rescue = {
    level: 0, reloads: 0, last: null, movedAt: 0, actedAt: 0, holdUntil: 0, stopped: false,
    state: null, stateSince: 0,
  };

  function resetRescue() {
    rescue.level = 0;
    rescue.reloads = 0;
    rescue.last = null;
    rescue.movedAt = Date.now();
    rescue.holdUntil = 0;
  }

  /**
   * Once a second: has the game been stuck long enough to step in? Only after it has played (before
   * that the strategy ladder is in charge), and never while the viewer has it paused or stopped.
   */
  setInterval(function () {
    if (!session.playing || rescue.stopped) return;
    var now = Date.now();
    var t = Number(player.getCurrentTimeSec());
    // Moving: forward at about real speed. A seek or reload jumps, which proves nothing.
    if (isFinite(t) && rescue.last !== null && t > rescue.last + 0.1 && t < rescue.last + 5) rescue.movedAt = now;
    if (isFinite(t)) rescue.last = t;
    var state = player.getPlayerState();
    if (state !== rescue.state) { rescue.state = state; rescue.stateSince = now; }
    if (state === PlayerState.PAUSED) { rescue.movedAt = now; return; }
    if (rescue.level > 0 && now - rescue.movedAt < 2000 && now - rescue.actedAt > STEADY_SEC * 1000) {
      E.log('steady for ' + STEADY_SEC + 's: recovery starts over at step 1');
      rescue.level = 0;
      rescue.reloads = 0;
    }
    if (now < rescue.holdUntil) return;
    // A state's own limit counts from when it began: buffering that has just turned into playing
    // hasn't had a chance to move the playhead yet.
    var still = now - rescue.movedAt;
    var stillInState = now - Math.max(rescue.movedAt, rescue.stateSince);
    var inStateLimit = STUCK_IN_STATE_SEC[state];
    if (still >= STUCK_SEC * 1000 || (inStateLimit && stillInState >= inStateLimit * 1000)) {
      rescueStep(state, Math.round(still / 1000));
    }
  }, 1000);

  /**
   * The next, heavier way out, then a wait for it to take hold:
   *   1. nudge: jump to the live edge and play (fell behind the live window, or a stuck decoder)
   *   2+ reload: load the same link with the strategy that played, like a recast without the phone,
   *      waiting longer each time (20 s, 40 s, then every minute) for as long as the game is on: a
   *      source that's down for a few minutes should come back by itself, not leave a dead screen.
   * Each reload also asks the phone for a fresh link ('refresh'), in case this one has expired; the
   * phone decides how often it's worth capturing one.
   */
  function rescueStep(state, stuckSec) {
    var now = Date.now();
    var nudging = rescue.level === 0 && state !== PlayerState.IDLE;
    rescue.level++;
    rescue.actedAt = now;
    rescue.movedAt = now;
    showFailure();
    if (nudging) {
      rescue.holdUntil = now + 10 * 1000;
      E.log('stuck ' + stuckSec + 's (' + state + '): jumping to the live edge');
      nudge();
    } else {
      rescue.reloads++;
      rescue.holdUntil = now + Math.min(10 * Math.pow(2, rescue.reloads), 60) * 1000;
      E.log('stuck ' + stuckSec + 's (' + state + '): reload ' + rescue.reloads + ' with ' + strategy().id);
      reload(session.media.contentUrl || session.media.contentId, true);
      send('refresh', {});
    }
    send('status', { state: 'recovering', step: nudging ? 'nudge' : 'reload', attempt: rescue.level, strategy: strategy().id });
  }

  /**
   * A fresh link from the phone. Still stuck: load it now, and give it time to start. Playing again by
   * the time it came (the last reload worked): keep it for the next reload rather than interrupt the
   * game. Not started yet: retry the current strategy with it.
   */
  function freshLink(url) {
    var now = Date.now();
    if (!session.playing) {
      E.log('fresh link from the phone');
      return reload(url);
    }
    if (now - rescue.movedAt < 3000) {
      E.log('fresh link from the phone: playing, so kept for the next reload');
      session.media.contentUrl = url;
      session.media.contentId = url;
      return;
    }
    E.log('fresh link from the phone: reloading with it');
    rescue.actedAt = now;
    rescue.movedAt = now;
    rescue.holdUntil = now + 20 * 1000;
    reload(url, true);
  }

  /** Seek to where a fresh start would begin (the same delay behind live), and play. */
  function nudge() {
    try {
      var range = player.getLiveSeekableRange();
      if (range && isFinite(range.end) && range.end > (range.start || 0)) {
        var delay = config.shakaConfig.manifest.defaultPresentationDelay;
        player.seek(Math.max(range.start || 0, range.end - delay));
      }
      player.play();
    } catch (e) {
      E.log('nudge failed: ' + describe(e));
    }
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
      session.restarts = 0;
      clearTimeout(session.restartTimer);
      rescue.stopped = false;
      resetRescue();
      hideFailure();
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
      showFailure();
    }
  });

  // A pause the viewer asked for isn't a failure to start.
  player.addEventListener(cast.framework.events.EventType.PAUSE, function () {
    if (session.watch && !session.watch.done) session.watch.stop();
  });

  // Stopped from the phone (or Google Home): nothing to recover until the next game.
  player.addEventListener(cast.framework.events.EventType.REQUEST_STOP, function () {
    rescue.stopped = true;
    clearTimeout(session.restartTimer);
    hideFailure();
  });

  context.addCustomMessageListener(NS, function (event) {
    var message = event.data || {};
    if (message.type === 'refreshed' && message.url && session.media) {
      freshLink(message.url);
    } else if (message.type === 'debug') {
      session.debug = !!message.on;
      logPinned = session.debug;
      if (logPinned) showLog(true); else hideFailure();
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
