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
 *   log     { line }                   only while debug is on
 * The phone can send { type: 'refreshed', url } to swap in a fresh link (expired token) mid-game.
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
    if (!session.debug) return;
    debugEl.hidden = false;
    debugEl.textContent = E.lines.slice(-14).join('\n');
    send('log', { line: line });
  });

  // ---------------------------------------------------------------------------------------------
  // The player hooks: the engine decides, per strategy, whether to change anything.

  var config = new cast.framework.PlaybackConfig();
  config.manifestHandler = function (text) {
    if (!strategy().alias) return text;
    var out = E.rewritePlaylist(text);
    if (out.aliased && !session.format.aliased) E.log('aliased ' + out.aliased + ' segment links');
    session.format.aliased = Math.max(session.format.aliased, out.aliased);
    return out.text;
  };
  config.segmentRequestHandler = function (request) {
    request.url = E.unalias(request.url);
  };
  config.segmentHandler = function (data) {
    var result = E.inspectSegment(data, strategy().strip);
    E.noteSegment(session.format, result);
    return result.data;
  };

  // ---------------------------------------------------------------------------------------------
  // Loading and the ladder.

  /** Set up one attempt: the media's type, and a watch that decides whether it worked. */
  function prepare(request) {
    var media = request.media;
    media.contentType = media.contentType || (/\.mpd(\?|$)/i.test(media.contentUrl || media.contentId) ? 'application/dash+xml' : 'application/x-mpegurl');
    if (session.customData.live !== false) media.streamType = cast.framework.messages.StreamType.LIVE;
    session.playing = false;
    session.format = E.newFormat();
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

  /** Move to the next strategy, or give up and say why. */
  function next(reason) {
    E.log('attempt ' + (session.step + 1) + ' failed: ' + reason);
    if (session.step + 1 >= session.ladder.length) {
      send('status', { state: 'failed', strategy: strategy().id, reason: reason });
      return;
    }
    session.step++;
    reload(session.media.contentUrl || session.media.contentId);
  }

  /** Load the same game again (next strategy, or a refreshed link) without the phone's help. */
  function reload(url) {
    var request = new cast.framework.messages.LoadRequestData();
    session.media.contentUrl = url;
    session.media.contentId = url;
    request.media = session.media;
    request.autoplay = true;
    request.customData = Object.assign({}, session.customData, { ssAttempt: session.step });
    prepare(request);
    player.load(request).catch(function (e) { E.log('reload failed: ' + (e && e.message || e)); });
  }

  player.setMessageInterceptor(cast.framework.messages.MessageType.LOAD, function (request) {
    var customData = request.customData || {};
    if (customData.ssAttempt === undefined) {
      // A new game from the phone: start at the top of the ladder.
      session.media = request.media;
      session.customData = customData;
      session.ladder = E.ladder(customData.hints);
      session.step = 0;
      session.debug = session.debug || !!customData.debug;
      E.log('load ' + (request.media.contentUrl || request.media.contentId));
    }
    prepare(request);
    return request;
  });

  player.addEventListener(cast.framework.events.EventType.ERROR, function (event) {
    var code = event.detailedErrorCode;
    var reason = (event.error && (event.error.shakaErrorCode || event.error.reason)) || event.reason || '';
    E.log('player error ' + code + ' ' + reason);
    if (session.watch && !session.watch.done) {
      session.watch.finish(false, 'error ' + code + ' ' + reason);
    } else if (session.playing) {
      // Broke after it was playing, e.g. an expired token: the phone may send a fresh link.
      send('error', { code: code, reason: String(reason), strategy: strategy().id });
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
      debugEl.hidden = !session.debug;
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
