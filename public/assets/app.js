// soareverix.com: the Era of Intelligence intro, then Karyon's chat.
(() => {
  'use strict';

  const GREETING = 'My name is Karyon, an agent attempting CEV for Michael Andrzejewski. What would you like to know about Michael?';
  // Era of Intelligence: the eyes open, the eclipse passes, and at 0:04 the
  // site cuts straight back to the eyes.
  const CUT_AT = 4.0;
  const MODEL_NAMES = { 'claude-opus-5-5': 'Opus 5.5', 'claude-haiku-5-5': 'Haiku 5.5' };

  const $ = (s) => document.querySelector(s);
  const qs = new URLSearchParams(location.search);
  const root = document.documentElement;
  const body = document.body;
  const log = $('#log');
  const form = $('#ask');
  const input = $('#q');
  const sendBtn = $('#send');
  const note = $('#note');
  const caption = $('#caption');
  const video = $('#intro-video');
  const flash = $('#flash');
  const dock = $('#dock');

  const engine = new window.KaryonASCII.Engine($('#ascii'), $('#glow'));
  const P = engine.params;
  const reduced = engine.reduced;

  let conversationId = null;
  let busy = false;
  let started = false;
  let thinkTarget = 0;
  let introTick = null;
  let lastPointer = -1e9;
  let typing = null;
  let greetingEl = null;

  // ---------- frame hook: intro timeline, thinking glow, idle gaze ----------
  engine.onStep = (time, dt) => {
    if (introTick) introTick(time);
    P.thinking += (thinkTarget - P.thinking) * Math.min(1, dt * 5);
    if (performance.now() - lastPointer > 4000 && document.activeElement !== input) {
      P.gazeX = Math.sin(time * 0.31) * 0.45 + Math.sin(time * 0.73) * 0.15;
      P.gazeY = Math.sin(time * 0.23 + 1) * 0.25;
    }
  };

  function placeUI() {
    const dockH = dock.offsetHeight;
    root.style.setProperty('--dock-h', `${dockH + 6}px`);
    root.style.setProperty('--gutter', `${Math.round(engine.gutter)}px`);
    body.classList.toggle('sides', started && engine.sideMode);
    if (body.classList.contains('chatting')) {
      root.style.setProperty('--log-top', '44px');
    } else {
      // The greeting sits under the eyes, and always fits above the dock.
      const L = engine.layoutFor('hero');
      const under = L.cy + L.eyeW * 0.15 + 10;
      const need = (greetingEl ? greetingEl.el.offsetHeight : 64) + 10;
      root.style.setProperty('--log-top', `${Math.round(Math.max(44, Math.min(under, innerHeight - dockH - 6 - need)))}px`);
    }
  }
  addEventListener('resize', () => setTimeout(placeUI, 150));
  // Keep the input above the on-screen keyboard on phones.
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const fit = () => {
      const covered = Math.max(0, innerHeight - vv.height - vv.offsetTop);
      dock.style.bottom = `${covered}px`;
      log.style.bottom = `calc(var(--dock-h) + ${covered}px)`;
    };
    vv.addEventListener('resize', fit);
    vv.addEventListener('scroll', fit);
  }

  // ---------- intro ----------
  function startIntro() {
    body.classList.add('intro');
    caption.classList.remove('on');
    setPainted(null);
    engine.setMode('hero', true);
    engine.setScene('eyes', {}, { instant: true });
    P.eyeOpen = 0;
    P.eyeFade = 0;
    if (reduced || qs.has('skip')) {
      cutToEyes(true);
      return;
    }
    tryVideo().then((ok) => {
      if (!ok) proceduralIntro();
    });
  }

  // The real Era of Intelligence video, if it has been added to public/media.
  function tryVideo() {
    return new Promise((resolve) => {
      if (qs.has('novideo')) return resolve(false);
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), 2500);
      const sources = [...video.querySelectorAll('source')];
      let failed = 0;
      sources.forEach((s) => s.addEventListener('error', () => ++failed === sources.length && done(false), { once: true }));
      const go = () => {
        if (settled) return;
        video.currentTime = 0;
        video
          .play()
          .then(() => {
            if (settled) return video.pause();
            video.classList.add('playing');
            done(true);
            const watch = () => {
              if (!video.classList.contains('playing')) return;
              if (video.currentTime >= CUT_AT || video.ended) cutToEyes(false);
              else requestAnimationFrame(watch);
            };
            requestAnimationFrame(watch);
          })
          .catch(() => done(false));
      };
      if (video.readyState >= 3) go();
      else video.addEventListener('canplay', go, { once: true });
      if (video.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) done(false);
    });
  }

  // The same beats drawn live in ASCII, on the video's timing: black, the
  // closed eyes at 1.0 s, open by 1.5 s, the eclipse from 2.0 s to totality
  // at 3.25 s, and at 4.0 s a hard cut back to the open eyes.
  function proceduralIntro() {
    const t0 = engine.time;
    let stage = 0;
    introTick = (time) => {
      const t = time - t0;
      if (stage === 0) {
        P.eyeFade = Math.max(0, Math.min(1, (t - 0.9) / 0.2));
        if (t > 1.3) {
          P.eyeOpen = 1;
          stage = 1;
        }
      } else if (stage === 1 && t > 1.95) {
        engine.setScene('eclipse', { phase: 'intro' }, { duration: 0.3 });
        stage = 2;
      } else if (stage === 2 && t >= CUT_AT) {
        stage = 3;
        cutToEyes(false);
      }
    };
  }

  function cutToEyes(skipped) {
    introTick = null;
    video.pause();
    video.classList.remove('playing');
    engine.setScene('eyes', {}, { instant: true });
    P.eyeFade = 1;
    P.eyeOpen = 1;
    P.eyeSnap = true;
    setTimeout(() => (P.eyeSnap = false), 120);
    if (!skipped && !reduced) {
      flash.classList.remove('go');
      void flash.offsetWidth;
      flash.classList.add('go');
    }
    reveal();
  }

  function reveal() {
    body.classList.remove('intro');
    if (started) {
      engine.setMode('chat');
      return;
    }
    body.classList.add('awaiting');
    if (!greetingEl) {
      greetingEl = addMessage('karyon', GREETING);
      greetingEl.el.classList.add('greeting');
    }
    placeUI();
    typeOut(greetingEl, GREETING, () => {
      body.classList.remove('awaiting');
      placeUI();
      if (matchMedia('(pointer: fine)').matches) input.focus({ preventScroll: true });
    });
  }

  function typeOut(msg, text, then) {
    if (typing) typing.finish();
    if (reduced) {
      render(msg, text);
      then();
      return;
    }
    // The untyped text is laid out but hidden, so lines never jump as words
    // wrap and the block keeps its final height from the first letter.
    let i = 0;
    const show = () => {
      msg.body.innerHTML = `<p>${esc(text.slice(0, i))}<span class="caret"></span><span class="ghost">${esc(text.slice(i))}</span></p>`;
    };
    const finish = () => {
      clearInterval(id);
      typing = null;
      render(msg, text);
      then();
    };
    show();
    const id = setInterval(() => {
      i = Math.min(text.length, i + 2);
      show();
      if (i >= text.length) finish();
    }, 26);
    typing = { finish };
  }

  const skipIntro = (e) => {
    if (body.classList.contains('intro')) {
      e.preventDefault();
      cutToEyes(true);
    } else if (typing && !started) {
      typing.finish();
    }
  };
  addEventListener('pointerdown', (e) => {
    if (e.target.closest('#dock')) return;
    skipIntro(e);
  });
  addEventListener('keydown', (e) => {
    if (body.classList.contains('intro') && ['Enter', ' ', 'Escape'].includes(e.key)) skipIntro(e);
  });
  $('#replay').addEventListener('click', (e) => {
    e.stopPropagation();
    startIntro();
  });

  // ---------- the full film ----------
  const film = $('#film');
  const filmVideo = $('#film-video');
  const closeFilm = () => {
    filmVideo.pause();
    film.hidden = true;
    engine.paused = false;
    $('#film-open').focus({ preventScroll: true });
  };
  $('#film-open').addEventListener('click', (e) => {
    e.stopPropagation();
    film.hidden = false;
    engine.paused = true;
    filmVideo.play().catch(() => {});
    $('#film-close').focus({ preventScroll: true });
  });
  $('#film-close').addEventListener('click', closeFilm);
  film.addEventListener('click', (e) => e.target === film && closeFilm());
  addEventListener('keydown', (e) => e.key === 'Escape' && !film.hidden && closeFilm());

  // ---------- gaze ----------
  addEventListener('pointermove', (e) => {
    lastPointer = performance.now();
    const L = engine.layout;
    P.gazeX = Math.max(-1, Math.min(1, ((e.clientX - L.cx) / innerWidth) * 2.4));
    P.gazeY = Math.max(-1, Math.min(1, ((e.clientY - L.cy) / innerHeight) * 2.2));
  });
  input.addEventListener('focus', () => {
    P.gazeX = 0;
    P.gazeY = 0.9;
  });

  // ---------- conversation ----------
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const LINK = /\b((?:https?:\/\/)?(?:www\.)?(?:github\.com\/[\w.\-/]+|soareverix\.com(?:\/[\w.\-/#?=&]*)?))/g;
  function fmt(text) {
    return esc(text)
      .split(/\n{2,}/)
      .map((para) => {
        const html = para
          .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
          .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
          .replace(LINK, (m) => `<a href="${m.startsWith('http') ? m : `https://${m}`}" target="_blank" rel="noopener">${m}</a>`)
          .replace(/\n/g, '<br>');
        return `<p>${html}</p>`;
      })
      .join('');
  }

  function addMessage(who, text) {
    const el = document.createElement('div');
    el.className = `msg ${who}`;
    const label = document.createElement('span');
    label.className = 'who';
    label.textContent = who === 'you' ? 'You' : 'Karyon';
    const bodyEl = document.createElement('div');
    bodyEl.className = 'body';
    el.append(label, bodyEl);
    log.append(el);
    const msg = { el, label, body: bodyEl };
    if (text) render(msg, text);
    return msg;
  }

  function render(msg, text) {
    msg.body.innerHTML = fmt(text);
  }

  function setModel(msg, model) {
    const name = MODEL_NAMES[model];
    if (!name) return;
    let tag = msg.label.querySelector('.model');
    if (!tag) {
      tag = document.createElement('span');
      tag.className = 'model';
      msg.label.append(tag);
    }
    tag.textContent = name;
  }

  // While a reply streams, follow it only until the visitor's question reaches
  // the top of the view, so long replies stay readable from their first line.
  // Scrolling by hand stops the following until the next question.
  let anchor = null;
  let followReply = true;
  function follow() {
    if (!followReply) return;
    const newest = log.scrollHeight - log.clientHeight;
    log.scrollTop = anchor ? Math.min(anchor.offsetTop - 48, newest) : newest;
  }
  const stopFollowing = () => (followReply = false);
  log.addEventListener('wheel', stopFollowing, { passive: true });
  log.addEventListener('touchmove', stopFollowing, { passive: true });

  // ---------- the art at the sides: clicking it asks Karyon about it ----------
  const artLeft = $('#art-left');
  const artRight = $('#art-right');
  let painted = null;
  const leftAsk = () => (painted?.caption ? `Tell me more about ${painted.caption}.` : painted ? 'What are you showing me?' : 'Who are you, Karyon?');
  const rightAsk = 'What does CEV mean?';
  function setPainted(scene) {
    painted = scene && scene.scene !== 'eyes' ? scene : null;
    const label = painted?.caption ? `Ask about ${painted.caption}` : painted ? 'Ask about this' : 'Ask who Karyon is';
    artLeft.querySelector('.hint').textContent = label;
    artLeft.setAttribute('aria-label', label);
  }
  artRight.querySelector('.hint').textContent = 'Ask what CEV means';
  artRight.setAttribute('aria-label', 'Ask what CEV means');
  const wireArt = (button, side, question) => {
    const on = () => (engine.hover = side);
    const off = () => {
      if (engine.hover === side) engine.hover = null;
    };
    button.addEventListener('pointerenter', on);
    button.addEventListener('pointerleave', off);
    button.addEventListener('focus', on);
    button.addEventListener('blur', off);
    button.addEventListener('click', () => {
      P.blinkNow = true;
      ask(question());
      button.blur();
    });
  };
  wireArt(artLeft, 'left', leftAsk);
  wireArt(artRight, 'right', () => rightAsk);

  function paint(scene) {
    engine.setScene(scene.scene, scene);
    setPainted(scene);
    caption.textContent = scene.caption || '';
    caption.classList.toggle('on', Boolean(scene.caption));
  }

  async function readEvents(stream, on) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        let event = 'message';
        let data = '';
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        on(event, parsed);
      }
    }
  }

  async function ask(text) {
    text = text.trim();
    if (!text || busy) return;
    busy = true;
    sendBtn.disabled = true;
    if (typing) typing.finish();
    if (!started) {
      started = true;
      body.classList.add('chatting');
      body.classList.remove('awaiting');
      engine.setMode('chat');
      placeUI();
    }
    anchor = addMessage('you', text).el;
    followReply = true;
    input.value = '';
    grow();
    const reply = addMessage('karyon', '');
    reply.body.classList.add('cursor');
    follow();
    thinkTarget = 1;
    let said = '';
    let trouble = '';
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversation_id: conversationId, message: text }),
      });
      if (!(res.headers.get('content-type') || '').includes('text/event-stream')) {
        let data = {};
        try {
          data = await res.json();
        } catch {}
        if (data.conversation_id) conversationId = data.conversation_id;
        trouble = data.message || (res.status === 404 ? "I'm not awake on this host. The site needs its Cloudflare functions to talk." : 'Something went wrong on my side. Try again?');
      } else {
        await readEvents(res.body, (event, data) => {
          if (event === 'meta') {
            conversationId = data.conversation_id || conversationId;
            setModel(reply, data.model);
          } else if (event === 'scene') {
            paint(data);
          } else if (event === 'text') {
            said += data.delta;
            thinkTarget = 0;
            render(reply, said);
            follow();
          } else if (event === 'error') {
            trouble = data.message || 'Something went wrong on my side.';
          }
        });
      }
    } catch {
      trouble = "I can't reach my thoughts right now. Check your connection and try again?";
    } finally {
      thinkTarget = 0;
      reply.body.classList.remove('cursor');
      if (trouble) {
        if (said) {
          const p = document.createElement('p');
          p.className = 'err';
          p.textContent = trouble;
          reply.body.append(p);
        } else {
          reply.el.classList.add('error');
          render(reply, trouble);
        }
      } else if (!said) {
        render(reply, '…');
      }
      busy = false;
      sendBtn.disabled = false;
      follow();
    }
  }

  function grow() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(140, input.scrollHeight)}px`;
    input.style.overflowY = input.scrollHeight > 140 ? 'auto' : 'hidden';
    placeUI();
  }
  input.addEventListener('input', grow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      ask(input.value);
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    ask(input.value);
  });
  document.querySelectorAll('#chips button').forEach((b) => b.addEventListener('click', () => ask(b.textContent)));

  fetch('/api/status')
    .then((r) => (r.ok ? r.json() : null))
    .then((s) => {
      if (!s) return;
      if (!s.configured) note.textContent = 'Karyon is not connected yet.';
      else if (!s.open) note.textContent = 'Karyon has talked as much as it can today. Its budget resets at midnight UTC.';
    })
    .catch(() => {});

  // ---------- go ----------
  engine.start();
  const boot = () => {
    startIntro();
    placeUI();
    // Test hooks for screenshots: ?scene=planet&mode=chat&t=4&pause=1
    if (qs.has('scene')) {
      const name = qs.get('scene');
      if (qs.get('mode') === 'chat') {
        started = true;
        body.classList.add('chatting');
        engine.setMode('chat', true);
        placeUI();
      }
      engine.setScene(name, { phase: qs.get('phase') || undefined }, { instant: true });
      caption.textContent = qs.get('caption') || '';
      caption.classList.toggle('on', qs.has('caption'));
      setPainted({ scene: name, caption: qs.get('caption') || undefined });
    }
    if (qs.has('t')) {
      // Let the intro set itself up first (it starts after a microtask).
      setTimeout(() => {
        const until = engine.time + Number(qs.get('t'));
        engine.paused = qs.has('pause');
        while (engine.time < until) engine.step(1 / 30);
      }, 30);
    }
  };
  if (document.fonts && document.fonts.load) {
    Promise.race([document.fonts.load('16px "JetBrains Mono"'), new Promise((r) => setTimeout(r, 1200))]).then(() => {
      engine.resize();
      boot();
    });
  } else boot();

  window.__karyon = { engine, ask, paint, startIntro };
})();
