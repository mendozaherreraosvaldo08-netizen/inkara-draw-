/**
 * Pantalla de inicio: corre antes que todo lo demás (si algo falla al
 * arrancar, igual se quita sola).
 */
// Pantalla de inicio: el camaleón se pinta de color y el abanico de colores se abre.
const INTRO_SEEN = 'inkara.intro.visto';

function hideSplash(splash: HTMLElement): void {
  if (!splash.isConnected || splash.classList.contains('is-hiding')) return;
  splash.classList.add('is-hiding');
  window.setTimeout(() => splash.remove(), 500);
}

/**
 * Animación "La luz" (el camaleón persigue la luciérnaga y se llena de color).
 * La primera vez se ve completa y con sonido; después, solo el final (sin sonido).
 * Se salta con clic, Esc, Enter o Espacio. Si el video no se puede reproducir, se usa
 * la pantalla de carga de siempre.
 */
function playIntro(splash: HTMLElement, full: boolean, onFail: () => void): void {
  const video = document.createElement('video');
  video.className = 'splash-video';
  video.src = full ? './brand/intro.mp4' : './brand/intro-corta.mp4';
  video.playsInline = true;
  video.muted = !full;
  video.preload = 'auto';
  const skip = document.createElement('button');
  skip.type = 'button';
  skip.className = 'splash-skip';
  skip.textContent = 'Saltar ›';
  splash.append(video, skip);
  splash.classList.add('has-video');
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    document.removeEventListener('keydown', onKey, true);
    video.pause();
    hideSplash(splash);
  };
  const onKey = (e: KeyboardEvent) => {
    if (['Escape', 'Enter', ' '].includes(e.key)) { e.preventDefault(); finish(); }
  };
  document.addEventListener('keydown', onKey, true);
  splash.addEventListener('click', finish);
  video.addEventListener('ended', finish);
  video.addEventListener('error', () => { if (!done) { video.remove(); skip.remove(); splash.classList.remove('has-video'); onFail(); } });
  // Por si el video no arranca, no se queda la pantalla puesta.
  let started = false;
  video.addEventListener('playing', () => (started = true));
  window.setTimeout(() => { if (!started && !done) { video.remove(); skip.remove(); splash.classList.remove('has-video'); onFail(); } }, 2500);
  window.setTimeout(finish, (full ? 22 : 6) * 1000);
  void video.play().catch(() => {
    // Sin permiso para sonar: se ve sin sonido.
    video.muted = true;
    void video.play().catch(() => undefined);
  });
}

/** Ayuda › Ver la animación de inicio. */
export function replayIntro(): void {
  const splash = document.createElement('div');
  splash.className = 'splash';
  document.body.append(splash);
  playIntro(splash, true, () => hideSplash(splash));
}

export function runSplash(): void {
const splash = document.getElementById('splash');
if (!splash) return;
let seen = false;
try { seen = localStorage.getItem(INTRO_SEEN) === '1'; localStorage.setItem(INTRO_SEEN, '1'); } catch { /* sin memoria: se ve el final */ seen = true; }
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
if (!reduce) { playIntro(splash, !seen, () => fanSplash(splash)); return; }
fanSplash(splash);
}

// Pantalla de carga de siempre: el camaleón se pinta de color y el abanico se abre.
function fanSplash(splash: HTMLElement): void {
{
  const FAN = ['#FFD23F', '#FFB03A', '#FF7A3D', '#F5566A', '#EE4266', '#B14AED', '#3D7CF2', '#13A3A6', '#0EAD69'];
  const fan = splash.querySelector('.splash-fan');
  const color = splash.querySelector<HTMLElement>('.splash-color');
  const pct = splash.querySelector('.splash-pct');
  const msg = splash.querySelector('.splash-msg');
  const steps = ['Abriendo colores…', 'Cargando fuentes…', 'Preparando plantillas…', '¡Listo para diseñar!'];
  const draw = (p: number) => {
    const open = Math.floor(p * FAN.length + 0.0001);
    const angle = (i: number) => -70 + Math.min(i, open) * (140 / (FAN.length - 1));
    if (fan) fan.innerHTML = FAN.map((c, i) => `<g transform="translate(140 96) rotate(${angle(i)})"><rect x="-11" y="-88" width="22" height="80" rx="3" fill="${i < open ? c : '#2a6b57'}" stroke="#0e4f3c" stroke-width="1.5"/><rect x="-11" y="-30" width="22" height="22" fill="#f5f1e6"/><rect x="-6" y="-24" width="12" height="2" fill="#0e4f3c55"/><rect x="-6" y="-19" width="8" height="2" fill="#0e4f3c55"/></g>`).join('') + '<circle cx="140" cy="96" r="5" fill="#f5f1e6" stroke="#0e4f3c" stroke-width="2"/>';
    if (color) color.style.clipPath = `inset(0 ${100 - p * 100}% 0 0)`;
    if (pct) pct.textContent = `${Math.round(p * 100)}%`;
    if (msg) msg.textContent = steps[p >= 1 ? steps.length - 1 : Math.min(steps.length - 2, Math.floor(p * (steps.length - 1)))]!;
  };
  const start = performance.now();
  const DURATION = matchMedia('(prefers-reduced-motion: reduce)').matches ? 300 : 1600;
  const tick = (now: number) => {
    const p = Math.min(1, (now - start) / DURATION);
    draw(1 - (1 - p) ** 2);
    if (p < 1) requestAnimationFrame(tick);
    else
      window.setTimeout(() => {
        splash.classList.add('is-hiding');
        window.setTimeout(() => splash.remove(), 500);
      }, 350);
  };
  draw(0);
  requestAnimationFrame(tick);
  // Pase lo que pase al arrancar, la pantalla de inicio no se queda puesta.
  window.setTimeout(() => hideSplash(splash), 5000);
}
}
