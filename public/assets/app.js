// soareverix.com: the eyes wake and look around, then Karyon's chat.
(() => {
  'use strict';

  const GREETING = 'My name is Karyon, an agent attempting CEV for Michael Andrzejewski. What would you like to know about Michael?';
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
  let modelExpression = null;
  let closed = false;
  let glance = { at: 0, x: 0, y: 0 };
  let speakTarget = 0;

  // ---------- frame hook: intro timeline, thinking glow, idle gaze ----------
  engine.onStep = (time, dt) => {
    if (introTick) introTick(time);
    P.thinking += (thinkTarget - P.thinking) * Math.min(1, dt * 5);
    P.speaking = (P.speaking || 0) + (speakTarget - (P.speaking || 0)) * Math.min(1, dt * 4);
    placeEyeButton();
    // Thinking narrows the eyes. Otherwise they hold whatever Karyon last chose.
    if (!introTick && !closed) P.expression = thinkTarget > 0 ? 'focused' : modelExpression || 'wide';
    // Left alone, the eyes look around: they hold a spot, then move to a new one.
    if (!introTick && !closed && performance.now() - lastPointer > 4000 && document.activeElement !== input && time > glance.at) {
      glance = { at: time + 1.1 + Math.random() * 2.6, x: (Math.random() - 0.5) * 1.5, y: (Math.random() - 0.5) * 0.9 };
      P.gazeX = glance.x;
      P.gazeY = glance.y;
    }
  };

  function placeUI() {
    const dockH = dock.offsetHeight;
    root.style.setProperty('--dock-h', `${dockH + 6}px`);
    root.style.setProperty('--stage', `${Math.round(engine.stageW)}px`);
    root.style.setProperty('--band', `${engine.bandH}px`);
    body.classList.toggle('sides', engine.sideMode);
    const art = engine.artRect;
    root.style.setProperty('--art-y', `${art.y}px`);
    if (body.classList.contains('chatting')) {
      root.style.setProperty('--log-top', engine.sideMode ? '44px' : `${engine.bandH}px`);
    } else {
      // The greeting sits under the eyes, and always fits above the dock.
      const L = engine.layoutFor('hero');
      const under = L.cy + L.eyeW * 0.2 + 10;
      const need = (greetingEl ? greetingEl.el.offsetHeight : 64) + 10;
      root.style.setProperty('--log-top', `${Math.round(Math.max(44, Math.min(under, innerHeight - dockH - 6 - need)))}px`);
    }
    placeEyeButton();
  }
  // The eyes move when a painting arrives, so their button follows them.
  function placeEyeButton() {
    const r = engine.eyeRect;
    Object.assign(artRight.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.W}px`, height: `${r.H}px` });
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
  // One intro for everyone: black, the eyes open, look around the room, find the
  // visitor, and blink. It's drawn live, so it plays the same on every load.
  function startIntro() {
    body.classList.add('intro');
    caption.classList.remove('on');
    setPainted(null);
    engine.setMode('hero', true);
    engine.setScene('eyes', {}, { instant: true });
    P.eyeOpen = 0;
    P.eyeFade = 0;
    P.expression = 'wide';
    P.gazeX = 0;
    P.gazeY = 0;
    if (reduced || qs.has('skip')) {
      endIntro(true);
      return;
    }
    const t0 = engine.time;
    const beats = [
      [0.55, () => (P.eyeFade = 1)],
      [0.75, () => (P.eyeOpen = 1)],
      [1.45, () => { P.gazeX = -0.95; P.gazeY = -0.15; }],
      [2.15, () => { P.gazeX = 0.95; P.gazeY = 0.2; }],
      [2.85, () => { P.gazeX = 0.1; P.gazeY = -0.55; P.expression = 'focused'; }],
      [3.4, () => { P.gazeX = 0; P.gazeY = 0.35; P.expression = 'wide'; }],
      [3.75, () => (P.blinkNow = true)],
      [4.05, () => endIntro(false)],
    ];
    let next = 0;
    introTick = (time) => {
      while (next < beats.length && time - t0 >= beats[next][0]) beats[next++][1]();
    };
  }

  function endIntro(skipped) {
    introTick = null;
    P.eyeFade = 1;
    P.eyeOpen = 1;
    P.expression = 'wide';
    if (skipped) {
      P.eyeSnap = true;
      setTimeout(() => (P.eyeSnap = false), 120);
    }
    lastPointer = performance.now() - 2500; // a moment's rest before they wander
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
      endIntro(true);
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

  // ---------- the page without the chat ----------
  const staticPage = $('#static');
  function showStatic() {
    staticPage.hidden = false;
    body.classList.add('static', 'chatting');
    body.classList.remove('intro', 'awaiting');
    if (engine.mode !== 'chat') engine.setMode('chat');
    placeUI();
    staticPage.scrollTop = 0;
  }
  function hideStatic() {
    staticPage.hidden = true;
    body.classList.remove('static');
    if (!started) {
      body.classList.remove('chatting');
      engine.setMode('hero');
    }
    placeUI();
  }
  $('#read-open').addEventListener('click', (e) => {
    e.stopPropagation();
    if (typing) typing.finish();
    showStatic();
    staticPage.focus({ preventScroll: true });
  });
  $('#read-close').addEventListener('click', hideStatic);
  addEventListener('keydown', (e) => e.key === 'Escape' && !staticPage.hidden && !closed && hideStatic());

  const closingDate = (iso) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  // The page as it stays once Karyon has closed the conversation: the eyes shut,
  // no chat, and everything Karyon could have said written out.
  function settleClosed(until, parting) {
    closed = true;
    P.eyeOpen = 0;
    introTick = null;
    setPainted(null);
    // Only a painting needs to dissolve. Eyes alone change with no glitch.
    engine.setScene('eyes', {}, { instant: !engine.hasArt });
    caption.classList.remove('on');
    $('#read-close').hidden = true;
    const note2 = $('#closed-note');
    note2.hidden = false;
    $('#closed-text').textContent = `Karyon ended this conversation.${until ? ` It can talk with you again on ${closingDate(until)}.` : ''} Michael reads the transcripts, and the rest of this page is everything Karyon would have told you.`;
    const last = $('#closed-parting');
    last.hidden = !parting;
    last.textContent = parting || '';
    showStatic();
    // Nothing moves from here on, so stop drawing once the eyes have shut.
    const rest = setInterval(() => {
      if (engine.morph || engine.eyeState.open > 0.02) return;
      clearInterval(rest);
      engine.paused = true;
    }, 200);
  }

  // ---------- lightning ----------
  function strike(until, parting) {
    closed = true;
    P.expression = 'suspicious';
    P.gazeX = 0.9;
    P.gazeY = 0.4;
    input.disabled = true;
    sendBtn.disabled = true;
    if (reduced) {
      settleClosed(until, parting);
      return;
    }
    // Time to read the last line, then the bolt comes down on the input.
    const box = form.getBoundingClientRect();
    const hitX = box.left + box.width / 2;
    const hitY = box.top + box.height / 2;
    setTimeout(() => {
      engine.strike(hitX + (Math.random() - 0.5) * 240, -20, hitX, hitY);
      flash.classList.remove('go');
      void flash.offsetWidth;
      flash.classList.add('go');
      body.classList.add('struck');
    }, 1500);
    setTimeout(() => engine.strike(hitX + 80 + Math.random() * 200, -20, hitX + (Math.random() - 0.5) * 120, hitY), 1760);
    setTimeout(() => (P.eyeOpen = 0), 2300);
    setTimeout(() => {
      body.classList.remove('struck');
      settleClosed(until, parting);
    }, 2900);
  }

  // ---------- gaze ----------
  addEventListener('pointermove', (e) => {
    lastPointer = performance.now();
    if (closed || introTick) return;
    const L = engine.layout;
    P.gazeX = Math.max(-1, Math.min(1, ((e.clientX - L.cx) / innerWidth) * 2.4));
    P.gazeY = Math.max(-1, Math.min(1, ((e.clientY - L.cy) / innerHeight) * 2.2));
  });
  input.addEventListener('focus', () => {
    if (closed) return;
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

  // ---------- the art and the eyes: clicking them asks Karyon about them ----------
  const artLeft = $('#art-left');
  const artRight = $('#art-right');
  let painted = null;
  const leftAsk = () => (painted?.caption ? `Tell me more about ${painted.caption}.` : 'What are you showing me?');
  const rightAsk = 'What does CEV mean?';
  function setPainted(scene) {
    painted = scene && scene.scene !== 'eyes' ? scene : null;
    body.classList.toggle('painted', Boolean(painted));
    const label = painted?.caption ? `Ask about ${painted.caption}` : 'Ask about this';
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
    if (!text || busy || closed) return;
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
    modelExpression = null;
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
    let ending = null;
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
        if (data.error === 'closed') ending = { until: data.closed_until, quiet: true };
        trouble = data.message || (res.status === 404 ? "I'm not awake on this host. The site needs its Cloudflare functions to talk." : 'Something went wrong on my side. Try again?');
      } else {
        await readEvents(res.body, (event, data) => {
          if (event === 'meta') {
            conversationId = data.conversation_id || conversationId;
            setModel(reply, data.model);
          } else if (event === 'scene') {
            paint(data);
          } else if (event === 'eyes') {
            modelExpression = data.expression;
          } else if (event === 'end') {
            ending = { until: data.closed_until };
          } else if (event === 'text') {
            said += data.delta;
            thinkTarget = 0;
            speakTarget = 1;
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
      speakTarget = 0;
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
      if (ending?.quiet) settleClosed(ending.until);
      else if (ending) strike(ending.until, said.trim());
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

  // ---------- go ----------
  engine.start();
  // A visitor Karyon has closed the conversation with gets the static page at once.
  const status = fetch('/api/status')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  status.then((s) => {
    if (!s) return;
    if (s.closed_until) return;
    if (!s.configured) note.textContent = 'Karyon is not connected yet.';
    else if (!s.open) note.textContent = 'Karyon has talked as much as it can today. Its budget resets at midnight UTC.';
  });
  const boot = async () => {
    const s = await Promise.race([status, new Promise((r) => setTimeout(r, 700))]);
    if (s?.closed_until) {
      engine.setMode('chat', true);
      engine.setScene('eyes', {}, { instant: true });
      P.eyeFade = 1;
      P.eyeOpen = 0;
      settleClosed(s.closed_until);
      return;
    }
    status.then((late) => late?.closed_until && !closed && settleClosed(late.closed_until));
    startIntro();
    placeUI();
    // Test hooks for screenshots: ?scene=planet&mode=chat&t=4&pause=1
    if (qs.has('scene')) {
      const name = qs.get('scene');
      if (qs.get('mode') === 'chat') {
        started = true;
        body.classList.add('chatting');
        engine.setMode('chat', true);
      }
      engine.setScene(name, { phase: qs.get('phase') || undefined }, { instant: true });
      if (qs.get('mode') === 'chat') {
        engine.layout = engine.layoutFor('chat');
        placeUI();
      }
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

  window.__karyon = { engine, ask, paint, startIntro, strike, showStatic, setExpression: (x) => (modelExpression = x) };
})();
