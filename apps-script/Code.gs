/**
 * Фокус — приём результатов в Google Таблицу.
 *
 * Как подключить:
 * 1. Создайте Google Таблицу → Расширения → Apps Script.
 * 2. Удалите код по умолчанию и вставьте весь этот файл. Сохраните.
 * 3. Запустите функцию setup (кнопка «Выполнить»), разрешите доступ.
 * 4. Развернуть → Новое развертывание → тип «Веб-приложение»:
 *    «Выполнять как» — Я, «У кого есть доступ» — Все. Скопируйте URL веб-приложения.
 * 5. Вставьте этот URL в site/app.js → CONFIG.SHEETS_URL.
 */

const SHEET_ANSWERS = 'Ответы';
const SHEET_SUMMARY = 'Сводка';
const TARGETS = [['c1', 'Тёплый Час'], ['c2', 'Лёгкий Шаг'], ['c3', 'Сытый Кот']];

function headers_() {
  const h = ['Дата', 'Имя', 'Возраст', 'Почта', 'Группа', 'Режим', 'Точность калибровки, %'];
  TARGETS.forEach(([, name]) => {
    h.push(
      name + ': версия',
      name + ': вся реклама, с',
      name + ': бренд, с',
      name + ': картинка, с',
      name + ': текст, с',
      name + ': первая зона'
    );
  });
  h.push(
    'Фоновые: среднее время, с',
    'Версия А: текст, с', 'Версия Б: текст, с',
    'Версия А: бренд, с', 'Версия Б: бренд, с',
    'Версия А: вся реклама, с', 'Версия Б: вся реклама, с',
    'Вывод', 'Фиксации (x, y, мс)', 'Экран'
  );
  return h;
}

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_ANSWERS) || ss.insertSheet(SHEET_ANSWERS);
  const h = headers_();
  sh.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold').setBackground('#E8F3FF').setWrap(true);
  sh.setFrozenRows(1);
  if (!ss.getSheetByName(SHEET_SUMMARY)) ss.insertSheet(SHEET_SUMMARY);
  updateSummary_();
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const d = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(SHEET_ANSWERS) || (setup(), ss.getSheetByName(SHEET_ANSWERS));
    const row = [new Date(d.sentAt || Date.now()), d.name, d.age, d.email, d.group, d.mode, d.accuracy];
    const fix = {};
    TARGETS.forEach(([id]) => {
      const a = (d.ads || {})[id] || {};
      row.push(a.version, a.viewS, a.brandS, a.pictureS, a.textS, a.firstZone);
      fix[id] = a.fixations || [];
    });
    row.push(
      d.fillersViewS,
      (d.avgA || {}).text, (d.avgB || {}).text,
      (d.avgA || {}).brand, (d.avgB || {}).brand,
      (d.avgA || {}).view, (d.avgB || {}).view,
      d.conclusion, JSON.stringify(fix), d.screen
    );
    sh.appendRow(row);
    updateSummary_();
    return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) })).setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

// Средние по версиям А и Б для каждого бренда и итоговый вывод
function updateSummary_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const src = ss.getSheetByName(SHEET_ANSWERS);
  const out = ss.getSheetByName(SHEET_SUMMARY) || ss.insertSheet(SHEET_SUMMARY);
  const data = src.getDataRange().getValues();
  const rows = data.slice(1).filter((r) => r[5] !== 'демо');
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + Number(b || 0), 0) / xs.length : '');

  const table = [['Бренд', 'Версия', 'Участников', 'Вся реклама, с', 'Бренд, с', 'Картинка, с', 'Текст, с']];
  const total = { A: { text: [], brand: [], view: [] }, B: { text: [], brand: [], view: [] } };
  TARGETS.forEach(([, name], i) => {
    const base = 7 + i * 6;
    ['A', 'B'].forEach((v) => {
      const g = rows.filter((r) => r[base] === v);
      table.push([name, v === 'A' ? 'А (мало текста)' : 'Б (много текста)', g.length,
        avg(g.map((r) => r[base + 1])), avg(g.map((r) => r[base + 2])),
        avg(g.map((r) => r[base + 3])), avg(g.map((r) => r[base + 4]))]);
      g.forEach((r) => { total[v].view.push(r[base + 1]); total[v].brand.push(r[base + 2]); total[v].text.push(r[base + 4]); });
    });
  });

  const tA = avg(total.A.text), tB = avg(total.B.text);
  const bA = avg(total.A.brand), bB = avg(total.B.brand);
  const vA = avg(total.A.view), vB = avg(total.B.view);
  let verdict = 'Пока нет данных (демо-ответы не учитываются).';
  if (rows.length) {
    const f = (x) => (x === '' ? '—' : Number(x).toFixed(2));
    verdict = `Участников: ${rows.length}. Текст: А ${f(tA)} с → Б ${f(tB)} с. Бренд: А ${f(bA)} с → Б ${f(bB)} с. Вся реклама: А ${f(vA)} с → Б ${f(vB)} с. ` +
      (tB > tA ? 'Больше текста — больше внимания к тексту (как в статье).' : 'Эффект статьи пока не подтверждается.') +
      (bB < bA ? ' Крупный текст отнимает внимание у бренда.' : ' Внимание к бренду не снизилось.');
  }

  out.clear();
  out.getRange(1, 1, table.length, table[0].length).setValues(table);
  out.getRange(1, 1, 1, table[0].length).setFontWeight('bold').setBackground('#E8F3FF');
  out.getRange(2, 4, table.length - 1, 4).setNumberFormat('0.00');
  out.getRange(table.length + 2, 1).setValue('Итог').setFontWeight('bold');
  out.getRange(table.length + 3, 1).setValue(verdict).setWrap(true);
  out.getRange(table.length + 3, 1, 1, 7).merge();
  out.setColumnWidth(1, 160);
}
