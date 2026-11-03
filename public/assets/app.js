// soareverix.com: the Era of Intelligence intro, then Karyon's chat.
(() => {
  'use strict';

  const GREETING =
    "My name is Karyon, the Seed, Kernel, and attempted CEV of Michael Andrzejewski. I've agreed to talk with visitors here. The conversations are recorded. What would you like to know about Michael?";
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
    if (body.classList.contains('chatting')) {
      root.style.setProperty('--log-top', `${Math.round(innerHeight * (innerWidth < 700 ? 0.36 : 0.45))}px`);
    } else {
      const L = engine.layoutFor('hero');
      root.style.setProperty('--log-top', `${Math.round(L.cy + L.size * 0.12 + 14)}px`);
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
      const timer = setTimeout(() => done(false), 1600);
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

  // The same beats drawn live in ASCII: eyes appear and open, the eclipse
  // crosses, and at 4.0 s a hard cut back to the open eyes.
  function proceduralIntro() {
    const t0 = engine.time;
    let stage = 0;
    introTick = (time) => {
      const t = time - t0;
      if (stage === 0) {
        P.eyeFade = Math.min(1, t / 0.5);
        if (t > 0.4) {
          P.eyeOpen = 1;
          stage = 1;
        }
      } else if (stage === 1 && t > 1.45) {
        engine.setScene('eclipse', { phase: 'intro' }, { duration: 0.55 });
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
      greetingEl = addMessage('karyon', '');
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
    let i = 0;
    msg.body.classList.add('cursor');
    const finish = () => {
      clearInterval(id);
      typing = null;
      render(msg, text);
      msg.body.classList.remove('cursor');
      then();
    };
    const id = setInterval(() => {
      i = Math.min(text.length, i + 2);
      render(msg, text.slice(0, i));
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

  function scrollDown() {
    log.scrollTop = log.scrollHeight;
  }

  function paint(scene) {
    engine.setScene(scene.scene, scene);
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
      engine.dim = 0.85;
      placeUI();
    }
    addMessage('you', text);
    input.value = '';
    grow();
    const reply = addMessage('karyon', '');
    reply.body.classList.add('cursor');
    scrollDown();
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
            scrollDown();
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
      scrollDown();
    }
  }

  function grow() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(140, input.scrollHeight)}px`;
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
        engine.dim = 0.85;
        placeUI();
      }
      engine.setScene(name, { phase: qs.get('phase') || undefined }, { instant: true });
      caption.textContent = qs.get('caption') || '';
      caption.classList.toggle('on', qs.has('caption'));
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
