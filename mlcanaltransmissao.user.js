// ==UserScript==
// @name         ML Canal de Transmissão - Agendador Automático de Stories
// @namespace    https://github.com/xTiozao
// @version      1.8
// @description  Agenda stories automaticamente em um RANGE de datas configurável e horários definidos no Canal de Transmissão do Mercado Livre
// @match        https://www.mercadolivre.com.br/marketing/canal-de-transmissao*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @updateURL    https://raw.githubusercontent.com/xTiozao/autotransmitchannel/main/mlcanaltransmissao.user.js
// @downloadURL  https://raw.githubusercontent.com/xTiozao/autotransmitchannel/main/mlcanaltransmissao.user.js
// ==/UserScript==

(function () {
  'use strict';

  /* =========================================================================
   *  CONFIGURAÇÃO
   * ========================================================================= */
  const CFG = {
    HOURS: ['07:00','08:00','09:00','10:00','11:00','12:00','13:00','14:00',
            '15:00','16:00','17:00','18:00','19:00','20:00','21:00','22:00','23:00'],
    AI_WAIT: 5500,          // espera da IA gerar imagem (ms)
    HUMAN_MIN: 500,
    HUMAN_MAX: 1400,
    WAIT_TIMEOUT: 25000,
    STORY_BTN_GRACE: 3500,  // tempo p/ o botão "Criar story" habilitar
    HUB_URL: 'https://www.mercadolivre.com.br/marketing/canal-de-transmissao',
    // RANGE PADRÃO (usado se o usuário não definir no painel).
    // Formato: 'YYYY-MM-DD'. Se quiser uma única data, deixe START === END.
    DEFAULT_START: null,    // ex: '2026-07-01'  (null = hoje)
    DEFAULT_END:   null,    // ex: '2026-07-03'  (null = igual ao START)
  };

  const LS = {
    state:    'mlAgendadorEstado',        // 'running' | 'idle'
    matrix:   'mlAgendadorMatriz',        // matriz de slots {chave: agendado?}
    usedIds:  'mlAgendadorIdsUsados',     // ids MLB já usados (anti-repetição)
    blocked:  'mlAgendadorIdsBloqueados', // ids MLB inválidos -> nunca usar
    target:   'mlAgendadorAlvoAtual',     // slot sendo processado agora
    log:      'mlAgendadorLog',
    range:    'mlAgendadorRange',          // {start:'YYYY-MM-DD', end:'YYYY-MM-DD'}
    placed:   'mlAgendadorIdsAgendados',   // ids que JÁ conseguiram agendar (p/ reuso garantido)
    legenda:  'mlAgendadorComLegenda',     // 'on' | 'off'  (padrão: 'on')
  };

  /* =========================================================================
   *  UTILITÁRIOS
   * ========================================================================= */
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const rnd   = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
  const human = () => sleep(rnd(CFG.HUMAN_MIN, CFG.HUMAN_MAX));

  const getJSON = (k, def) => { try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; } };
  const setJSON = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  const getStr  = (k, def='') => localStorage.getItem(k) ?? def;
  const setStr  = (k, v) => localStorage.setItem(k, v);

  const pad = (n) => String(n).padStart(2, '0');
  const fmtISO = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  // 'YYYY-MM-DD' -> Date local (meia-noite)
  const parseISO = (s) => { const [y,m,dd] = s.split('-').map(Number); return new Date(y, m-1, dd); };
  // 'DD/MM/YYYY' -> 'YYYY-MM-DD'
  const brToISO = (s) => { const m = s.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
  const isoToBR = (s) => { const [y,m,d] = s.split('-'); return `${d}/${m}/${y}`; };

  function log(msg) {
    const arr = getJSON(LS.log, []);
    arr.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
    if (arr.length > 200) arr.shift();
    setJSON(LS.log, arr);
    console.log('%c[Agendador ML]', 'color:#3483fa;font-weight:bold', msg);
    renderLog();
  }

  function waitFor(selectorOrFn, timeout = CFG.WAIT_TIMEOUT) {
    return new Promise((resolve, reject) => {
      const test = () => (typeof selectorOrFn === 'function') ? selectorOrFn() : document.querySelector(selectorOrFn);
      const found = test();
      if (found) return resolve(found);
      const t0 = Date.now();
      const iv = setInterval(() => {
        const el = test();
        if (el) { clearInterval(iv); resolve(el); }
        else if (Date.now() - t0 > timeout) { clearInterval(iv); reject(new Error('Timeout: ' + selectorOrFn)); }
      }, 300);
    });
  }

  async function humanClick(el) {
    if (!el) throw new Error('Elemento inexistente para clicar');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(rnd(250, 600));
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2 + rnd(-4, 4);
    const y = r.top + r.height / 2 + rnd(-3, 3);
    const opt = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
    el.dispatchEvent(new MouseEvent('mouseover', opt));
    el.dispatchEvent(new MouseEvent('mousemove', opt));
    await sleep(rnd(60, 180));
    el.dispatchEvent(new MouseEvent('mousedown', opt));
    await sleep(rnd(40, 120));
    el.dispatchEvent(new MouseEvent('mouseup', opt));
    el.dispatchEvent(new MouseEvent('click', opt));
    await human();
  }

  function isDisabled(el) {
    if (!el) return true;
    if (el.disabled) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    if (/andes-button--disabled/.test(el.className)) return true;
    const st = getComputedStyle(el);
    if (st.pointerEvents === 'none') return true;
    return false;
  }

  /* =========================================================================
   *  RANGE DE DATAS (configurável)
   * ========================================================================= */
  function getRange() {
    let r = getJSON(LS.range, null);
    if (!r || !r.start || !r.end) {
      const start = CFG.DEFAULT_START || fmtISO(new Date());
      const end   = CFG.DEFAULT_END   || start;
      r = { start, end };
      setJSON(LS.range, r);
    }
    return r;
  }

  function setRange(startISO, endISO) {
    // garante start <= end
    let s = startISO, e = endISO || startISO;
    if (parseISO(s) > parseISO(e)) { const tmp = s; s = e; e = tmp; }
    setJSON(LS.range, { start: s, end: e });
    return { start: s, end: e };
  }

  // todas as datas do range, inclusive
  function rangeDates() {
    const { start, end } = getRange();
    const dates = [];
    let cur = parseISO(start);
    const last = parseISO(end);
    let guard = 0;
    while (cur <= last && guard < 366) {
      dates.push(fmtISO(cur));
      cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
      guard++;
    }
    return dates;
  }

  /* =========================================================================
   *  MATRIZ DE AGENDAMENTOS (baseada no RANGE configurado)
   * ========================================================================= */
  function getMatrix() {
    let m = getJSON(LS.matrix, null);
    const dates = rangeDates();
    const key0 = dates.join('|');
    if (!m || m._range !== key0) {
      m = { _range: key0, slots: {} };
      for (const d of dates) for (const h of CFG.HOURS) m.slots[`${d} ${h}`] = false;
      setJSON(LS.matrix, m);
      log(`Nova matriz criada para: ${dates[0]} a ${dates[dates.length-1]} (${Object.keys(m.slots).length} slots).`);
    }
    return m;
  }

  function nextPendingSlot() {
    const m = getMatrix();
    const pend = Object.keys(m.slots).filter(k => !m.slots[k]);
    return pend.length ? pend[0] : null; // ordem cronológica
  }

  function markScheduled(slotKey) { const m = getMatrix(); m.slots[slotKey] = true; setJSON(LS.matrix, m); }

  function progress() {
    const m = getMatrix(); const total = Object.keys(m.slots).length;
    const done = Object.values(m.slots).filter(Boolean).length;
    return { done, total };
  }

  /* =========================================================================
   *  ITEM ATUAL (persistido entre navegações)
   * ========================================================================= */
  let CURRENT_ITEM_ID = null;
  function setCurrentId(id){ CURRENT_ITEM_ID = id; sessionStorage.setItem('mlAgItemAtual', id || ''); }
  function getCurrentId(){ return CURRENT_ITEM_ID || sessionStorage.getItem('mlAgItemAtual') || null; }

  function markPlaced(id) {
    if (!id) return;
    const placed = new Set(getJSON(LS.placed, []));
    placed.add(id);
    setJSON(LS.placed, [...placed]);
  }

  function blockCurrentItem(motivo) {
    const id = getCurrentId();
    if (id) {
      const blocked = new Set(getJSON(LS.blocked, []));
      blocked.add(id);
      setJSON(LS.blocked, [...blocked]);
      log(`🚫 Item ${id} bloqueado (${motivo}). Não será usado novamente.`);
    } else {
      log(`🚫 Item bloqueado (${motivo}), id desconhecido.`);
    }
    setCurrentId(null);
  }

  /* =========================================================================
   *  PASSOS DO FLUXO
   * ========================================================================= */

  // 1) HUB: clicar no card "Produto em promoção" (2 de 4)
  async function stepHub() {
    log('Hub: procurando card "Produto em promoção" (2 de 4)…');
    const card = await waitFor(() =>
      document.querySelector('div[aria-label="2 de 4"] a[href*="/marketing"]') ||
      document.querySelector('a[href*="lista-produtos-promocao"]'));
    await humanClick(card);
  }

  // 2) LISTA: prefere itens NÃO usados; ao esgotar, reaproveita os que JÁ conseguiram agendar
  async function stepPickItem() {
    log('Lista: procurando itens elegíveis…');
    await waitFor('a.ui-broadcast-item-detail');
    await sleep(rnd(400, 900));

    const used    = new Set(getJSON(LS.usedIds, []));
    const blocked = new Set(getJSON(LS.blocked, []));
    const placed  = new Set(getJSON(LS.placed, []));

    const collectEligible = () => [...document.querySelectorAll('a.ui-broadcast-item-detail')]
      .map(a => ({ el: a, href: a.getAttribute('href') || '' }))
      .filter(o => o.href && o.href.includes('/marketing'))
      .map(o => ({ ...o, id: (o.href.match(/MLB\d+/) || [])[0] || null }))
      .filter(o => !(o.id && blocked.has(o.id))); // nunca os bloqueados

    const pagers = () => [...document.querySelectorAll('nav ul li.andes-pagination__button a')]
      .filter(a => /^\d+$/.test(a.textContent.trim()));

    // talvez pular para uma página aleatória (comportamento natural)
    const pg = pagers();
    if (pg.length && Math.random() < 0.5) {
      const t = pg[rnd(0, pg.length - 1)];
      log(`Navegando para página ${t.textContent.trim()}…`);
      await humanClick(t);
      await waitFor('a.ui-broadcast-item-detail');
      await sleep(rnd(600, 1200));
    }

    let items = collectEligible();
    let fresh = items.filter(o => o.id && !used.has(o.id));

    // procura itens NOVOS em outras páginas
    if (!fresh.length && pagers().length) {
      const order = pagers().map((_, i) => i).sort(() => Math.random() - 0.5);
      for (const idx of order) {
        const link = pagers()[idx];
        if (!link) continue;
        log(`Procurando itens novos na página ${link.textContent.trim()}…`);
        await humanClick(link);
        await waitFor('a.ui-broadcast-item-detail');
        await sleep(rnd(600, 1100));
        items = collectEligible();
        fresh = items.filter(o => o.id && !used.has(o.id));
        if (fresh.length) break;
      }
    }

    let pool, reuse = false;
    if (fresh.length) {
      pool = fresh; // preferência: ainda não usados
    } else {
      // Sem itens novos: REAPROVEITA os que JÁ conseguiram agendar antes (prioridade),
      // pois sabemos que funcionam. Se não houver, usa qualquer não-bloqueado.
      const placedPool = items.filter(o => o.id && placed.has(o.id));
      pool  = placedPool.length ? placedPool : items;
      reuse = true;
      log(`Sem anúncios novos. Reaproveitando ${placedPool.length ? 'anúncios já agendados' : 'anúncios já usados'} (não bloqueados) nos horários/datas em aberto.`);
    }

    if (!pool.length) {
      log('⚠️ Nenhum item utilizável (todos bloqueados) e ainda há slots. Parando.');
      setStr(LS.state, 'idle'); renderPanel();
      throw new Error('Sem itens utilizáveis.');
    }

    const chosen = pool[rnd(0, pool.length - 1)];
    setCurrentId(chosen.id);
    if (chosen.id && !reuse) { used.add(chosen.id); setJSON(LS.usedIds, [...used]); }
    log(`Item escolhido: ${chosen.id || '(sem MLB)'}${reuse ? ' (reuso)' : ''}`);
    await humanClick(chosen.el);
  }

  // 3) SELECTOR: se "Criar story" indisponível -> bloqueia id e volta. Retorna true se clicou.
  async function stepSelectStory() {
    log('Selector: verificando disponibilidade do card Story…');
    const sel = 'a.andes-button.communication-selector-card__button';
    let btn = await waitFor(() =>
      [...document.querySelectorAll(sel)].find(e => /criar story/i.test(e.textContent)));

    const t0 = Date.now();
    while (isDisabled(btn) && Date.now() - t0 < CFG.STORY_BTN_GRACE) {
      await sleep(400);
      btn = [...document.querySelectorAll(sel)].find(e => /criar story/i.test(e.textContent)) || btn;
    }

    if (isDisabled(btn)) {
      blockCurrentItem('Criar story indisponível');
      await sleep(rnd(500, 1000));
      history.back();
      return false;
    }

    log('Card Story disponível. Clicando em "Criar story"…');
    await humanClick(btn);
    return true;
  }

  // 4) FORM. Retorna: true (agendou) | false (slot pulado, item ok) | 'NO_DATES' (data indisponível p/ este item)
  async function stepForm(slotKey) {
    const [date, hour] = slotKey.split(' '); // date = 'YYYY-MM-DD'

    // Segurança: nunca processar um slot fora do range definido pelo usuário.
    const _r = getRange();
    if (parseISO(date) < parseISO(_r.start) || parseISO(date) > parseISO(_r.end)) {
      log(`⛔ Slot ${isoToBR(date)} está FORA do range ${isoToBR(_r.start)} → ${isoToBR(_r.end)}. Ignorando.`);
      markScheduled(slotKey); // remove da fila para não travar
      return true;
    }

    log(`Formulário: agendando ${isoToBR(date)} às ${hour}. Aguardando IA gerar imagem…`);
    await sleep(CFG.AI_WAIT);

    // === Controle da LEGENDA (toggle pré-ativado) ===
    const comLegenda = getStr(LS.legenda, 'on') !== 'off';
    const swLabel = document.querySelector('label.andes-switch[data-andes-switch="true"]');
    const sw = swLabel ? swLabel.querySelector('input.andes-switch__input')
                       : document.querySelector('input.andes-switch__input');

    if (comLegenda) {
      // Comportamento normal: garante a legenda LIGADA
      if (sw && !sw.checked) { log('Legenda ON: ativando switch…'); await humanClick(swLabel || sw); }
    } else {
      // Legenda OFF: desliga o toggle clicando na label //label[@data-andes-state="checked"]
      const lblChecked = document.querySelector('label.andes-switch[data-andes-state="checked"]') || swLabel;
      if (sw && sw.checked && lblChecked) {
        log('Legenda OFF: desativando o toggle de legenda…');
        await humanClick(lblChecked);
        await sleep(rnd(250, 600));
      } else {
        log('Legenda OFF: toggle já estava desativado.');
      }
    }

    log('Abrindo seletor de data/hora…');
    const dateInput = await waitFor('input[aria-expanded]');
    if (dateInput.getAttribute('aria-expanded') !== 'true') await humanClick(dateInput);
    await waitFor('tbody.andes-datepicker__body td[data-andes-datepicker-day="true"]');
    await sleep(rnd(400, 800));

    // ===== SELEÇÃO ROBUSTA DE DATA =====
    // date = 'YYYY-MM-DD'
    const [ty, tm] = date.split('-').map(Number); // ano/mês alvo (mês 1-12)

    // Meses em pt-BR como aparecem no cabeçalho do Andes (minúsculo)
    const MESES = ['janeiro','fevereiro','março','abril','maio','junho',
                   'julho','agosto','setembro','outubro','novembro','dezembro'];

    const captionEl = () => document.querySelector('.andes-datepicker__caption-label');

    // Lê o mês/ano atualmente exibido a partir do cabeçalho. Retorna {y, m} (m 1-12) ou null.
    const getVisibleMonth = () => {
      const el = captionEl();
      if (!el) return null;
      const txt = (el.textContent || '').trim().toLowerCase(); // ex: "julho 2026"
      const mm = MESES.findIndex(n => txt.includes(n));
      const yy = (txt.match(/(\d{4})/) || [])[1];
      if (mm < 0 || !yy) return null;
      return { y: Number(yy), m: mm + 1 };
    };

    // Considera SOMENTE células do próprio mês visível, habilitadas e visíveis.
    const isCellUsable = (td) => {
      if (!td) return false;
      const cls = td.className || '';
      if (cls.includes('--outside') || cls.includes('--hidden')) return false; // dia "vazante" de outro mês
      if (cls.includes('--disabled')) return false;
      if (td.getAttribute('data-disabled') === 'true') return false;
      if (td.getAttribute('data-andes-state') === 'disabled') return false;
      const b = td.querySelector('button.andes-datepicker__day');
      if (!b || b.disabled) return false;
      return true;
    };

    const findDayButton = () => {
      const tbody = document.querySelector('tbody.andes-datepicker__body');
      if (!tbody) return null;
      for (const td of tbody.querySelectorAll('td[data-day]')) {
        if (td.getAttribute('data-day') === date && isCellUsable(td)) {
          return td.querySelector('button.andes-datepicker__day');
        }
      }
      return null;
    };

    const nextMonthBtn = () => document.querySelector('button.andes-datepicker__button--next');
    const prevMonthBtn = () => document.querySelector('button.andes-datepicker__button--previous');

    // Navega até o mês/ano do alvo comparando com o cabeçalho. Avança/volta conforme necessário.
    const navigateToMonth = async () => {
      const targetIdx = ty * 12 + (tm - 1); // índice absoluto do mês alvo
      for (let i = 0; i < 24; i++) {        // limite de segurança (24 meses)
        const vis = getVisibleMonth();
        if (!vis) { await sleep(300); continue; }
        const visIdx = vis.y * 12 + (vis.m - 1);
        if (visIdx === targetIdx) return true;       // chegamos no mês certo
        const btn = visIdx < targetIdx ? nextMonthBtn() : prevMonthBtn();
        if (!btn || isDisabled(btn)) {
          log(`Botão de navegação de mês indisponível (alvo ${isoToBR(date)}).`);
          return false;
        }
        log(`Calendário em "${captionEl().textContent.trim()}". Navegando para ${MESES[tm-1]} ${ty}…`);
        await humanClick(btn);
        await sleep(rnd(500, 900)); // espera o calendário re-renderizar
      }
      return false;
    };

    // 1) Garante que estamos no mês/ano correto
    const okMonth = await navigateToMonth();
    if (!okMonth) {
      document.body.click();
      log(`Não consegui chegar no mês de ${isoToBR(date)}. Selecionando outro anúncio.`);
      return 'NO_DATES';
    }

    // 2) Agora procura o dia DENTRO do mês visível correto
    let dayBtn = findDayButton();
    if (!dayBtn) {
      document.body.click(); // fecha datepicker
      log(`Dia ${isoToBR(date)} indisponível neste anúncio (mês correto, mas dia bloqueado). Trocando de anúncio.`);
      return 'NO_DATES';
    }

    log(`Selecionando dia ${isoToBR(date)} (mês visível: ${captionEl().textContent.trim()})…`);
    await humanClick(dayBtn);
    await sleep(rnd(400, 800));

    // 3) Confirma que o dia ficou realmente selecionado antes de seguir
    const confirmSelected = () => {
      const td = [...document.querySelectorAll('tbody.andes-datepicker__body td[data-day]')]
        .find(t => t.getAttribute('data-day') === date);
      if (!td) return false;
      return td.getAttribute('data-selected') === 'true'
          || td.getAttribute('aria-selected') === 'true'
          || (td.className || '').includes('--selected');
    };

    if (!confirmSelected()) {
      // tenta uma segunda vez (re-render pode ter trocado o nó)
      const retry = findDayButton();
      if (retry) { await humanClick(retry); await sleep(rnd(300,600)); }
    }
    if (!confirmSelected()) {
      document.body.click();
      log(`Falha ao confirmar seleção de ${isoToBR(date)}. Trocando de anúncio.`);
      return 'NO_DATES';
    }
    // ===== TRAVA FINAL DE DATA =====
    // Garante que APENAS o dia-alvo está selecionado. Se qualquer outro dia
    // estiver marcado como selecionado, aborta este anúncio (nunca agenda em data errada).
    const selectedDays = [...document.querySelectorAll('tbody.andes-datepicker__body td[data-day]')]
      .filter(t => t.getAttribute('data-selected') === 'true'
                || t.getAttribute('aria-selected') === 'true'
                || (t.className || '').includes('--selected'))
      .map(t => t.getAttribute('data-day'));

    const onlyTargetSelected = selectedDays.length === 1 && selectedDays[0] === date;
    if (!onlyTargetSelected) {
      document.body.click();
      log(`⛔ Trava de data: seleção divergiu do alvo ${isoToBR(date)} (marcado: ${selectedDays.map(isoToBR).join(', ') || 'nenhum'}). Cancelando este anúncio para não agendar em data errada.`);
      return 'NO_DATES';
    }
    // ===== FIM DA SELEÇÃO DE DATA =====

    await sleep(rnd(400, 800));

    const findHour = () => [...document.querySelectorAll('.andes-box-selector input[data-andes-box-selector-item-input="true"]')]
      .find(i => (i.value || '').trim() === hour);
    const hourInput = await waitFor(findHour, 8000);
    log(`Selecionando horário ${hour}…`);
    const box = hourInput.closest('label') || hourInput.closest('.andes-box-selector__option') || hourInput;
    await humanClick(box);
    await sleep(rnd(300, 700));

    const applyBtn = await waitFor(() =>
      [...document.querySelectorAll('button.andes-button--loud')].find(b => /aplicar/i.test(b.textContent)));
    log('Clicando em Aplicar…');
    await humanClick(applyBtn);
    await sleep(rnd(700, 1300));

    const createBtn = await waitFor(() =>
      [...document.querySelectorAll('button.andes-button--large.andes-button--loud')]
        .find(b => /criar story/i.test(b.textContent) && !isDisabled(b)));
    log('Clicando em Criar story…');
    await humanClick(createBtn);

    markScheduled(slotKey);
    markPlaced(getCurrentId()); // registra que este anúncio conseguiu agendar (p/ reuso futuro)
    const p = progress();
    log(`✅ Agendado ${isoToBR(date)} ${hour}. Progresso: ${p.done}/${p.total}.`);
    await sleep(3000);
    return true;
  }

  /* =========================================================================
   *  ORQUESTRADOR
   * ========================================================================= */
  async function tick() {
    if (getStr(LS.state) !== 'running') return;

    const url = location.href;
    const slot = getStr(LS.target) || nextPendingSlot();

    if (!slot) {
      log('🎉 Todos os agendamentos concluídos!');
      setStr(LS.state, 'idle'); setStr(LS.target, ''); renderPanel(); return;
    }
    setStr(LS.target, slot);

    try {
      if (url.includes('formulario')) {
        const res = await stepForm(slot);
        if (res === 'NO_DATES') {
          // Não bloqueia o anúncio definitivamente (ele pode servir p/ outra data do range),
          // apenas troca de anúncio mantendo o slot pendente.
          setCurrentId(null);
          setStr(LS.target, slot); // mantém o slot pendente p/ outro anúncio
        } else {
          setStr(LS.target, '');   // agendou ou pulou este slot
        }
        await sleep(rnd(800, 1500));
        location.href = CFG.HUB_URL;
      }
      else if (url.includes('selector-comunicacao')) {
        const ok = await stepSelectStory();
        if (!ok) {
          await sleep(1500);
          if (location.href.includes('selector-comunicacao')) location.href = CFG.HUB_URL;
        }
      }
      else if (url.includes('lista-produtos-promocao')) {
        await stepPickItem();
      }
      else {
        await stepHub();
      }
    } catch (e) {
      log('⚠️ Erro: ' + e.message + '. Reiniciando do hub em 4s…');
      await sleep(4000);
      if (getStr(LS.state) === 'running' && location.pathname !== '/marketing/canal-de-transmissao') {
        location.href = CFG.HUB_URL;
      }
    }
  }

  /* =========================================================================
   *  PAINEL DE CONTROLE
   * ========================================================================= */
  let panel, logBox;
  let panelCollapsed = true; // começa minimizado (só a barra azul aparece)
  function renderPanel() {
    if (panel) panel.remove();
    panel = document.createElement('div');
    panel.style.cssText = `position:fixed;bottom:18px;right:18px;z-index:999999;width:300px;
      background:#fff;border:1px solid #e0e0e0;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.18);
      font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#333;overflow:hidden`;
    const running = getStr(LS.state) === 'running';
    const p = progress();
    const r = getRange();
    const blkCount = getJSON(LS.blocked, []).length;

    // Cabeçalho azul: clicável para minimizar/maximizar. Sempre visível.
    const header = `
      <div id="ag-header" title="Clique para ${panelCollapsed?'abrir':'minimizar'} o menu"
        style="background:#3483fa;color:#fff;padding:10px 12px;font-weight:bold;cursor:pointer;
        display:flex;align-items:center;justify-content:space-between;user-select:none">
        <span>🤖 Agendador de Stories</span>
        <span style="font-size:15px;line-height:1">${panelCollapsed?'▸':'▾'}</span>
      </div>`;

    if (panelCollapsed) {
      // Minimizado: apenas a barra azul.
      logBox = null;
      panel.innerHTML = header;
      document.body.appendChild(panel);
      panel.querySelector('#ag-header').onclick = () => { panelCollapsed = false; renderPanel(); };
      return;
    }

    panel.innerHTML = header + `
      <div style="padding:12px">
        <div style="margin-bottom:8px;display:flex;gap:6px;align-items:center">
          <label style="white-space:nowrap">De:</label>
          <input id="ag-start" type="text" inputmode="numeric" placeholder="DD/MM/AAAA" maxlength="10"
            value="${isoToBR(r.start)}" ${running?'disabled':''}
            title="Data inicial do range. Digite no formato DD/MM/AAAA (ex: 06/07/2026)."
            style="flex:1;padding:5px;border:1px solid #ccc;border-radius:5px;font-size:12px">
        </div>
        <div style="margin-bottom:8px;display:flex;gap:6px;align-items:center">
          <label style="white-space:nowrap">Até:</label>
          <input id="ag-end" type="text" inputmode="numeric" placeholder="DD/MM/AAAA" maxlength="10"
            value="${isoToBR(r.end)}" ${running?'disabled':''}
            title="Data final do range. Digite no formato DD/MM/AAAA (ex: 10/07/2026)."
            style="flex:1;padding:5px;border:1px solid #ccc;border-radius:5px;font-size:12px">
        </div>
        <div id="ag-date-err" style="font-size:11px;color:#e63946;margin-bottom:6px;min-height:14px"></div>
        <div style="font-size:11px;color:#888;margin-bottom:8px">Dica: para 1 dia só, deixe "De" e "Até" iguais. O agendamento acontece SEMPRE dentro deste range.</div>
        <div style="margin-bottom:6px">Range: <b>${isoToBR(r.start)}</b> → <b>${isoToBR(r.end)}</b></div>
        <div style="margin-bottom:6px">Progresso: <b>${p.done}/${p.total}</b> agendados</div>
        <div style="margin-bottom:10px">IDs bloqueados: <b>${blkCount}</b></div>
        <div style="display:flex;gap:8px;margin-bottom:10px">
          <button id="ag-start-btn"
            title="Aplica o range de datas informado e começa a agendar os stories automaticamente."
            style="flex:1;padding:8px;border:none;border-radius:6px;cursor:pointer;
            background:${running?'#999':'#00a650'};color:#fff;font-weight:bold">${running?'Em execução…':'▶ Iniciar'}</button>
          <button id="ag-stop"
            title="Interrompe o agendamento em andamento. Os slots já agendados são mantidos."
            style="flex:1;padding:8px;border:none;border-radius:6px;cursor:pointer;
            background:#e63946;color:#fff;font-weight:bold">⏹ Parar</button>
        </div>
        <div style="display:flex;gap:6px;margin-bottom:6px">
          <button id="ag-reset"
            title="Zera a matriz de agendamentos (marca todos os horários do range como pendentes de novo)."
            style="flex:1;padding:6px;border:1px solid #ccc;border-radius:6px;cursor:pointer;background:#f5f5f5">Resetar matriz</button>
          <button id="ag-resetids"
            title="Limpa a lista de anúncios já usados/agendados, liberando-os para serem reutilizados."
            style="flex:1;padding:6px;border:1px solid #ccc;border-radius:6px;cursor:pointer;background:#f5f5f5">Limpar usados</button>
        </div>
        <div style="display:flex;gap:6px;margin-bottom:10px">
          <button id="ag-resetblk"
            title="Limpa a lista de anúncios bloqueados (inválidos), permitindo que sejam testados novamente."
            style="flex:1;padding:6px;border:1px solid #ccc;border-radius:6px;cursor:pointer;background:#f5f5f5">Limpar bloqueados</button>
        </div>
        <div id="ag-log" style="height:120px;overflow:auto;background:#fafafa;border:1px solid #eee;
          border-radius:6px;padding:6px;font-size:11px;line-height:1.4;white-space:pre-wrap"></div>
        <div style="margin-top:8px;margin-bottom:2px;display:flex;gap:6px;align-items:center;justify-content:space-between">
          <label for="ag-legenda" style="white-space:nowrap"
            title="Quando marcado, os stories são criados com a legenda do anúncio. Desmarcado, o toggle de legenda é desligado antes de criar.">Com legenda:</label>
          <input id="ag-legenda" type="checkbox" ${getStr(LS.legenda,'on')!=='off'?'checked':''} ${running?'disabled':''}
            title="Quando marcado, os stories são criados com a legenda do anúncio. Desmarcado, o toggle de legenda é desligado antes de criar."
            style="width:18px;height:18px;cursor:pointer">
        </div>
      </div>`;
    document.body.appendChild(panel);
    logBox = panel.querySelector('#ag-log');

    // Clique no cabeçalho azul minimiza o menu.
    panel.querySelector('#ag-header').onclick = () => { panelCollapsed = true; renderPanel(); };

    const errBox = panel.querySelector('#ag-date-err');
    const showErr = (msg) => { if (errBox) errBox.textContent = msg || ''; };

    // Valida 'DD/MM/AAAA' e confere se a data existe de fato (dia/mês/ano coerentes).
    const isValidBR = (s) => {
      const iso = brToISO(s);
      if (!iso) return false;
      const [y, m, d] = iso.split('-').map(Number);
      if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return false;
      const dt = new Date(y, m - 1, d);
      return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
    };

    // Máscara automática enquanto digita: só números, insere as barras.
    const maskInput = (inp) => {
      inp.addEventListener('input', () => {
        let v = inp.value.replace(/\D/g, '').slice(0, 8);
        if (v.length > 4) v = v.slice(0,2) + '/' + v.slice(2,4) + '/' + v.slice(4);
        else if (v.length > 2) v = v.slice(0,2) + '/' + v.slice(2);
        inp.value = v;
        showErr('');
      });
    };

    // Lê e valida as datas dos campos. Retorna {start,end} em ISO ou null (com erro exibido).
    const applyRangeFromInputs = () => {
      const sBR = panel.querySelector('#ag-start').value.trim();
      const eBRraw = panel.querySelector('#ag-end').value.trim();
      const eBR = eBRraw || sBR;

      if (!sBR) { showErr('Defina a data inicial (DD/MM/AAAA).'); return null; }
      if (!isValidBR(sBR)) { showErr(`Data inicial inválida: "${sBR}". Use DD/MM/AAAA (ex: 06/07/2026).`); return null; }
      if (!isValidBR(eBR)) { showErr(`Data final inválida: "${eBR}". Use DD/MM/AAAA (ex: 10/07/2026).`); return null; }

      showErr('');
      const nr = setRange(brToISO(sBR), brToISO(eBR)); // setRange já garante start <= end
      const legChk = panel.querySelector('#ag-legenda');
      if (legChk) legChk.onchange = () => {
          setStr(LS.legenda, legChk.checked ? 'on' : 'off');
          log(legChk.checked ? 'Opção "Com legenda" ATIVADA.' : 'Opção "Com legenda" DESATIVADA (toggle será desligado antes de criar).');
      };
      // recria a matriz para o novo range
      localStorage.removeItem(LS.matrix);
      getMatrix();
      return nr;
    };

    // aplica máscara aos campos de data
    const startInp = panel.querySelector('#ag-start');
    const endInp   = panel.querySelector('#ag-end');
    if (startInp) maskInput(startInp);
    if (endInp)   maskInput(endInp);

    panel.querySelector('#ag-start-btn').onclick = () => {
      const nr = applyRangeFromInputs();
      if (!nr) return;

      // >>> salva o estado da legenda ANTES de iniciar <<<
      const legChkEl = panel.querySelector('#ag-legenda');
      const comLegenda = legChkEl ? legChkEl.checked : true;
      setStr(LS.legenda, comLegenda ? 'on' : 'off');

      setStr(LS.state, 'running');
      log(`▶ Iniciado. Range ${isoToBR(nr.start)} → ${isoToBR(nr.end)}. Legenda: ${comLegenda ? 'ON' : 'OFF'}.`);
      renderPanel(); tick();
    };
    panel.querySelector('#ag-stop').onclick  = () => { setStr(LS.state,'idle'); log('⏹ Parado pelo usuário.'); renderPanel(); };
    panel.querySelector('#ag-reset').onclick    = () => { localStorage.removeItem(LS.matrix); getMatrix(); log('Matriz resetada.'); renderPanel(); };
    panel.querySelector('#ag-resetids').onclick = () => { localStorage.removeItem(LS.usedIds); localStorage.removeItem(LS.placed); log('IDs usados/agendados limpos.'); renderPanel(); };
    panel.querySelector('#ag-resetblk').onclick = () => { localStorage.removeItem(LS.blocked); log('IDs bloqueados limpos.'); renderPanel(); };

    // ao sair do campo (blur), valida e já atualiza o range/matriz e o painel
    const onDateBlur = () => {
      if (getStr(LS.state) === 'running') return;
      const cur = panelCollapsed; // preserva estado de minimizado
      const nr = applyRangeFromInputs();
      if (nr) { panelCollapsed = cur; renderPanel(); }
    };
    if (startInp) startInp.addEventListener('blur', onDateBlur);
    if (endInp)   endInp.addEventListener('blur', onDateBlur);

    renderLog();
  }
  function renderLog() { if (!logBox) return; logBox.textContent = getJSON(LS.log, []).slice(-40).join('\n'); logBox.scrollTop = logBox.scrollHeight; }

  /* =========================================================================
   *  BOOTSTRAP
   * ========================================================================= */
  function init() {
    getRange();   // garante range padrão
    renderPanel();
    if (getStr(LS.state) === 'running') {
      log(`Página carregada: ${location.pathname.split('/').pop()}. Retomando…`);
      setTimeout(tick, rnd(1200, 2200));
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();