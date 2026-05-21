(async () => {
  const root = document.getElementById('root');
  const show404 = () => { root.innerHTML = '<div class="nf">404 Not Found</div>'; };

  const hash = location.hash.slice(1);
  if (!hash) { show404(); return; }

  const b64urlDecode = (s) => {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };

  let cryptoKey, content;
  try {
    const keyBytes = b64urlDecode(hash);
    if (keyBytes.length !== 32) return;

    cryptoKey = await crypto.subtle.importKey(
      'raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']
    );

    const res = await fetch('content.enc.json', { cache: 'no-store' });
    if (!res.ok) return;
    const { iv, data } = await res.json();
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64urlDecode(iv) },
      cryptoKey,
      b64urlDecode(data)
    );
    content = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    show404();
    return;
  }

  const { html, css, reveal, audio: hasAudio, images = [], fonts = [] } = content;
  const revealAt = new Date(reveal).getTime();

  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  document.title = ' ';

  async function decryptBin(path, mime) {
    try {
      const res = await fetch(path, { cache: 'no-store' });
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      const iv = buf.slice(0, 12);
      const data = buf.slice(12);
      const plainBuf = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv }, cryptoKey, data
      );
      return URL.createObjectURL(new Blob([plainBuf], { type: mime }));
    } catch {
      return null;
    }
  }

  const audioPromise = hasAudio ? decryptBin('audio.enc.bin', 'audio/mpeg') : Promise.resolve(null);

  for (const { name, mime } of images) {
    decryptBin(`${name}.enc.bin`, mime).then((url) => {
      if (url) document.documentElement.style.setProperty(`--${name}-img`, `url("${url}")`);
    });
  }

  const fontPromises = fonts.map(({ name, family, mime }) =>
    decryptBin(`${name}.enc.bin`, mime).then(async (url) => {
      if (!url) return;
      const face = new FontFace(family, `url(${url})`);
      await face.load();
      document.fonts.add(face);
    })
  );

  // ---- Audio : Web Audio API (plus fiable que HTMLAudioElement sur iOS) ----
  // audioCtx.resume() dans le gesture handler unlock l'audio pour toute la
  // page ; ensuite on peut lancer la lecture quand on veut. Si l'user tape
  // avant que le buffer soit décodé, on stocke l'intention et on lance dès
  // que le buffer est prêt — pas besoin d'un nouveau gesture.
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const audioCtx = AudioCtx ? new AudioCtx() : null;
  let audioBuffer = null;
  let audioSource = null;
  let audioStarted = false;

  if (audioCtx && hasAudio) {
    audioPromise.then(async (url) => {
      if (!url) return;
      try {
        const res = await fetch(url);
        const ab = await res.arrayBuffer();
        audioBuffer = await audioCtx.decodeAudioData(ab);
        if (audioStarted && !audioSource) playBuffer();
      } catch {}
    });
  }

  function playBuffer() {
    if (!audioBuffer || audioSource || !audioCtx) return;
    audioSource = audioCtx.createBufferSource();
    audioSource.buffer = audioBuffer;
    audioSource.loop = true;
    audioSource.connect(audioCtx.destination);
    audioSource.start();
  }

  function tryStartMusic() {
    if (audioStarted) return;
    audioStarted = true;
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    if (audioBuffer) playBuffer();
    // Si pas de buffer encore : audioPromise.then lancera playBuffer
    // dès que le décodage est fini (ctx déjà unlocked).
  }

  // ---- Tap rate → accélère les lapins ----
  // Plus l'user tape vite, plus --rabbit-duration descend (jusqu'à 800ms).
  // Quand 1500ms sans tap, retour à 2400ms.
  let tapTimes = [];
  document.addEventListener('pointerdown', () => {
    const now = Date.now();
    tapTimes.push(now);
    tapTimes = tapTimes.filter((t) => now - t < 1500);
    const count = tapTimes.length;
    const duration = Math.max(800, 2400 - (count - 1) * 400);
    document.documentElement.style.setProperty('--rabbit-duration', duration + 'ms');
  });
  setInterval(() => {
    const now = Date.now();
    tapTimes = tapTimes.filter((t) => now - t < 1500);
    if (tapTimes.length === 0) {
      document.documentElement.style.setProperty('--rabbit-duration', '2400ms');
    }
  }, 500);

  function wireModal(scope) {
    const infoBtn = scope.querySelector('.info-btn');
    const modal = scope.querySelector('.modal');
    if (!infoBtn || !modal) return;
    const modalClose = modal.querySelector('.modal-close');
    infoBtn.addEventListener('click', () => { modal.hidden = false; });
    modalClose?.addEventListener('click', () => { modal.hidden = true; });
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.hidden = true;
    });
  }

  async function doReveal(withFade) {
    await Promise.all(fontPromises);

    if (withFade) {
      root.style.transition = 'opacity 500ms ease';
      root.style.opacity = '0';
      await new Promise((r) => setTimeout(r, 500));
    }
    root.innerHTML = html;
    root.style.opacity = '1';

    // Arrivée tardive (post-reveal sans avoir tapé pendant le countdown) :
    // 1er tap n'importe où sur le document lance la musique.
    if (hasAudio && !audioStarted) {
      const fallback = () => {
        tryStartMusic();
        if (audioStarted) document.removeEventListener('pointerdown', fallback);
      };
      document.addEventListener('pointerdown', fallback);
    }
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function tick() {
    const diff = revealAt - Date.now();
    if (diff <= 0) { doReveal(true); return; }
    const s = Math.floor(diff / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const time = root.querySelector('.timer .time');
    if (time) {
      time.innerHTML =
        `<span>${pad(d)}</span><i>:</i><span>${pad(h)}</span>` +
        `<i>:</i><span>${pad(m)}</span><i>:</i><span>${pad(sec)}</span>`;
    }
    setTimeout(tick, 1000 - (Date.now() % 1000));
  }

  if (Date.now() >= revealAt) {
    doReveal(false);
  } else {
    root.innerHTML = `
      <div class="timer">
        <h1 class="title">Welcome to BunnyMania</h1>
        <div class="time"><span>--</span><i>:</i><span>--</span><i>:</i><span>--</span><i>:</i><span>--</span></div>
        <div class="rabbit rabbit-looking"></div>
        <p class="hint">Tap the screen to enable sound</p>
        <button class="info-btn" type="button">Informations</button>
        <div class="rabbit rabbit-seating"></div>
        <div class="rabbit rabbit-running"></div>
        <div class="modal" hidden>
          <div class="modal-inner">
            <button class="modal-close" type="button" aria-label="Close">×</button>
            <ul class="rules">
              <li>This is a free entrance, take care of each other !</li>
              <li>No violence, racism, discrimination</li>
              <li>Respect and take care of the decorations and equipment</li>
              <li>Ask for consent</li>
              <li>Consume safely</li>
              <li>Throw trash in designated bins, cigarette butt included, bring ash trays</li>
              <li>In case of emergency, look for team members with a red light</li>
            </ul>
          </div>
        </div>
      </div>
    `;
    const timerEl = root.querySelector('.timer');
    const hint = timerEl.querySelector('.hint');
    const timerTitle = timerEl.querySelector('.title');

    // Le titre reste invisible (CSS opacity 0) jusqu'à ce que Danken soit
    // chargée → évite le flash en system-ui le temps du déchiffrement font.
    Promise.all(fontPromises).then(() => timerTitle?.classList.add('ready'));

    wireModal(timerEl);

    const handleFirstTap = (e) => {
      if (e.target.closest('.info-btn') || e.target.closest('.modal')) return;
      tryStartMusic();
      hint.style.opacity = '0';
      setTimeout(() => {
        hint.textContent = "you're on";
        hint.classList.add('on');
        hint.style.opacity = '';
      }, 200);
      timerEl.removeEventListener('pointerdown', handleFirstTap);
    };
    timerEl.addEventListener('pointerdown', handleFirstTap);
    tick();
  }
})();
