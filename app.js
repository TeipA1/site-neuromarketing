/* Фокус — лаборатория взгляда.
   Поток: подготовка → камера → калибровка (9 точек) → проверка точности →
   лента из 8 реклам → карта взгляда и метрики → отправка в Google Таблицу. */

// ===================== Настройки =====================
const CONFIG = {
  // Ссылка на веб-приложение Google Apps Script (см. apps-script/Code.gs).
  SHEETS_URL: "https://script.google.com/macros/s/AKfycbwTOSxONqSnTneJbq74EmDXrq3TH7RQMb07IvWlhIAT-LMErhFSWm3llAsoF6ha_XP4/exec",
  AUTHOR: "Ахметов Теип",
  MAX_SLIDE_MS: 15000,      // максимум времени на один пост
  CALIB_CLICKS: 5,          // кликов на каждую точку калибровки
  VALIDATE_MS: 3000,        // проверка точности: сколько смотреть на центр
};

const IMG_W = 1080, IMG_H = 1350;

// Зоны макета (горизонтальные полосы — устойчивее к погрешности веб-камеры)
const ZONES = [
  { id: "brand",   name: "Бренд",    y0: 0,   y1: 185 },
  { id: "picture", name: "Картинка", y0: 185, y1: 875 },
  { id: "text",    name: "Текст",    y0: 875, y1: IMG_H },
];

const BRANDS = {
  c1: "Тёплый Час", c2: "Лёгкий Шаг", c3: "Сытый Кот",
  f1: "Зелёный Дом", f2: "Лунный Сон", f3: "Звонкий", f4: "Далёкий Берег", f5: "Книжный Угол",
};
const TARGETS = ["c1", "c2", "c3"];
const ORDER = ["f1", "c1", "f2", "f3", "c2", "f4", "c3", "f5"];
const GROUPS = {
  1: { c1: "A", c2: "B", c3: "A" },
  2: { c1: "B", c2: "A", c3: "B" },
};

// ===================== Состояние =====================
const state = {
  mode: null,            // "camera" | "demo"
  group: Math.random() < 0.5 ? 1 : 2,
  accuracy: null,
  slides: [],
  index: 0,
  slideStart: 0,
  feedActive: false,
  collector: null,       // временный сборщик предсказаний (проверка точности)
  results: null,
};

const $ = (s) => document.querySelector(s);
const now = () => performance.now();

// ===================== Общие эффекты страницы =====================
document.documentElement.classList.add("js");
$("#author-name").textContent = CONFIG.AUTHOR;

window.addEventListener("scroll", () => {
  $("#nav").classList.toggle("scrolled", window.scrollY > 8);
}, { passive: true });

function countUp(el) {
  const target = Number(el.dataset.count);
  const t0 = now();
  const tick = () => {
    const p = Math.min(1, (now() - t0) / 1100);
    el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(tick);
  };
  tick();
}

if ("IntersectionObserver" in window) {
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      e.target.classList.add("shown");
      e.target.querySelectorAll("[data-count]").forEach(countUp);
      io.unobserve(e.target);
    });
  }, { threshold: 0.15 });
  document.querySelectorAll(".reveal").forEach((el) => io.observe(el));
} else {
  document.querySelectorAll(".reveal").forEach((el) => el.classList.add("shown"));
}

// ===================== Анимация на обложке =====================
(function heroGaze() {
  const canvas = $("#hero-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  // Точки интереса на макете «Далёкий Берег» (доли ширины/высоты)
  const spots = [[0.44, 0.27], [0.62, 0.22], [0.3, 0.73], [0.55, 0.71], [0.2, 0.07], [0.7, 0.4], [0.45, 0.42]];
  let pos = { x: 0.5, y: 0.4 }, target = spots[0], dwell = 0, dwellMax = 900;
  let trail = [], fixes = [], last = now(), fixTotal = 0;
  const meta = $("#hero-meta");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  function resize() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = r.width * dpr; canvas.height = r.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener("resize", resize);

  function frame() {
    const t = now(), dt = Math.min(50, t - last); last = t;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const dx = target[0] - pos.x, dy = target[1] - pos.y, dist = Math.hypot(dx, dy);
    if (dist > 0.01) {
      pos.x += dx * 0.18; pos.y += dy * 0.18;          // быстрый скачок взгляда
      trail.push({ x: pos.x, y: pos.y, a: 1 });
    } else {
      dwell += dt; fixTotal += dt;
      const f = fixes[fixes.length - 1];
      if (!f || f.done) fixes.push({ x: target[0], y: target[1], r: 4, done: false });
      else f.r = 4 + Math.sqrt(dwell) * 0.7;
      if (dwell > dwellMax) {
        fixes[fixes.length - 1].done = true;
        dwell = 0; dwellMax = 500 + Math.random() * 900;
        let next; do { next = spots[Math.floor(Math.random() * spots.length)]; } while (next === target);
        target = next;
      }
    }
    if (fixes.length > 7) fixes.shift();
    trail = trail.filter((p) => (p.a -= 0.012) > 0).slice(-60);

    ctx.clearRect(0, 0, w, h);
    trail.forEach((p) => {
      ctx.fillStyle = `rgba(10,140,255,${p.a * 0.7})`;
      ctx.beginPath(); ctx.arc(p.x * w, p.y * h, 3.2, 0, Math.PI * 2); ctx.fill();
    });
    fixes.forEach((f, i) => {
      const a = 0.25 + 0.35 * ((i + 1) / fixes.length);
      ctx.fillStyle = `rgba(255,59,78,${a})`;
      ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(f.x * w, f.y * h, f.r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    });
    ctx.fillStyle = "#0A8CFF";
    ctx.beginPath(); ctx.arc(pos.x * w, pos.y * h, 6, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(10,140,255,.35)"; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(pos.x * w, pos.y * h, 13, 0, Math.PI * 2); ctx.stroke();
    if (meta) meta.textContent = `fix ${(fixTotal / 1000).toFixed(2)} с`;
    if (!reduce) requestAnimationFrame(frame);
  }
  frame();
})();

// ===================== Переключение шагов =====================
function showPane(name) {
  document.querySelectorAll(".pane").forEach((p) => { p.hidden = p.dataset.pane !== name; });
}

function enterFullscreen() {
  const el = document.documentElement;
  if (el.requestFullscreen && !document.fullscreenElement) el.requestFullscreen().catch(() => {});
}
function exitFullscreen() {
  if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
}

// ===================== Источник взгляда =====================
function onGaze(x, y) {
  if (state.collector) state.collector.push({ x, y });
  if (!state.feedActive) return;
  const rect = $(".feed-card").getBoundingClientRect();
  const slide = state.slides[state.index];
  slide.samples.push({
    t: now(),
    x: ((x - rect.left) / rect.width) * IMG_W,
    y: ((y - rect.top) / rect.height) * IMG_H,
  });
}

// Демо-режим: курсор вместо взгляда, опрос 30 раз в секунду
let mouse = null, demoTimer = null;
function startDemoSampling() {
  window.addEventListener("mousemove", (e) => { mouse = { x: e.clientX, y: e.clientY }; });
  demoTimer = setInterval(() => { if (mouse) onGaze(mouse.x, mouse.y); }, 33);
}

// ===================== Камера =====================
$("#btn-camera").addEventListener("click", startCamera);
$("#btn-demo").addEventListener("click", () => {
  state.mode = "demo";
  startDemoSampling();
  startFeed();
});
$("#btn-cancel").addEventListener("click", () => location.reload());
$("#btn-to-calib").addEventListener("click", startCalibration);

function cameraError(msg) {
  const el = $("#camera-error");
  el.textContent = msg;
  el.hidden = false;
  showPane("intro");
}

// Модели лица скачиваются заранее, пока человек читает страницу
const MODEL_FILES = ["blazeface", "facemesh", "iris"].flatMap((m) => [`models/${m}/model.json`, `models/${m}/group1-shard1of1.bin`]);
const modelsReady = Promise.all(MODEL_FILES.map((u) => fetch(u, { cache: "force-cache" }).then((r) => r.blob()))).catch(() => null);

// Статус загрузки: таймер, подсказки, запасной выход
let camTimer = null;
function camStatus(text) { $("#cam-status").textContent = text; }
function startCamTimer() {
  const t0 = now();
  const hint = $("#cam-hint");
  camTimer = setInterval(() => {
    const s = Math.round((now() - t0) / 1000);
    $("#cam-time").textContent = s + " с";
    if (s === 30) { hint.hidden = false; hint.textContent = "Загрузка идёт дольше обычного. Можно подождать ещё немного или нажать «Попробовать ещё раз»."; $("#btn-retry").hidden = false; }
    if (s >= 60) {
      stopCamTimer();
      try { webgazer.end(); } catch (_) {}
      cameraError("Не удалось запустить камеру за минуту. Закройте другие программы, которые используют камеру (Zoom, Teams), обновите страницу и попробуйте ещё раз. Или пройдите демо без камеры.");
    }
  }, 1000);
}
function stopCamTimer() { clearInterval(camTimer); camTimer = null; }
$("#btn-retry").addEventListener("click", () => { location.hash = "lab"; location.reload(); });

async function startCamera() {
  $("#camera-error").hidden = true;
  if (!window.webgazer) return cameraError("Модуль отслеживания взгляда не загрузился. Обновите страницу.");
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return cameraError("Этот браузер не даёт доступ к камере. Откройте сайт в Chrome, Edge или Safari по ссылке https://…");
  }
  state.mode = "camera";
  showPane("camera");
  camStatus("Нажмите «Разрешить» в окне браузера, которое спрашивает про камеру");
  $("#cam-hint").hidden = false;
  $("#cam-hint").textContent = "Окно появляется под адресной строкой, слева вверху. Если его не видно — нажмите на значок камеры в адресной строке.";
  try {
    // Сначала проверяем саму камеру: так ошибка доступа видна сразу, а не через минуту
    const probe = await navigator.mediaDevices.getUserMedia({ video: true });
    probe.getTracks().forEach((t) => t.stop());
    $("#cam-hint").hidden = true;
    startCamTimer();   // минута считается только после разрешения камеры
    camStatus("Камера доступна. Загружаем модель лица…");
    await modelsReady;
    camStatus("Запускаем распознавание лица…");
    webgazer.saveDataAcrossSessions(false);
    webgazer.setRegression("ridge")
      .showVideoPreview(true)
      .showPredictionPoints(false)
      .showFaceOverlay(true)
      .showFaceFeedbackBox(true)
      .applyKalmanFilter(true)
      .setGazeListener((data) => { if (data) onGaze(data.x, data.y); });
    await webgazer.begin(() => { throw new Error("camera"); });
    webgazer.clearData();
    stopCamTimer();
    $("#cam-hint").hidden = true;
    $("#btn-retry").hidden = true;
    $("#cam-spinner").classList.add("done");
    camStatus("Камера работает. Поместите лицо в рамку.");
    $("#btn-to-calib").disabled = false;
  } catch (e) {
    stopCamTimer();
    try { webgazer.end(); } catch (_) {}
    const denied = e && (e.name === "NotAllowedError" || e.name === "SecurityError");
    const busy = e && (e.name === "NotReadableError" || e.name === "AbortError");
    const none = e && e.name === "NotFoundError";
    cameraError(
      denied ? "Доступ к камере запрещён. Нажмите на значок камеры в адресной строке, выберите «Разрешить» и нажмите «Включить камеру» ещё раз."
      : busy ? "Камера занята другой программой (Zoom, Teams, Камера Windows). Закройте её и нажмите «Включить камеру» ещё раз."
      : none ? "Камера не найдена. Подключите веб-камеру или пройдите демо без камеры."
      : "Не получилось включить камеру. Обновите страницу и попробуйте ещё раз."
    );
  }
}

// ===================== Калибровка =====================
const CALIB_POS = [
  [8, 10], [50, 10], [92, 10],
  [8, 50], [50, 50], [92, 50],
  [8, 90], [50, 90], [92, 90],
];

function startCalibration() {
  enterFullscreen();
  document.body.classList.add("calibrating");   // окно камеры не закрывает точку в углу
  webgazer.clearData();
  webgazer.addMouseEventListeners();     // клики по точкам учат модель
  const overlay = $("#calib"), box = $("#calib-points");
  overlay.hidden = false;
  box.innerHTML = "";
  $("#calib-text").textContent = `Смотрите на точку и кликните по ней ${CONFIG.CALIB_CLICKS} раз, пока она не станет синей. Голову не двигайте.`;
  let done = 0;
  CALIB_POS.forEach(([x, y]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "calib-point";
    b.style.left = x + "%"; b.style.top = y + "%";
    b.setAttribute("aria-label", "Точка калибровки");
    let clicks = 0;
    b.addEventListener("click", () => {
      if (b.classList.contains("done")) return;
      clicks++;
      b.style.setProperty("--p", (clicks / CONFIG.CALIB_CLICKS) * 100);
      if (clicks >= CONFIG.CALIB_CLICKS) {
        b.classList.add("done");
        if (++done === CALIB_POS.length) setTimeout(validate, 400);
      }
    });
    box.appendChild(b);
  });
}

function validate() {
  webgazer.removeMouseEventListeners();  // дальше модель не учится на мыши
  const box = $("#calib-points");
  box.innerHTML = '<div class="calib-point target" style="left:50%;top:50%"></div>';
  $("#calib-help").style.top = "64%";
  $("#calib-text").textContent = "Проверка точности: смотрите на синюю точку 3 секунды. Мышь не трогайте.";
  state.collector = [];
  setTimeout(() => {
    const pts = state.collector; state.collector = null;
    const cx = innerWidth / 2, cy = innerHeight / 2, half = innerHeight / 2;
    const precision = pts.length
      ? pts.reduce((s, p) => s + Math.max(0, 100 - (Math.hypot(p.x - cx, p.y - cy) / half) * 100), 0) / pts.length
      : 0;
    state.accuracy = Math.round(precision);
    showValidationResult();
  }, CONFIG.VALIDATE_MS);
}

function showValidationResult() {
  const acc = state.accuracy;
  const good = acc >= 50;
  $("#calib-points").innerHTML = "";
  const help = $("#calib-help");
  help.style.top = "50%";
  help.innerHTML = `
    <b>Точность: ${acc}%</b>
    <span>${good ? "Отлично, можно начинать. Дальше откроется лента из 8 постов." : "Точность низкая. Лучше повторить настройку: сядьте ровнее и проверьте свет."}</span>
    <span class="calib-actions">
      <button class="btn" type="button" id="calib-go">${good ? "Начать просмотр" : "Всё равно начать"}</button>
      <button class="btn btn-ghost" type="button" id="calib-redo">Повторить настройку</button>
    </span>`;
  help.style.pointerEvents = "auto";
  $("#calib-go").addEventListener("click", () => { resetCalibHelp(); $("#calib").hidden = true; startFeed(); });
  $("#calib-redo").addEventListener("click", () => { resetCalibHelp(); startCalibration(); });
}

function resetCalibHelp() {
  const help = $("#calib-help");
  help.style.pointerEvents = "";
  help.style.top = "50%";
  help.innerHTML = '<b>Настройка</b><span id="calib-text"></span>';
}

// ===================== Лента =====================
function buildSlides() {
  const versions = GROUPS[state.group];
  state.slides = ORDER.map((id) => {
    const version = versions[id] || null;
    return { id, version, src: `ads/${version ? id + "-" + version : id}.png`, viewMs: 0, samples: [] };
  });
  // Заранее загружаем картинки, чтобы переход был мгновенным
  state.slides.forEach((s) => { const im = new Image(); im.src = s.src; });
}

function startFeed() {
  document.body.classList.remove("calibrating");
  buildSlides();
  enterFullscreen();
  if (state.mode === "camera") {
    webgazer.showVideoPreview(false).showFaceOverlay(false).showFaceFeedbackBox(false);
  }
  const prog = $("#feed-progress");
  prog.innerHTML = state.slides.map(() => "<i></i>").join("");
  $("#feed").hidden = false;
  state.feedActive = true;
  showSlide(0, 1);
  requestAnimationFrame(timerLoop);
}

function showSlide(i, dir) {
  state.index = i;
  const img = $("#feed-img");
  img.classList.remove("from-left");
  img.style.animation = "none"; void img.offsetWidth; img.style.animation = "";
  if (dir < 0) img.classList.add("from-left");
  img.src = state.slides[i].src;
  $("#feed-prev").disabled = i === 0;
  document.querySelectorAll("#feed-progress i").forEach((el, k) => el.classList.toggle("on", k <= i));
  state.slideStart = now();
}

function leaveSlide() {
  state.slides[state.index].viewMs += now() - state.slideStart;
}

function go(dir) {
  if (!state.feedActive) return;
  leaveSlide();
  const next = state.index + dir;
  if (next < 0) { state.slideStart = now(); return; }
  if (next >= state.slides.length) return finishFeed();
  showSlide(next, dir);
}

function timerLoop() {
  if (!state.feedActive) return;
  const s = state.slides[state.index];
  const spent = s.viewMs + (now() - state.slideStart);
  $("#feed-timer-bar").style.width = Math.min(100, (spent / CONFIG.MAX_SLIDE_MS) * 100) + "%";
  if (spent >= CONFIG.MAX_SLIDE_MS) go(1);
  requestAnimationFrame(timerLoop);
}

$("#feed-next").addEventListener("click", () => go(1));
$("#feed-prev").addEventListener("click", () => go(-1));
document.addEventListener("keydown", (e) => {
  if (!state.feedActive) return;
  if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
  if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
});

function finishFeed() {
  state.feedActive = false;
  $("#feed").hidden = true;
  exitFullscreen();
  if (demoTimer) clearInterval(demoTimer);
  if (state.mode === "camera") { try { webgazer.end(); } catch (_) {} }
  state.results = analyzeAll();
  renderResults();
  showPane("results");
  $("#lab").scrollIntoView({ behavior: "smooth" });
}

// ===================== Анализ =====================
function zoneOf(y) {
  const z = ZONES.find((z) => y >= z.y0 && y < z.y1);
  return z ? z.id : null;
}
const inside = (p) => p.x >= 0 && p.x <= IMG_W && p.y >= 0 && p.y <= IMG_H;

function dispersion(s, i, j) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let k = i; k <= j; k++) {
    x0 = Math.min(x0, s[k].x); x1 = Math.max(x1, s[k].x);
    y0 = Math.min(y0, s[k].y); y1 = Math.max(y1, s[k].y);
  }
  return (x1 - x0) + (y1 - y0);
}

// Алгоритм I-DT: фиксация — скопление точек не шире D пикселей дольше MIN мс
function detectFixations(s, D = 110, MIN = 150) {
  const fixations = [], glances = [];
  let i = 0;
  while (i < s.length) {
    let j = i;
    while (j < s.length && s[j].t - s[i].t < MIN) j++;
    if (j >= s.length) { for (; i < s.length; i++) glances.push(s[i]); break; }
    if (dispersion(s, i, j) <= D) {
      while (j + 1 < s.length && dispersion(s, i, j + 1) <= D) j++;
      let sx = 0, sy = 0;
      for (let k = i; k <= j; k++) { sx += s[k].x; sy += s[k].y; }
      const n = j - i + 1;
      fixations.push({ x: sx / n, y: sy / n, dur: s[j].t - s[i].t });
      i = j + 1;
    } else { glances.push(s[i]); i++; }
  }
  return { fixations, glances };
}

function analyzeSlide(slide) {
  const s = slide.samples;
  const dwell = { brand: 0, picture: 0, text: 0 };
  let onAd = 0;
  for (let k = 0; k < s.length; k++) {
    const dt = Math.min(100, k + 1 < s.length ? s[k + 1].t - s[k].t : 33);
    if (!inside(s[k])) continue;
    onAd += dt;
    dwell[zoneOf(s[k].y)] += dt;
  }
  const { fixations, glances } = detectFixations(s);
  const firstFix = fixations.find(inside) || s.find(inside);
  return {
    id: slide.id, version: slide.version, brand: BRANDS[slide.id], src: slide.src,
    viewS: slide.viewMs / 1000, onAdS: onAd / 1000,
    brandS: dwell.brand / 1000, pictureS: dwell.picture / 1000, textS: dwell.text / 1000,
    firstZone: firstFix ? ZONES.find((z) => z.id === zoneOf(firstFix.y)).name : "—",
    fixations, glances,
  };
}

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
const r2 = (x) => Math.round(x * 100) / 100;
const fmt = (x) => x.toFixed(1).replace(".", ",");

function analyzeAll() {
  const all = state.slides.map(analyzeSlide);
  const targets = all.filter((a) => a.version);
  const byV = (v) => targets.filter((a) => a.version === v);
  const avg = {};
  ["A", "B"].forEach((v) => {
    const t = byV(v);
    avg[v] = {
      view: mean(t.map((a) => a.viewS)), brand: mean(t.map((a) => a.brandS)),
      picture: mean(t.map((a) => a.pictureS)), text: mean(t.map((a) => a.textS)),
    };
  });
  const A = avg.A, B = avg.B;
  let verdict;
  if (B.text > A.text * 1.1) verdict = "Ваш взгляд совпал с выводом статьи: чем больше текста, тем дольше на нём задерживается внимание.";
  else if (B.text < A.text * 0.9) verdict = "У вас вышло наоборот: на маленький текст вы смотрели дольше, чем на большой.";
  else verdict = "У вас разницы почти нет: на большой и маленький текст вы смотрели примерно одинаково.";
  const conclusion =
    `Большой текст (версия Б): на текст ${fmt(B.text)} с, на бренд ${fmt(B.brand)} с, на всю рекламу ${fmt(B.view)} с. ` +
    `Маленький текст (версия А): на текст ${fmt(A.text)} с, на бренд ${fmt(A.brand)} с, на всю рекламу ${fmt(A.view)} с. ` +
    verdict;
  return { all, targets, avg, conclusion, fillersViewS: mean(all.filter((a) => !a.version).map((a) => a.viewS)) };
}

// ===================== Результаты =====================
function renderResults() {
  const res = state.results;
  const badge = $("#accuracy-badge");
  if (state.mode === "demo") { badge.textContent = "Демо-режим (мышь)"; }
  else {
    badge.textContent = `Точность ${state.accuracy}%`;
    badge.classList.add(state.accuracy >= 70 ? "good" : state.accuracy >= 45 ? "mid" : "bad");
  }

  const maxS = Math.max(0.1, ...res.targets.flatMap((a) => [a.brandS, a.pictureS, a.textS, a.viewS]));
  const bar = (label, v, cls = "") =>
    `<div class="bar"><span>${label}</span><span class="track"><i class="fill ${cls}" data-w="${(v / maxS) * 100}"></i></span><span class="val">${fmt(v)} с</span></div>`;

  $("#summary").innerHTML = res.targets.map((a) => `
    <div class="metric">
      <h4>${a.brand} · версия ${a.version === "A" ? "А (мало текста)" : "Б (много текста)"}</h4>
      <div class="bars">
        ${bar("Вся реклама", a.viewS, "b")}
        ${bar("Бренд", a.brandS)}
        ${bar("Картинка", a.pictureS)}
        ${bar("Текст", a.textS)}
      </div>
    </div>`).join("") +
    `<div class="conclusion"><h4>Короткий вывод</h4><p></p></div>`;
  $("#summary .conclusion p").textContent = res.conclusion;
  requestAnimationFrame(() => setTimeout(() => {
    document.querySelectorAll(".fill").forEach((f) => { f.style.width = f.dataset.w + "%"; });
  }, 80));

  const maps = $("#maps");
  maps.innerHTML = "";
  res.all.forEach((a) => {
    const fig = document.createElement("figure");
    fig.className = "map" + (a.version ? " target" : "");
    const c = document.createElement("canvas");
    c.width = 540; c.height = 675;
    const cap = document.createElement("figcaption");
    cap.innerHTML = `<b></b><span>${fmt(a.viewS)} с</span>`;
    cap.querySelector("b").textContent = a.brand + (a.version ? ` · ${a.version === "A" ? "А" : "Б"}` : "");
    fig.append(c, cap);
    maps.appendChild(fig);
    drawMap(c, a);
  });
}

function drawMap(canvas, a) {
  const ctx = canvas.getContext("2d");
  const k = canvas.width / IMG_W;
  const img = new Image();
  img.onload = () => {
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(255,255,255,.25)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (a.version) {
      ctx.setLineDash([8, 6]); ctx.strokeStyle = "rgba(10,140,255,.55)"; ctx.lineWidth = 2;
      [185, 875].forEach((y) => { ctx.beginPath(); ctx.moveTo(0, y * k); ctx.lineTo(canvas.width, y * k); ctx.stroke(); });
      ctx.setLineDash([]);
    }
    a.glances.forEach((p) => {
      if (!inside(p)) return;
      ctx.fillStyle = "rgba(10,140,255,.45)";
      ctx.beginPath(); ctx.arc(p.x * k, p.y * k, 3.5, 0, Math.PI * 2); ctx.fill();
    });
    a.fixations.forEach((f) => {
      if (!inside(f)) return;
      ctx.fillStyle = "rgba(255,59,78,.5)"; ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(f.x * k, f.y * k, 6 + Math.sqrt(f.dur) * 0.7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    });
  };
  img.src = a.src;
}

// ===================== Отправка в Google Таблицу =====================
$("#form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $("#form-status");
  status.className = "form-status";
  const name = $("#f-name"), age = $("#f-age"), email = $("#f-email"), consent = $("#f-consent");
  const bad = [];
  if (!name.value.trim()) bad.push(name);
  if (!(Number(age.value) >= 10 && Number(age.value) <= 99)) bad.push(age);
  if (!/^\S+@\S+\.\S+$/.test(email.value.trim())) bad.push(email);
  [name, age, email].forEach((el) => el.classList.toggle("invalid", bad.includes(el)));
  if (bad.length) { status.textContent = "Проверьте выделенные поля: имя, возраст от 10 до 99 и почту."; status.classList.add("err"); return; }
  if (!consent.checked) { status.textContent = "Отметьте согласие на участие в исследовании."; status.classList.add("err"); return; }

  const res = state.results;
  const ads = {};
  res.targets.forEach((a) => {
    ads[a.id] = {
      version: a.version, viewS: r2(a.viewS), onAdS: r2(a.onAdS),
      brandS: r2(a.brandS), pictureS: r2(a.pictureS), textS: r2(a.textS), firstZone: a.firstZone,
      fixations: a.fixations.filter(inside).map((f) => [Math.round(f.x), Math.round(f.y), Math.round(f.dur)]),
    };
  });
  const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r2(v)]));
  const payload = {
    sentAt: new Date().toISOString(),
    name: name.value.trim(), age: Number(age.value), email: email.value.trim(),
    group: state.group, mode: state.mode === "demo" ? "демо" : "камера",
    accuracy: state.mode === "demo" ? "" : state.accuracy,
    ads, fillersViewS: r2(res.fillersViewS),
    avgA: round(res.avg.A), avgB: round(res.avg.B),
    conclusion: res.conclusion,
    screen: `${innerWidth}x${innerHeight}`,
  };

  if (!CONFIG.SHEETS_URL) {
    status.textContent = "Таблица пока не подключена: исследователям нужно вставить ссылку в настройки сайта.";
    status.classList.add("err");
    console.log("Результаты (таблица не подключена):", payload);
    return;
  }
  const btn = $("#btn-send");
  btn.disabled = true; btn.textContent = "Отправляем…";
  try {
    await fetch(CONFIG.SHEETS_URL, {
      method: "POST", mode: "no-cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    });
    btn.textContent = "Отправлено";
    status.textContent = "Готово! Результаты сохранены. Спасибо за участие.";
    status.classList.add("ok");
  } catch (err) {
    btn.disabled = false; btn.textContent = "Отправить результаты";
    status.textContent = "Не получилось отправить: проверьте интернет и нажмите ещё раз.";
    status.classList.add("err");
  }
});

$("#btn-restart").addEventListener("click", () => { location.hash = "lab"; location.reload(); });
