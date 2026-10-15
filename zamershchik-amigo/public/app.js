/* Замеры Amigo — клиент PWA.
   Всё общение с сервером идёт через /api (там же прокси к Amigo Customizer),
   потому что у Amigo закрыт CORS и напрямую из браузера позвонить нельзя. */
(() => {
  'use strict';

  // ── Утилиты ─────────────────────────────────────────────────────────────
  const $ = (selector) => document.querySelector(selector);
  const view = () => $('#view');

  const esc = (value) =>
    String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Прайс Amigo в долларах, замерщику показываем в рублях
  const money = (value) =>
    `${Number(value || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;

  /** Исходная цена прайса: 36,02 $ → рядом с рублёвой, чтобы сверить */
  const sourceMoney = (value, symbol) =>
    `${Number(value || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${symbol || '$'}`;

  const plural = (n, one, few, many) => {
    const abs = Math.abs(n) % 100;
    const last = abs % 10;
    if (abs > 10 && abs < 20) return many;
    if (last > 1 && last < 5) return few;
    if (last === 1) return one;
    return many;
  };

  const fmtDate = (iso) => {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const debounce = (fn, ms) => {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  };

  const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
  const load = (key, fallback) => {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  };

  // ── Состояние ───────────────────────────────────────────────────────────
  const state = {
    token: localStorage.getItem('zam.token') || '',
    user: null,
    view: 'login',
    stack: [],
    params: {},
    catalog: null,
    draft: null, // редактируемое изделие
    cart: load('zam.cart', []),
    client: load('zam.client', {}),
    photos: [], // dataURL, живут только до отправки — слишком тяжёлые для localStorage
    requisitesPhoto: null, // скан реквизитов ЮЛ, едет вместе с заявкой
    calc: null,
    loginUsers: null,   // список сотрудников для выбора при входе
    loginUser: null,    // выбранный сотрудник
    loginError: '',
    pin: '',
    sending: false,
  };

  const persistCart = () => {
    save('zam.cart', state.cart);
    paintBadge();
  };
  const persistClient = () => save('zam.client', state.client);

  // ── Сеть ────────────────────────────────────────────────────────────────
  async function api(path, options = {}) {
    const method = options.method || (options.body ? 'POST' : 'GET');
    const response = await fetch(path, {
      method,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    let data = null;
    try {
      data = await response.json();
    } catch {
      /* пустой ответ */
    }

    if (!response.ok) {
      if (response.status === 401) logout(true);
      const error = new Error(data?.error || `Сервер ответил ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  /** GET с запасным кэшем: в поле, где нет сети, каталог должен открыться. */
  async function apiCached(path) {
    const key = `zam.cache:${path}`;
    try {
      const data = await api(path);
      localStorage.setItem(key, JSON.stringify({ at: Date.now(), data }));
      return data;
    } catch (error) {
      const raw = localStorage.getItem(key);
      if (raw) return JSON.parse(raw).data;
      throw error;
    }
  }

  // ── Очередь для офлайна (IndexedDB) ────────────────────────────────────
  const idb = () =>
    new Promise((resolve, reject) => {
      const request = indexedDB.open('zamershchik', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

  async function outboxAll() {
    try {
      const db = await idb();
      return await new Promise((resolve, reject) => {
        const request = db.transaction('outbox', 'readonly').objectStore('outbox').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } catch {
      return [];
    }
  }

  async function outboxPut(value) {
    const db = await idb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('outbox', 'readwrite');
      tx.objectStore('outbox').put(value);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  async function outboxDelete(id) {
    const db = await idb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('outbox', 'readwrite');
      tx.objectStore('outbox').delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  // ── Уведомления ─────────────────────────────────────────────────────────
  function toast(text, kind = '') {
    const node = document.createElement('div');
    node.className = `toast${kind ? ` toast--${kind}` : ''}`;
    node.textContent = text;
    $('#toasts').appendChild(node);
    setTimeout(() => node.remove(), kind === 'bad' ? 5200 : 3000);
  }

  function confirmBox(title, text, okLabel = 'Продолжить') {
    return new Promise((resolve) => {
      const modal = $('#modal');
      $('#modal-box').innerHTML = `
        <div class="modal__title">${esc(title)}</div>
        <div class="modal__text">${esc(text)}</div>
        <div class="btn-row">
          <button class="btn btn--ghost" data-modal="no" type="button">Отмена</button>
          <button class="btn" data-modal="yes" type="button">${esc(okLabel)}</button>
        </div>`;
      modal.hidden = false;
      modal.onclick = (event) => {
        const answer = event.target.dataset?.modal;
        if (!answer) return;
        modal.hidden = true;
        modal.onclick = null;
        resolve(answer === 'yes');
      };
    });
  }

  // ── Каркас ──────────────────────────────────────────────────────────────
  const TITLES = {
    systems: 'Каталог',
    models: 'Модели',
    item: 'Изделие',
    cart: 'Заявка',
    history: 'История',
    account: 'Профиль',
    admin: 'Администрирование',
  };

  const TAB_VIEWS = ['systems', 'cart', 'history', 'account'];

  function go(next, params = {}, replace = false) {
    if (!replace && state.view !== 'login') state.stack.push({ view: state.view, params: state.params });
    state.view = next;
    state.params = params;
    render();
    window.scrollTo(0, 0);
  }

  function back() {
    // С экрана администрирования всегда возвращает на «Профиль»:
    // там единственная кнопка входа в этот раздел
    if (state.view === 'admin') {
      go('account', {}, true);
      return;
    }
    const previous = state.stack.pop();
    if (previous) {
      state.view = previous.view;
      state.params = previous.params;
    } else {
      state.view = 'systems';
      state.params = {};
    }
    render();
  }

  function paintBadge() {
    const badge = $('#cart-badge');
    const count = state.cart.length;
    badge.textContent = String(count);
    badge.hidden = count === 0;
  }

  function chrome(visible) {
    $('#topbar').hidden = !visible;
    $('#tabbar').hidden = !visible;
    document.body.classList.toggle('no-tabs', !visible);
    // На экране админки нижняя панель прячется — иначе она перекрывает кнопки
    document.body.classList.toggle('no-tabs', !visible || state.view === 'admin');
    if (!visible) return;

    const current = TITLES[state.view] || 'Замеры';
    $('#topbar-title').textContent =
      state.view === 'models' ? (state.catalog?.find((s) => s.id === state.params.systemId)?.name ?? 'Модели')
      : state.view === 'item' ? (state.draft?.modelName ?? 'Изделие')
      : current;

    $('#topbar-user').textContent = state.user?.name || '';
    // Панель расчёта висит поверх содержимого — экрану изделия нужен запас снизу
    view().classList.toggle('view--with-calc', state.view === 'item');
    $('#btn-back').classList.toggle(
      'is-visible',
      state.view === 'models' || state.view === 'item' || state.view === 'cart' || state.view === 'admin',
    );

    document.querySelectorAll('.tabbar__btn').forEach((button) => {
      const target = button.dataset.nav;
      const active = target === state.view || (target === 'systems' && state.view === 'models');
      button.classList.toggle('is-active', active);
      // На экране админки нижняя панель лишняя: там своя навигация назад
      button.hidden = state.view === 'admin';
    });
    paintBadge();
  }

  // ── Экраны ──────────────────────────────────────────────────────────────
  const VIEWS = {
    systems: viewSystems,
    models: viewModels,
    item: viewItem,
    cart: viewCart,
    history: viewHistory,
    account: viewAccount,
    admin: viewAdmin,
  };

  /** Единая точка входа: рисует текущий экран. */
  function render() {
    const show = VIEWS[state.view];
    if (state.view === 'login' || !show) {
      renderLogin();
      return;
    }
    show();
  }

  function renderLogin() {
    chrome(false);
    $('#topbar').hidden = true;
    $('#tabbar').hidden = true;
    document.body.classList.add('no-tabs');

    // Шаг 1 — выбрать себя, шаг 2 — ввести свой PIN
    if (!state.loginUser) {
      if (state.loginUsers === null) {
        view().innerHTML = `
          <div class="login">
            <h1>Замеры Amigo</h1>
            <div class="muted small">Загружаю список сотрудников…</div>
          </div>`;
        loadLoginUsers();
        return;
      }

      view().innerHTML = `
        <div class="login login--wide">
          <h1>Кто заходит?</h1>
          <div class="muted small">Выберите себя, потом введите свой PIN</div>
          ${
            state.loginError
              ? `<div class="card__title" style="margin-top:12px;color:#b03a3a">${esc(state.loginError)}</div>`
              : ''
          }
          <div class="users">
            ${
              state.loginUsers.length
                ? state.loginUsers
                    .map(
                      (user) => `
              <button class="user-pick" type="button" data-action="pick-login-user" data-id="${esc(user.id)}">
                <span class="user-pick__name">${esc(user.name)}</span>
                <span class="user-pick__role">${user.role === 'admin' ? 'Администратор' : 'Замерщик'}</span>
              </button>`,
                    )
                    .join('')
                : '<div class="muted small">Сотрудников пока нет. Их добавляет администратор в разделе «Администрирование».</div>'
            }
          </div>
        </div>`;
      return;
    }

    view().innerHTML = `
      <div class="login">
        <button class="login__switch" type="button" data-action="change-login-user">‹ Другой сотрудник</button>
        <h1>${esc(state.loginUser.name)}</h1>
        <div class="muted small">${state.loginUser.role === 'admin' ? 'Администратор' : 'Замерщик'} · введите свой PIN</div>
        <div class="login__pin${state.pin ? ' is-filled' : ''}" id="pin-display">${state.pin ? '•'.repeat(state.pin.length) : ''}</div>
        <div class="pinpad">
          ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button type="button" data-pin="${n}">${n}</button>`).join('')}
          <button type="button" data-pin="clear">✕</button>
          <button type="button" data-pin="0">0</button>
          <button type="button" data-pin="back">⌫</button>
        </div>
        <div style="height:12px"></div>
        <button class="btn btn--accent" id="btn-login" type="button">Войти</button>
      </div>`;
  }

  /** Список сотрудников нужен до входа — именно он и предлагает выбор. */
  async function loadLoginUsers() {
    try {
      const data = await api('/api/login/users');
      state.loginUsers = data.users || [];
      state.loginError = '';
    } catch (error) {
      state.loginUsers = [];
      state.loginError =
        error.status === undefined ? 'Нет связи с сервером. Проверьте, что он запущен.' : error.message;
    }
    renderLogin();
  }

  function loading(text = 'Загружаю каталог…') {
    view().innerHTML = `<div class="loader">${esc(text)}</div>`;
  }

  async function viewSystems() {
    chrome(true);
    loading();

    if (!state.catalog) {
      try {
        const data = await apiCached('/api/catalog');
        state.catalog = data.systems;
      } catch (error) {
        view().innerHTML = `
          <div class="card">
            <div class="empty">
              <div class="empty__icon">📡</div>
              <div>Каталог не загрузился</div>
              <div class="small" style="margin-top:6px">${esc(error.message)}</div>
            </div>
            <button class="btn" data-action="reload-catalog" type="button">Повторить</button>
          </div>`;
        return;
      }
    }

    view().innerHTML = `
      <div class="section-title">Что мерим?</div>
      <div class="grid">
        ${state.catalog
          .map(
            (system) => `
          <button class="tile" data-action="open-system" data-id="${system.id}" type="button">
            <span class="tile__name">${esc(system.name)}</span>
            <span class="tile__meta">${system.models.length} ${plural(system.models.length, 'модель', 'модели', 'моделей')}</span>
          </button>`,
          )
          .join('')}
      </div>`;
    chrome(true);
  }

  async function viewModels() {
    chrome(true);
    const system = state.catalog?.find((s) => s.id === Number(state.params.systemId));
    if (!system) return go('systems', {}, true);
    loading();

    view().innerHTML = `
      <div class="grid">
        ${system.models
          .map(
            (model) => `
          <button class="tile" data-action="open-model" data-id="${model.id}" data-system="${system.id}" type="button">
            <span class="tile__name">${esc(model.name)}</span>
            ${model.code1c ? `<span class="tile__meta">${esc(model.code1c)}</span>` : ''}
          </button>`,
          )
          .join('')}
      </div>`;
    chrome(true);
  }

  /**
 * Экран выбора варианта для двухуровневых моделей (плиссе, гофре).
 * У семейства «Модели MIDI» 81 вариант, поэтому с поиском.
 */
  function renderVariants(system, model, subModels) {
    const draw = () => {
      const query = (state.subSearch || '').trim().toLowerCase();
      const filtered = query
        ? subModels.filter((s) =>
            [s.name, s.code1c, s.description].filter(Boolean).join(' ').toLowerCase().includes(query),
          )
        : subModels;

      const container = $('#subs');
      if (!container) return;
      container.innerHTML = filtered.length
        ? filtered
            .map(
              (s) => `
        <button class="sub" type="button" data-action="pick-sub" data-id="${s.id}">
          ${s.image ? `<img class="sub__image" src="${esc(s.image)}" alt="" loading="lazy">` : '<span class="sub__image sub__image--empty"></span>'}
          <span class="sub__body">
            <span class="sub__name">${esc(s.name)}</span>
            ${s.code1c ? `<span class="sub__code">Артикул ${esc(s.code1c)}</span>` : ''}
            ${s.description ? `<span class="sub__desc">${esc(s.description)}</span>` : ''}
          </span>
        </button>`,
            )
            .join('')
        : '<div class="muted small">Ничего не найдено</div>';
    };

    view().innerHTML = `
      <div class="card">
        <div class="card__title">Изделие</div>
        <div style="font-weight:700;font-size:17px">${esc(system.name)} · ${esc(model.name)}</div>
        <div class="muted small">
          Семейство, а не готовое изделие: ${subModels.length}
          ${plural(subModels.length, 'вариант', 'варианта', 'вариантов')} со своими тканями и ценой.
        </div>
      </div>

      <div class="card">
        <div class="card__title">1. Вариант модели</div>
        ${
          subModels.length > 12
            ? `<input class="input" id="sub-search" type="search" placeholder="Поиск: P1600 или артикул"
                 value="${esc(state.subSearch || '')}" style="margin-bottom:10px">`
            : ''
        }
        <div class="subs" id="subs"></div>
      </div>`;

    draw();

    const search = $('#sub-search');
    if (search) {
      search.addEventListener('input', (event) => {
        state.subSearch = event.target.value;
        draw();
      });
    }
  }

  async function viewItem() {
    chrome(true);
    const { systemId, modelId } = state.params;
    const system = state.catalog?.find((s) => s.id === Number(systemId));
    const model = system?.models.find((m) => m.id === Number(modelId));
    if (!model) return go('systems', {}, true);

    // У плиссе и гофре модель двухуровневая: «Модели MIDI» — семейство из 81
    // варианта (P1600, P2000…). Ткани, опции и цена живут у варианта, поэтому
    // работаем по его id, а не по id семейства.
    const subModels = Array.isArray(model.subModels) ? model.subModels : [];
    const sub = subModels.find((s) => s.id === Number(state.params.subId)) || null;
    const workingId = sub ? sub.id : model.id;

    if (!state.draft || state.draft.modelId !== workingId) {
      state.draft = {
        systemId: system.id,
        systemName: system.name,
        // По этому id идут ткани, опции и расчёт
        modelId: workingId,
        modelName: model.name,
        subModelId: sub ? sub.id : null,
        subModelName: sub ? sub.name : null,
        modelCode: sub ? sub.code1c : model.code1c,
        materialId: null,
        materialName: null,
        swatch: null,
        sizes: { width: '', height: '' },
        quantity: 1,
        options: [], // [{code, valueId}] — итоговый выбор, попадёт и в расчёт, и в письмо
        optionsMeta: [], // [{code, name, value}] — подписи для показа в заявке
        numbers: {}, // числовые опции, введённые руками
        optionsValues: {},
        noMaterials: false,
        // Как снят размер. В Amigo таких полей нет, поэтому на цену они
        // не влияют — это пометка для офиса, по какому краю мерили.
        measure: { by: '', from: '' },
        // Тип управления для вертикальных жалюзи: у них в каталоге Amigo есть
        // только «Левое / Правое», а «К управлению / От управления / От центра»
        // заведено лишь для шторных карнизов. Тоже пометка для офиса.
        control: { type: '' },
        // Тип крепления: в каталоге Amigo он заведён лишь у двух моделей
        // Зебры (опция ТипУстановкиГИ), у MINI и классики — нет. Тоже ручная
        // отметка: монтажники всё равно читают её из письма.
        mount: { type: '' },
        // Электропривод и комплект электрики. В каталоге Amigo они заведены
        // только у ZIP, ZIP ROOF и LOCK — из 48 рулонных моделей. Остальным
        // 45 тоже нужны, поэтому набор тот же, что у Amigo.
        electric: { motor: '', kit: '' },
      };
      // Каталог открыт: после выбора ткани сворачиваем, чтобы размеры были рядом
      state.fabricOpen = true;
      state.calc = null;
    }
    state.subSearch = state.subSearch || '';

    // Вариант модели не выбран — дальше идти нельзя: у семейства нет ни тканей,
    // ни цены. Показываем только список вариантов.
    if (subModels.length && !sub) {
      renderVariants(system, model, subModels);
      return;
    }

    let materials = [];
    let options = [];
    // Повторная отрисовка (свернуть/развернуть каталог) берёт данные из памяти,
    // иначе каждое переключение мигало бы экраном загрузки
    const itemCache = state.itemCache;
    if (itemCache && itemCache.modelId === workingId) {
      materials = itemCache.materials;
      options = itemCache.options;
      state.optionsCache = options;
      state.draft.noMaterials = materials.length === 0;
    } else {
      loading('Загружаю ткани и опции…');
      try {
        const [materialData, optionData] = await Promise.all([
          apiCached(`/api/catalog/materials?model=${workingId}`),
          apiCached(`/api/catalog/options?model=${workingId}`),
        ]);
        materials = materialData.items;
        options = optionData.items;
        state.itemCache = { modelId: workingId, materials, options };
        // Пригодится обработчику выпадающих списков: по коду найти название опции
        state.optionsCache = options;
        // Флаг живёт в черновике — именно его читает расчёт
        state.draft.noMaterials = materials.length === 0;
      } catch (error) {
        view().innerHTML = `
          <div class="card"><div class="empty"><div class="empty__icon">📡</div>
          <div>Не удалось загрузить ${esc(error.message)}</div></div>
          <button class="btn" data-action="reload-item" type="button">Повторить</button></div>`;
        return;
      }
    }

    const selectOptions = options.filter((o) => !o.auto && o.values.length);
    const numberOptions = options.filter((o) => o.auto && o.fieldType === 'T');
    if (!Array.isArray(state.draft.optionsMeta)) state.draft.optionsMeta = [];
    if (!state.draft.numbers || typeof state.draft.numbers !== 'object') state.draft.numbers = {};

    // Значения по умолчанию подставляем сразу: замерщик не должен гадать,
    // что там за цвет стоит, — но может поменять одним нажатием.
    // Пропускаем опции, где по умолчанию сервер подставляет «Длина управления».
    for (const option of selectOptions) {
      const hasDefault = option.defaultValue !== null && option.defaultValue !== undefined;
      const serverComputed = /управлен|длина|длупр/i.test(option.name);
      if (hasDefault && !serverComputed && !state.draft.options.some((o) => o.code === option.code)) {
        state.draft.options.push({ code: option.code, valueId: Number(option.defaultValue) });
        // Подпись тоже запоминаем: иначе в заявке вместо «Открытие шторы:
        // К управлению» приедет код ТипУпр
        const value = option.values.find((v) => Number(v.id) === Number(option.defaultValue));
        state.draft.optionsMeta.push({ code: option.code, name: option.name, value: value?.name || '' });
      }
    }

    const chosen = (code) => state.draft.options.find((o) => o.code === code)?.valueId;
    const draftMeasure = state.draft.measure || (state.draft.measure = { by: '', from: '' });
    const draftControl = state.draft.control || (state.draft.control = { type: '' });
    const draftMount = state.draft.mount || (state.draft.mount = { type: '' });
    const draftElectric = state.draft.electric || (state.draft.electric = { motor: '', kit: '' });

    // У шторных карнизов тип управления есть в каталоге сам (опция ТипУпр) —
    // тогда ручная отметка была бы вторым ответом на один вопрос
    const hasAmigoControlType = options.some((o) => o.code === 'ТипУпр');
    const showControl = CONTROL_SYSTEMS.test(system.name) && !hasAmigoControlType;
    // Тип установки в каталоге заведён только у двух моделей Зебры
    const hasAmigoMount = options.some((o) => o.code === 'ТипУстановкиГИ');
    const showMount = MOUNT_SYSTEMS.test(system.name) && !hasAmigoMount;
    // Электрика в каталоге есть только у ZIP, ZIP ROOF и LOCK
    const hasAmigoElectric = options.some((o) => o.code === 'КомплектЭлектрики');
    const showElectric = ELECTRIC_SYSTEMS.test(system.name) && !hasAmigoElectric;

    // Шаги нумеруем по факту: у двухуровневых моделей первый шаг ушёл на выбор
    // варианта, у шторных карнизов нет блока замера, у части моделей нет опций —
    // пустых номеров в заголовках быть не должно
    const showMeasure = MEASURE_SYSTEMS.test(system.name);
    let step = subModels.length ? 2 : 1;
    const stepFabric = step++;
    const stepSize = step++;
    const stepMeasure = showMeasure ? step++ : 0;
    const stepControl = showControl ? step++ : 0;
    const stepMount = showMount ? step++ : 0;
    const stepElectric = showElectric ? step++ : 0;
    const stepOptions = selectOptions.length ? step++ : 0;
    const stepExtra = numberOptions.length ? step++ : 0;

    view().innerHTML = `
      <div class="card">
        <div class="card__title">Изделие</div>
        <div style="font-weight:700;font-size:17px">${esc(system.name)} · ${esc(model.name)}${
          state.draft.subModelName ? ` · ${esc(state.draft.subModelName)}` : ''
        }</div>
        ${state.draft.modelCode ? `<div class="muted small">Артикул ${esc(state.draft.modelCode)}</div>` : ''}
      </div>

      <div class="card" id="card-fabric">
        <div class="card__title">${stepFabric}. Ткань</div>
        ${
          materials.length === 0
            ? `<div class="card__title" style="color:#b03a3a;margin-top:0">Ткани для этой модели в Amigo не заведены</div>
               <div class="small muted">
                 Замерщик снимает размеры и оформляет заявку — цену посчитает офис.
                 Обычно это системы «Шторы плиссе» и «Шторы гофре».
               </div>`
            : state.fabricOpen === false && state.draft.materialName
              ? `<button class="fabric-picked" type="button" data-action="toggle-fabric" aria-expanded="false">
                   ${state.draft.swatch ? `<img class="fabric-picked__swatch" src="${esc(state.draft.swatch)}" alt="">` : '<span class="fabric-picked__swatch fabric-picked__swatch--empty"></span>'}
                   <span class="fabric-picked__text">
                     <span class="fabric-picked__name">${esc(state.draft.materialName)}</span>
                     ${state.draft.materialColor ? `<span class="fabric-picked__color">${esc(state.draft.materialColor)}</span>` : ''}
                   </span>
                   <span class="fabric-picked__action">Заменить</span>
                 </button>`
              : `<input class="input" id="fabric-search" type="search" placeholder="Поиск: название, коллекция, цвет"
                   value="${esc(state.fabricSearch || '')}" style="margin-bottom:10px">
                 ${
                   state.draft.materialName
                     ? `<button class="fabric-back" type="button" data-action="toggle-fabric">
                          ← Выбрана: ${esc(state.draft.materialName)} — свернуть
                        </button>`
                     : ''
                 }
                 <div class="fabrics" id="fabrics"></div>`
        }
      </div>

      <div class="card" id="card-size">
        <div class="card__title">${stepSize}. Размер изделия</div>
        <div class="sizes">
          <div class="field">
            <label class="field__label" for="size-width">Ширина</label>
            <div class="size-input">
              <input class="input" id="size-width" type="number" inputmode="numeric" min="1" step="1"
                     placeholder="1200" value="${esc(state.draft.sizes.width)}">
              <span class="size-input__unit">мм</span>
            </div>
          </div>
          <div class="field">
            <label class="field__label" for="size-height">Высота</label>
            <div class="size-input">
              <input class="input" id="size-height" type="number" inputmode="numeric" min="1" step="1"
                     placeholder="1500" value="${esc(state.draft.sizes.height)}">
              <span class="size-input__unit">мм</span>
            </div>
          </div>
        </div>
        <div class="field">
          <label class="field__label" for="qty">Количество</label>
          <input class="input" id="qty" type="number" inputmode="numeric" min="1" step="1" value="${state.draft.quantity}">
        </div>
      </div>

      ${
        showMeasure
          ? `<div class="card">
              <div class="card__title">${stepMeasure}. Как снят размер</div>
              <div class="field">
                <label class="field__label">Что означает ширина и высота</label>
                <div class="chips">
                  ${MEASURE_BY.map(
                    (m) => `<button class="chip${draftMeasure.by === m.v ? ' is-active' : ''}" type="button"
                              data-action="pick-measure" data-kind="by" data-value="${m.v}">${esc(m.t)}</button>`,
                  ).join('')}
                </div>
              </div>
              <div class="field">
                <label class="field__label">Откуда снят размер</label>
                <div class="chips">
                  ${MEASURE_FROM.map(
                    (m) => `<button class="chip${draftMeasure.from === m.v ? ' is-active' : ''}" type="button"
                              data-action="pick-measure" data-kind="from" data-value="${m.v}">${esc(m.t)}</button>`,
                  ).join('')}
                </div>
              </div>
              <div class="small muted">
                Amigo считает по габариту изделия. Отметка попадёт в заявку и письмо —
                офис учтёт её при раскрое.
              </div>
            </div>`
          : ''
      }

      ${
        showControl
          ? `<div class="card">
              <div class="card__title">${stepControl}. Тип управления</div>
              <div class="field">
                <label class="field__label">Сторона открывания</label>
                <div class="chips">
                  ${CONTROL_TYPES.map(
                    (c) => `<button class="chip${draftControl.type === c.v ? ' is-active' : ''}" type="button"
                              data-action="pick-control" data-value="${c.v}">${esc(c.t)}</button>`,
                  ).join('')}
                </div>
              </div>
              <div class="small muted">
                У вертикальных жалюзи в каталоге Amigo есть только «Левое / Правое» —
                сторона стоит в опциях ниже. Тип открывания там не заведён,
                поэтому отметка уходит в заявку и письмо для офиса.
              </div>
            </div>`
          : ''
      }

      ${
        showMount
          ? `<div class="card">
              <div class="card__title">${stepMount}. Тип крепления</div>
              <div class="field">
                <label class="field__label">Куда крепится</label>
                <div class="chips">
                  ${MOUNT_TYPES.map(
                    (m) => `<button class="chip${draftMount.type === m.v ? ' is-active' : ''}" type="button"
                              data-action="pick-mount" data-value="${m.v}">${esc(m.t)}</button>`,
                  ).join('')}
                </div>
              </div>
              <div class="small muted">
                В каталоге Amigo этот параметр есть только у двух моделей Зебры —
                у MINI, UNI, BNT и AMG его нет. Отметка уходит в заявку и письмо,
                чтобы монтажники не гадали.
              </div>
            </div>`
          : ''
      }

      ${
        showElectric
          ? `<div class="card">
              <div class="card__title">${stepElectric}. Электрика</div>
              <div class="field">
                <label class="field__label">Электропривод</label>
                <div class="chips">
                  ${ELECTRIC_MOTORS.map(
                    (m) => `<button class="chip${draftElectric.motor === m.v ? ' is-active' : ''}" type="button"
                              data-action="pick-electric" data-kind="motor" data-value="${m.v}">${esc(m.t)}</button>`,
                  ).join('')}
                </div>
              </div>
              <div class="small muted">
                В каталоге Amigo электропривод заведён только у ZIP, ZIP ROOF и LOCK —
                у MINI, UNI, BNT и остальных его нет. Какой комплект поставить,
                решает офис. Доплату за привод Amigo не считает — она добавится
                отдельно, её сумму меняют в data/electric-kits.json.
              </div>
            </div>`
          : ''
      }

      ${
        selectOptions.length
          ? `<div class="card">
              <div class="card__title">${stepOptions}. Опции</div>
              ${selectOptions
                .map(
                  (option) => `
                <div class="field">
                  <label class="field__label">${esc(option.name)}${option.required ? ' *' : ''}</label>
                  ${
                    option.values.length > 12
                      ? `<select class="input" data-option-select="${esc(option.code)}">
                          <option value="">— выберите —</option>
                          ${option.values
                            .map(
                              (value) => `<option value="${value.id}"${String(chosen(option.code)) === String(value.id) ? ' selected' : ''}>${esc(value.name)}</option>`,
                            )
                            .join('')}
                        </select>`
                      : `<div class="chips">
                          ${option.values
                            .map(
                              (value) => `
                            <button class="chip${String(chosen(option.code)) === String(value.id) ? ' is-active' : ''}"
                                    type="button" data-action="pick-option" data-code="${esc(option.code)}" data-value="${value.id}"
                                    data-value-name="${esc(value.name)}" data-option-name="${esc(option.name)}">
                              ${value.colorHex ? `<span class="chip__dot" style="background:${esc(value.colorHex)}"></span>` : ''}
                              ${esc(value.name)}${option.defaultValue === value.id ? ' <span style="opacity:.6;font-size:11px">по умолчанию</span>' : ''}
                            </button>`,
                            )
                            .join('')}
                        </div>`
                  }
                </div>`,
                )
                .join('')}
            </div>`
          : ''
      }

      ${
        numberOptions.length
          ? `<div class="card">
              <div class="card__title">${stepExtra}. Дополнительно</div>
              ${numberOptions
                .map(
                  (option) => `
                <div class="field">
                  <label class="field__label" for="opt-${esc(option.id)}">${esc(option.name)}</label>
                  <input class="input" id="opt-${esc(option.id)}" type="number" inputmode="numeric"
                         data-option-input="${esc(option.code)}"
                         value="${esc(state.draft.numbers[option.code] ?? '')}">
                </div>`,
                )
                .join('')}
            </div>`
          : ''
      }

      <div class="calc" id="calc-box">
        <div class="calc__row">
          <div>
            <div class="calc__price" id="calc-price">—</div>
            <div class="calc__meta" id="calc-meta">Заполните размеры и выберите ткань</div>
          </div>
        </div>
        <div id="calc-messages"></div>
        <button class="btn" data-action="add-to-cart" type="button" id="btn-add">В заявку</button>
        <button class="btn btn--ghost" data-action="add-to-cart" data-office="1" type="button" id="btn-add-office" hidden>
          Всё равно в заявку — цену посчитает офис
        </button>
      </div>`;

    const drawFabrics = () => {
      const container = $('#fabrics');
      // У моделей без тканей сетки нет вовсе — рисовать нечего
      if (!container) return;
      const query = (state.fabricSearch || '').trim().toLowerCase();
      const filtered = query
        ? materials.filter((m) =>
            [m.name, m.collection, m.colorName].filter(Boolean).join(' ').toLowerCase().includes(query),
          )
        : materials;

      container.innerHTML = filtered.length
        ? filtered
            .slice(0, 400)
            .map(
              (material) => `
          <button class="fabric${String(state.draft.materialId) === String(material.id) ? ' is-active' : ''}"
                  type="button" data-action="pick-material" data-id="${material.id}">
            ${material.swatch ? `<img class="fabric__swatch" src="${esc(material.swatch)}" alt="" loading="lazy">`
                              : '<span class="fabric__swatch"></span>'}
            <span class="fabric__name">${esc(material.name)}</span>
            ${material.colorName ? `<span class="fabric__color">${esc(material.colorName)}</span>` : ''}
          </button>`,
            )
            .join('')
        : '<div class="muted small">Ничего не найдено</div>';
    };
    drawFabrics();

    const search = $('#fabric-search');
    if (search) {
      search.addEventListener('input', (event) => {
        state.fabricSearch = event.target.value;
        drawFabrics();
      });
    }

    $('#size-width').addEventListener('input', (event) => {
      state.draft.sizes.width = event.target.value;
      scheduleCalc();
    });
    $('#size-height').addEventListener('input', (event) => {
      state.draft.sizes.height = event.target.value;
      scheduleCalc();
    });
    $('#qty').addEventListener('input', (event) => {
      state.draft.quantity = Math.max(1, Math.floor(Number(event.target.value) || 1));
      // Количество тоже влияет на сумму — без этого цена осталась бы от одной штуки
      scheduleCalc();
    });

    const scheduleCalc = debounce(() => recalc(model), 450);
    recalc(model);
    chrome(true);
  }

  /** Тело расчёта: ручные числа + выбранные варианты опций.
   *
   * Ключи — не коды опций (ЦветДляОпций), а их id в Amigo. По кодам Amigo
   * расчёт молча игнорирует: платные опции просто не попадали в цену.
   * Например, цвет фурнитуры «Дуб» дороже «Белого» на 5,39 $ — и эта разница
   * терялась.
   */
  function syncOptionsValues() {
    const idПоКоду = {};
    for (const option of state.optionsCache || []) idПоКоду[option.code] = option.id;
    const values = {};
    for (const option of state.draft.options) {
      values[idПоКоду[option.code] ?? option.code] = option.valueId;
    }
    for (const [code, value] of Object.entries(state.draft.numbers || {})) {
      if (value === '' || value === undefined || value === null) continue;
      values[idПоКоду[code] ?? code] = value;
    }
    state.draft.optionsValues = values;
  }

  async function recalc(model) {
    const draft = state.draft;
    const box = $('#calc-box');
    if (!box) return;

    // Кнопка «всё равно в заявку» появляется, когда цену посчитать не вышло:
    // Amigo требует, например, размеры второго изделия в системах Mono.
    // Замерщик не должен остаться без возможности отправить замер.
    const officeBtn = $('#btn-add-office');
    const showOffice = (on) => {
      if (officeBtn) officeBtn.hidden = !on;
    };

    syncOptionsValues();
    const width = Number(draft.sizes.width) || 0;
    const height = Number(draft.sizes.height) || 0;

    if (!draft.materialId || !width || !height) {
      // Ткани у модели нет — цену посчитает офис, но заявку оформить можно
      if (draft.noMaterials) {
        $('#calc-price').textContent = 'цена в офисе';
        $('#calc-meta').textContent =
          width && height
            ? `${width}×${height} мм · ${(width * height / 1e6).toFixed(2)} м²`
            : 'Введите размеры, чтобы оформить заявку';
        $('#calc-messages').innerHTML = '';
        $('#btn-add').disabled = !(width && height);
        showOffice(false);
        return;
      }
      $('#calc-price').textContent = '—';
      $('#calc-meta').textContent = 'Заполните размеры и выберите ткань';
      $('#calc-messages').innerHTML = '';
      $('#btn-add').disabled = true;
      showOffice(false);
      return;
    }

    $('#calc-price').textContent = '…';
    $('#btn-add').disabled = false;

    try {
      const calc = await api('/api/calculate', {
        body: {
          modelId: draft.modelId,
          materialId: draft.materialId,
          sizes: { width, height },
          optionsValues: draft.optionsValues,
          // Электропривод для моделей без этой опции в Amigo — доплату
          // считает сервер, поэтому отметку отправляем вместе с расчётом
          electric: draft.electric,
        },
      });
      state.calc = calc;
      const quantity = Math.max(1, draft.quantity);
      $('#calc-price').textContent = money(calc.priceRub * quantity);
      // Доплата за платные опции (цвет фурнитуры, привод, комплект) —
      // Amigo считает её в total_price, а в price отдаёт базу без неё
      const optionsRub = calc.optionsPriceRub || 0;
      $('#calc-meta').innerHTML =
        `${esc(width)}×${esc(height)} мм · ${esc(calc.area)} м² · ${quantity} ${plural(quantity, 'штука', 'штуки', 'штук')}` +
        (calc.rateInfo?.text
          ? `<br>${esc(sourceMoney(calc.priceUsd * quantity, calc.priceSource))} по курсу ${esc(calc.rateInfo.text)}`
          : '') +
        (optionsRub
          ? `<br>в том числе доп. опции: ${esc(money(optionsRub * quantity))}` +
            (calc.optionsPriceUsd
              ? ` (${esc(sourceMoney(calc.optionsPriceUsd * quantity, calc.priceSource))})`
              : '')
          : '');
      const messages = Array.isArray(calc.messages) ? calc.messages : [];
      state.lastCalcMessages = messages;
      $('#calc-messages').innerHTML = messages
        .map((m) => `<div class="calc__msg${m.type === 'warning' ? ' calc__msg--warn' : ''}">${esc(m.text)}</div>`)
        .join('');
      const hasError = messages.some((m) => m.type === 'error');
      $('#btn-add').disabled = hasError;
      showOffice(hasError);
      if (hasError) {
        $('#calc-price').textContent = 'цена в офисе';
        $('#calc-meta').textContent = 'Amigo не смог посчитать это изделие — отправьте замер без цены';
      }
    } catch (error) {
      $('#calc-price').textContent = '—';
      $('#calc-meta').textContent = error.message;
      $('#btn-add').disabled = true;
      showOffice(false);
    }
  }

  /** Названия выбранных опций: codes → «Цвет фурнитуры: Дуб». */
  const OPTION_NAMES = {
    'ЦветДляОпций': 'Цвет фурнитуры',
    'Управление': 'Управление',
  };

  /**
 * Электропривод и комплект электрики Amigo считает, но в цену изделия не
 * включает: платные опции приходят в `total_price`, а `price` — это база.
 * Поэтому доплату показываем отдельной строкой под ценой.
 */

  /**
   * Режим замера. В каталоге Amigo таких полей нет вообще — ни среди опций,
   * ни среди параметров расчёта. Поэтому это пометка для офиса, а не влияние
   * на цену. Показываем только там, где замерщик реально выбирает: рулонные
   * шторы (в т.ч. MINI и классика), плиссе и гофре.
   */
  const MEASURE_SYSTEMS = /рулонн|плиссе|гофре/i;
  const MEASURE_BY = [
    { v: 'gabarit', t: 'Габарит изделия' },
    { v: 'fabric', t: 'Размер ткани' },
  ];
  const MEASURE_FROM = [
    { v: 'shtapik', t: 'По штапику' },
    { v: 'steklo', t: 'По стеклу' },
  ];
  const MEASURE_BY_TEXT = Object.fromEntries(MEASURE_BY.map((m) => [m.v, m.t]));
  const MEASURE_FROM_TEXT = Object.fromEntries(MEASURE_FROM.map((m) => [m.v, m.t]));

  /** «Габарит изделия · по штапику» — одной строкой в заявку и письмо. */
  function measureText(measure) {
    if (!measure) return '';
    return [MEASURE_BY_TEXT[measure.by], MEASURE_FROM_TEXT[measure.from]].filter(Boolean).join(' · ');
  }

  /**
   * Тип управления. В каталоге он есть только у шторных карнизов (опция
   * `ТипУпр`), а у вертикальных жалюзи — лишь «Левое / Правое». Поэтому для
   * вертикальных это ручная отметка: на цену не влияет, уходит в заявку и письмо.
   * Названия взяты те же, что у Amigo, чтобы офис не путался.
   */
  const CONTROL_SYSTEMS = /вертикальн/i;
  const CONTROL_TYPES = [
    { v: 'k-upravlenie', t: 'К управлению' },
    { v: 'ot-upravleniya', t: 'От управления' },
    { v: 'ot-tsentra', t: 'От центра' },
    { v: 'k-tsentru', t: 'К центру' },
  ];
  const CONTROL_TEXT = Object.fromEntries(CONTROL_TYPES.map((c) => [c.v, c.t]));

  function controlText(control) {
    return CONTROL_TEXT[control?.type] || '';
  }

  /**
   * Тип крепления рулонных штор. В каталоге Amigo он есть только у двух моделей
   * Зебры (опция `ТипУстановкиГИ`), поэтому у MINI, UNI, BNT, AMG его нет вовсе —
   * а монтажнику он нужен каждый день. Значения взяты из Amigo дословно.
   */
  const MOUNT_SYSTEMS = /рулонн|зебра|мираж/i;
  const MOUNT_TYPES = [
    { v: 'na-proem-stena', t: 'На проём / на стену' },
    { v: 'v-proem-potolok', t: 'В проём / на потолок' },
  ];
  const MOUNT_TEXT = Object.fromEntries(MOUNT_TYPES.map((m) => [m.v, m.t]));

  function mountText(mount) {
    return MOUNT_TEXT[mount?.type] || '';
  }

  /**
   * Электропривод и комплект электрики. Проверены все 48 рулонных моделей:
   * в каталоге эти опции есть только у ZIP, ZIP ROOF и LOCK. Остальным 45
   /**
   * Электропривод для рулонных моделей, у которых его нет в каталоге Amigo
   * (MINI, UNI, BNT, AMG, кассеты, Зебра, Мираж). Здесь замерщик только
   * отмечает «нужен привод» — какой именно комплект, решает офис.
   *
   * Доплату Amigo не считает: в расчёте она всегда 0, поэтому сумму
   * прибавляем сами, она задана в data/electric-kits.json.
   */
  const ELECTRIC_SYSTEMS = /рулонн|зебра|мираж/i;
  const ELECTRIC_MOTORS = [
    { v: 'net', t: 'Нет' },
    { v: 'da', t: 'Да' },
  ];
  const ELECTRIC_MOTOR_TEXT = Object.fromEntries(ELECTRIC_MOTORS.map((m) => [m.v, m.t]));

  /** Отметка «электропривод нужен» — одной строкой в заявку и письмо */
  function electricText(electric) {
    if (!electric) return '';
    return ELECTRIC_MOTOR_TEXT[electric.motor] === 'Да' ? 'электропривод' : '';
  }

  /**
   * Единая точка выбора значения опции — и для кнопок, и для выпадающего списка.
   * valueId === null означает «выбор снят».
   */
  function applyOptionChoice({ code, valueId }, optionName, valueName) {
    const draft = state.draft;
    if (!draft) return;

    const at = draft.options.findIndex((o) => o.code === code);
    if (valueId === null || valueId === undefined || Number.isNaN(valueId)) {
      if (at >= 0) draft.options.splice(at, 1);
      const metaAt = draft.optionsMeta.findIndex((o) => o.code === code);
      if (metaAt >= 0) draft.optionsMeta.splice(metaAt, 1);
    } else {
      if (at >= 0) draft.options[at].valueId = valueId;
      else draft.options.push({ code, valueId });

      // Подпись запоминаем сразу: в заявке должно быть видно не только
      // «Цвет фурнитуры», но и выбранное значение
      const name = optionName || code;
      const meta = draft.optionsMeta.find((o) => o.code === code);
      if (meta) {
        meta.name = name;
        meta.value = valueName || '';
      } else {
        draft.optionsMeta.push({ code, name, value: valueName || '' });
      }
    }

    syncOptionsValues();
    recalc({ id: draft.modelId });
  }

  function optionLabels(item) {
    // Сначала пробуем подписи, сохранённые при выборе; иначе строим из кодов
    if (Array.isArray(item.optionsMeta) && item.optionsMeta.length) {
      return item.optionsMeta
        .map((o) => (o.value ? `${OPTION_NAMES[o.code] || o.name || o.code}: ${o.value}` : OPTION_NAMES[o.code] || o.name || o.code))
        .filter(Boolean);
    }
    return (item.options || [])
      .map((option) => {
        if (option.value !== undefined && option.value !== null && option.value !== '') {
          return `${OPTION_NAMES[option.code] || option.name || option.code}: ${option.value}`;
        }
        return OPTION_NAMES[option.code] || option.name || option.code;
      })
      .filter(Boolean);
  }

  /**
 * Итоги заявки. Монтаж вводится руками за позицию и в сумму изделий не
 * входит — прибавляется отдельной строкой, чтобы было видно, из чего собрано.
 */
  function cartTotals() {
    const price = state.cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const install = state.cart.reduce((sum, item) => sum + (Number(item.install) || 0), 0);
    return {
      price,
      install,
      grand: price + install,
      quantity: state.cart.reduce((sum, item) => sum + item.quantity, 0),
    };
  }

  /** Пересчёт строк итога без перерисовки — иначе теряется фокус в поле монтажа. */
  function refreshTotals() {
    const totals = cartTotals();
    const items = $('#total-items');
    const install = $('#total-install');
    const grand = $('#total-grand');
    if (items) items.textContent = money(totals.price);
    if (install) install.textContent = money(totals.install);
    if (grand) grand.textContent = money(totals.grand);
  }

  /**
 * После выбора тканы каталог сворачивается, но размеры всё равно могут оказаться
 * за пределами экрана — показываем их и ставим фокус в поле ширины.
 */
  function scrollToSizes() {
    const card = document.getElementById('card-size');
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Фокус без прокрутки: браузер не должен снова дёрнуть страницу и закрыть
    // поле липкой панелью расчёта
    const width = document.getElementById('size-width');
    if (width) {
      try {
        width.focus({ preventScroll: true });
      } catch {
        width.focus();
      }
    }
  }

  function viewCart() {
    chrome(true);

    const totals = cartTotals();

    view().innerHTML = `
      <div class="card">
        <div class="card__title">Изделия в заявке</div>
        ${
          state.cart.length
            ? state.cart
                .map(
                  (item, index) => `
          <div class="item">
            ${item.swatch ? `<img class="item__swatch" src="${esc(item.swatch)}" alt="">` : '<span class="item__swatch"></span>'}
            <div class="item__body">
              <div class="item__title">${esc(item.systemName)} · ${esc(item.modelName)}${
                item.subModelName ? ` · ${esc(item.subModelName)}` : ''
              }</div>
              ${item.modelCode ? `<div class="item__meta">Артикул ${esc(item.modelCode)}</div>` : ''}
              <div class="item__meta">${esc(item.materialName || (item.noMaterials ? 'ткань не выбрана' : ''))}</div>
              <div class="item__meta">${esc(item.sizes.width)} × ${esc(item.sizes.height)} мм · ${item.quantity} шт.</div>
              ${measureText(item.measure) ? `<div class="item__meta">Замер: ${esc(measureText(item.measure))}</div>` : ''}
              ${controlText(item.control) ? `<div class="item__meta">Открывание: ${esc(controlText(item.control))}</div>` : ''}
              ${mountText(item.mount) ? `<div class="item__meta">Крепление: ${esc(mountText(item.mount))}</div>` : ''}
              ${electricText(item.electric) ? `<div class="item__meta">Электрика: ${esc(electricText(item.electric))}</div>` : ''}
              ${optionLabels(item).length ? `<div class="item__meta">${esc(optionLabels(item).join(', '))}</div>` : ''}
              <div class="install">
                <label class="install__label" for="install-${index}">Монтаж</label>
                <input class="input install__input" id="install-${index}" type="number" inputmode="numeric"
                       min="0" step="100" placeholder="0" data-install-input="${index}"
                       value="${esc(item.install ?? '')}">
                <span class="install__unit">₽</span>
              </div>
              <button class="item__del" type="button" data-action="remove-item" data-index="${index}">Убрать</button>
            </div>
            <div>
            <div class="calc__price">${item.noPrice ? 'цена в офисе' : money(item.price * item.quantity)}</div>
            ${
              item.noPrice
                ? ''
                : item.priceSource
                  ? `<div class="item__meta">${sourceMoney(item.priceSource * item.quantity, item.sourceSymbol)} · ${esc(item.rateText || '')}</div>`
                  : ''
            }
          </div>
          </div>`,
                )
                .join('')
            : '<div class="empty"><div class="empty__icon">🧾</div><div>Заявка пустая</div></div>'
        }
        ${
          state.cart.length
            ? `<div class="total"><span class="muted">Изделия, ${totals.quantity} шт.</span>
                 <span class="total__value" id="total-items">${money(totals.price)}</span></div>
               <div class="total"><span class="muted">Монтаж</span>
                 <span class="total__value" id="total-install">${money(totals.install)}</span></div>
               <div class="total total--grand"><span class="muted">Итого</span>
                 <span class="total__value" id="total-grand">${money(totals.grand)}</span></div>`
            : ''
        }
      </div>

      <div class="card">
        <div class="card__title">Клиент</div>
        <div class="field">
          <label class="field__label" for="c-name">Имя</label>
          <input class="input" id="c-name" type="text" autocomplete="name" placeholder="Иванова Мария" value="${esc(state.client.name || '')}">
        </div>
        <div class="field">
          <label class="field__label" for="c-phone">Телефон</label>
          <input class="input" id="c-phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+7 900 000-00-00" value="${esc(state.client.phone || '')}">
        </div>
        <div class="field">
          <label class="field__label" for="c-address">Адрес</label>
          <input class="input" id="c-address" type="text" autocomplete="street-address" placeholder="Город, улица, дом, кв." value="${esc(state.client.address || '')}">
        </div>
        <div class="field">
          <label class="field__label" for="c-date">Желаемая дата замера/монтажа</label>
          <input class="input" id="c-date" type="date" value="${esc(state.client.desiredDate || '')}">
        </div>

        <label class="check">
          <input type="checkbox" id="c-company" ${state.client.isCompany ? 'checked' : ''}>
          <span>Клиент — юридическое лицо</span>
        </label>
      </div>

      ${
        state.client.isCompany
          ? `<div class="card">
              <div class="card__title">Реквизиты организации</div>
              <input type="file" id="req-input" accept="image/*" capture="environment" hidden>
              ${
                state.requisitesPhoto
                  ? `<div class="photo" style="aspect-ratio:auto;margin-bottom:10px">
                       <img src="${esc(state.requisitesPhoto.dataUrl)}" alt="Реквизиты">
                       <button class="photo__del" type="button" data-action="remove-requisites" aria-label="Убрать">✕</button>
                     </div>
                     <div class="small muted" style="margin-bottom:10px">Фото приложится к заявке и уйдёт вместе с ней на почту.</div>`
                  : '<div class="small muted" style="margin-bottom:10px">Сфотографируйте или загрузите скан реквизитов — документ уйдёт в письме с заявкой.</div>'
              }
              <button class="btn btn--ghost" data-action="add-requisites" type="button">
                ${state.requisitesPhoto ? 'Заменить фото' : 'Приложить реквизиты'}
              </button>
            </div>`
          : ''
      }

      <div class="card">
        <div class="card__title">Фото проёмов</div>
        <input type="file" id="photo-input" accept="image/*" capture="environment" multiple hidden>
        <div class="photos" id="photos">
          ${state.photos
            .map(
              (photo, index) => `
            <div class="photo">
              <img src="${esc(photo.dataUrl)}" alt="">
              <button class="photo__del" type="button" data-action="remove-photo" data-index="${index}">✕</button>
            </div>`,
            )
            .join('')}
          <button class="photo__add" type="button" data-action="add-photo">
            <span style="font-size:22px">📷</span><span>Снять</span>
          </button>
        </div>
        <div class="small muted" style="margin-top:8px">Фото уменьшаются перед отправкой — заявка быстро уходит даже в слабой сети.</div>
      </div>

      <div class="card">
        <div class="card__title">Комментарий</div>
        <textarea class="textarea" id="c-comment" placeholder="Особенности проёма, пожелания клиента, доступ на объект">${esc(state.client.comment || '')}</textarea>
      </div>

      <button class="btn btn--accent" data-action="send-order" type="button" id="btn-send" ${state.cart.length ? '' : 'disabled'}>
        Отправить заявку на почту
      </button>
      <div style="height:8px"></div>
      <button class="btn btn--ghost" data-action="add-more" type="button">+ Добавить ещё изделие</button>
      <div style="height:8px"></div>
      <button class="btn btn--ghost" data-action="clear-cart" type="button">Очистить заявку</button>`;

    ['name', 'phone', 'address', 'desiredDate', 'comment'].forEach((field) => {
      const node = document.getElementById(`c-${field}`);
      if (!node) return;
      node.addEventListener('change', () => {
        state.client[field] = node.value;
        persistClient();
      });
    });

    // Юридическое лицо: появляется блок загрузки реквизитов
    const company = document.getElementById('c-company');
    if (company) {
      company.addEventListener('change', () => {
        state.client.isCompany = company.checked;
        if (!company.checked) state.requisitesPhoto = null;
        persistClient();
        viewCart();
      });
    }

    const requisites = document.getElementById('req-input');
    if (requisites) {
      requisites.addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        try {
          state.requisitesPhoto = { name: file.name || 'requisites.jpg', dataUrl: await shrink(file, 1600, 0.8) };
        } catch (error) {
          toast(`Не удалось прочитать фото: ${error.message}`, 'bad');
        }
        viewCart();
      });
    }

    $('#photo-input').addEventListener('change', async (event) => {
      await addPhotos([...event.target.files]);
      event.target.value = '';
    });
  }

  async function viewHistory() {
    chrome(true);
    loading('Загружаю историю…');

    // Очередь читаем всегда: она лежит на телефоне и доступна без сети
    const pending = await outboxAll();

    let orders = [];
    let offlineError = null;
    try {
      orders = (await api('/api/orders?limit=50')).items;
    } catch (error) {
      offlineError = error.message;
    }

    view().innerHTML = `
      ${
        pending.length
          ? `<div class="card" style="border:1px solid #ffd591;background:#fffaf0">
              <div class="card__title">Ждут отправки</div>
              <div class="small">${pending.length} ${plural(pending.length, 'заявка', 'заявки', 'заявок')} сохранена на телефоне — интернет не был доступен.</div>
              <button class="btn btn--sm" style="margin-top:10px" data-action="flush-outbox" type="button">Отправить сейчас</button>
            </div>`
          : ''
      }
      ${
        offlineError
          ? `<div class="card">
              <div class="card__title">История на сервере</div>
              <div class="small muted">Сервер недоступен: ${esc(offlineError)}. Показываю то, что есть на телефоне.</div>
            </div>`
          : ''
      }
      ${
        orders.length
          ? orders
              .map(
                (order) => `
          <div class="order">
            <div class="order__head">
              <span class="order__id">${esc(order.id)}</span>
              <span class="status status--${esc(order.mail?.status || 'sending')}">${mailStatusLabel(order.mail)}</span>
            </div>
            <div class="order__meta">${esc(fmtDate(order.createdAt))} · ${esc(order.client?.name || 'без имени')} · ${esc(order.client?.phone || '')}</div>
            <div class="order__meta">${order.items.length} ${plural(order.items.length, 'изделие', 'изделия', 'изделий')} · ${esc(order.client?.address || 'адрес не указан')}</div>
            <div class="order__head" style="margin-top:8px">
              <span class="order__sum">${money(order.totals?.totalPrice)}</span>
              ${
                order.mail?.status === 'failed'
                  ? `<button class="btn btn--sm btn--danger" data-action="resend" data-id="${esc(order.id)}" type="button">Отправить письмо снова</button>`
                  : ''
              }
            </div>
            ${order.mail?.error ? `<div class="small" style="color:#b03a3a;margin-top:6px">${esc(order.mail.error)}</div>` : ''}
          </div>`,
              )
              .join('')
          : orders.length === 0 && pending.length === 0
            ? '<div class="empty"><div class="empty__icon">🕘</div><div>Заявок пока нет</div></div>'
            : ''
      }`;
  }

  function mailStatusLabel(mail) {
    switch (mail?.status) {
      case 'sent':
        return 'Отправлено';
      case 'failed':
        return 'Письмо не ушло';
      case 'not_configured':
        return 'Почта не настроена';
      default:
        return 'Отправляется';
    }
  }

  /** Сервер может вернуть адрес строкой или массивом — приводим к списку. */
  const toList = (value) => {
    if (Array.isArray(value)) return value.filter(Boolean);
    if (typeof value === 'string' && value.trim()) return [value.trim()];
    return [];
  };

  /** Карточка замерщика в админке: правка, смена PIN и удаление. */
  function userCard(user) {
    const isSelf = user.id === state.user.id;
    return `
      <div class="user-card" data-user="${esc(user.id)}">
        <div class="user-card__head">
          <div>
            <div class="item__title">${esc(user.name)} ${isSelf ? '<span class="muted small">— это вы</span>' : ''}</div>
            <div class="item__meta">${esc(user.email || 'почта не указана')}</div>
          </div>
          <span class="status ${user.role === 'admin' ? 'status--sending' : 'status--sent'}">
            ${user.role === 'admin' ? 'Администратор' : 'Замерщик'}
          </span>
        </div>

        <div class="field">
          <label class="field__label">Имя и фамилия</label>
          <input class="input" data-field="name" type="text" value="${esc(user.name)}">
        </div>
        <div class="field">
          <label class="field__label">Почта для ответов</label>
          <input class="input" data-field="email" type="email" inputmode="email" placeholder="ivan@company.ru"
                 value="${esc(user.email || '')}">
        </div>
        <div class="field">
          <label class="field__label">Новый PIN (пусто — не менять)</label>
          <input class="input" data-field="pin" type="text" inputmode="numeric" maxlength="8" placeholder="4321">
        </div>
        <div class="field">
          <label class="field__label">Права</label>
          <select class="input" data-field="role">
            <option value="measurer" ${user.role === 'measurer' ? 'selected' : ''}>Замерщик — свои заявки</option>
            <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Администратор — всё</option>
          </select>
        </div>

        <div class="btn-row">
          <button class="btn btn--sm" data-action="save-user" data-id="${esc(user.id)}" type="button">Сохранить</button>
          ${
            isSelf
              ? ''
              : `<button class="btn btn--sm btn--danger" data-action="delete-user" data-id="${esc(user.id)}" data-name="${esc(user.name)}" type="button">Удалить</button>`
          }
        </div>
      </div>`;
  }

  async function viewAdmin() {
    chrome(true);
    if (state.user?.role !== 'admin') {
      return go('account', {}, true);
    }
    loading('Загружаю настройки…');

    let data;
    try {
      data = await api('/api/admin/overview');
    } catch (error) {
      view().innerHTML = `<div class="card"><div class="empty"><div class="empty__icon">⚠️</div><div>${esc(error.message)}</div></div></div>`;
      return;
    }

    view().innerHTML = `
      <div class="card">
        <div class="card__title">Кому приходят заявки</div>
        <div class="field">
          <label class="field__label" for="s-mailto">Адрес получателя</label>
          <input class="input" id="s-mailto" type="email" inputmode="email"
                 placeholder="zamery@company.ru" value="${esc(data.settings.mailTo || '')}">
        </div>
        <div class="field">
          <label class="field__label" for="s-mailfrom">От кого уходит письмо</label>
          <input class="input" id="s-mailfrom" type="text" placeholder="Замеры &lt;zamery@company.ru&gt;"
                 value="${esc(data.settings.mailFrom || '')}">
        </div>
        <div class="field">
          <label class="field__label" for="s-subject">Тема письма</label>
          <input class="input" id="s-subject" type="text" maxlength="60" placeholder="Заявка с замера"
                 value="${esc(data.settings.subjectPrefix || '')}">
        </div>
        <div class="btn-row">
          <button class="btn" data-action="save-settings" type="button" id="btn-save-mail">Сохранить</button>
          <button class="btn btn--ghost" data-action="test-mail" type="button">Проверить</button>
        </div>
        <div class="small muted" style="margin-top:10px">
          ${data.mailConfigured
            ? 'Почта настроена. «Проверить» отправит тестовое письмо на указанный адрес.'
            : 'Почта не настроена: заполните SMTP_HOST, SMTP_USER и SMTP_PASS в файле .env на сервере и перезапустите.'}
        </div>
      </div>

      <div class="card">
        <div class="card__title">Добавить замерщика</div>
        <div class="field">
          <label class="field__label" for="u-name">Имя и фамилия</label>
          <input class="input" id="u-name" type="text" placeholder="Иван Петров" autocomplete="off">
        </div>
        <div class="field">
          <label class="field__label" for="u-email">Почта для ответов</label>
          <input class="input" id="u-email" type="email" inputmode="email" placeholder="ivan@company.ru" autocomplete="off">
        </div>
        <div class="field">
          <label class="field__label" for="u-pin">PIN-код</label>
          <input class="input" id="u-pin" type="text" inputmode="numeric" maxlength="8" placeholder="4321" autocomplete="off">
        </div>
        <button class="btn btn--accent" data-action="add-user" type="button">Добавить</button>
      </div>

      <div class="card">
        <div class="card__title">Замерщики (${data.users.length})</div>
        ${data.users.map((user) => userCard(user)).join('')}
      </div>

      <div class="card">
        <div class="card__title">Как это работает</div>
        <div class="small muted">
          PIN хранится в виде хэша и не читается из файла. Адрес почты применяется сразу после сохранения —
          перезапуск сервера не нужен. Если уволился сотрудник, удалите его здесь: его заявки останутся в истории.
        </div>
      </div>`;

    $('#u-pin').addEventListener('input', (event) => {
      event.target.value = event.target.value.replace(/\D/g, '');
    });
    // PIN в карточках замерщиков
    document.querySelectorAll('.user-card [data-field="pin"]').forEach((node) => {
      node.addEventListener('input', (event) => {
        event.target.value = event.target.value.replace(/\D/g, '');
      });
    });
  }

  async function viewAccount() {
    chrome(true);
    let mailConfigured = true;
    let serverReachable = true;
    let isAdmin = state.user?.role === 'admin';
    let mailTo = [];
    try {
      const me = await api('/api/me');
      state.user = me.user;
      mailConfigured = me.mailConfigured;
      isAdmin = me.isAdmin;
      mailTo = toList(me.mailTo);
    } catch {
      // сервер недоступен — данные о себе берём из того, что сохранили при входе
      serverReachable = false;
    }
    const pendingCount = (await outboxAll()).length;

    view().innerHTML = `
      <div class="card">
        <div class="card__title">Замерщик</div>
        <div style="font-weight:700;font-size:18px">${esc(state.user?.name || '')}</div>
        <div class="muted small">${state.user?.role === 'admin' ? 'Администратор, видит все заявки' : 'Замерщик, видит свои заявки'}</div>
      </div>

      <div class="card">
        <div class="card__title">Мои данные</div>
        <div class="field">
          <label class="field__label" for="p-name">Имя и фамилия</label>
          <input class="input" id="p-name" type="text" value="${esc(state.user?.name || '')}">
        </div>
        <button class="btn" data-action="save-profile" type="button" id="btn-save-profile">Сохранить</button>
      </div>

      <div class="card">
        <div class="card__title">Смена PIN</div>
        <div class="field">
          <label class="field__label" for="p-pin-old">Текущий PIN</label>
          <input class="input" id="p-pin-old" type="password" inputmode="numeric" maxlength="8" placeholder="••••">
        </div>
        <div class="field">
          <label class="field__label" for="p-pin-new">Новый PIN</label>
          <input class="input" id="p-pin-new" type="password" inputmode="numeric" maxlength="8" placeholder="4–8 цифр">
        </div>
        <button class="btn btn--ghost" data-action="change-pin" type="button">Изменить PIN</button>
        <div class="small muted" style="margin-top:8px">После смены PIN нужно будет войти заново.</div>
      </div>

      <div class="card">
        <div class="card__title">Состояние</div>
        <div class="small" style="margin-bottom:6px">
          ${mailConfigured ? '✅ Почта настроена — заявки уходят письмом' : '⚠️ Почта не настроена, заявки только сохраняются'}
        </div>
        <div class="small" style="margin-bottom:6px">${
          !navigator.onLine
            ? '🔴 Нет интернета — заявки сохранятся и уйдут позже'
            : serverReachable
              ? '🟢 Есть связь с сервером'
              : '🟡 Интернет есть, но сервер не отвечает — заявки сохранятся в очередь'
        }</div>
        <div class="small">📥 В очереди: ${pendingCount}</div>
      </div>

      <div class="card">
        <div class="card__title">Приложение</div>
        ${
          isAdmin
            ? `<div class="small muted" style="margin-bottom:12px">
                 Заявки приходят на ${esc((mailTo || []).join(', ') || 'адрес не задан')}
               </div>
               <button class="btn btn--ghost" data-nav="admin" type="button" style="margin-bottom:10px">Администрирование</button>`
            : ''
        }
        <div class="small muted" style="margin-bottom:12px">
          На Android: «Установить приложение» в меню браузера — появится иконка и полноэкранный режим.
          На iPhone: «На экран Домой».
        </div>
        <button class="btn btn--ghost" data-action="logout" type="button">Выйти</button>
      </div>`;

    // PIN вводим цифрами — телефон не даст вставить буквы
    ['p-pin-old', 'p-pin-new'].forEach((id) => {
      const node = document.getElementById(id);
      if (node) {
        node.addEventListener('input', (event) => {
          event.target.value = event.target.value.replace(/\D/g, '');
        });
      }
    });
  }

  // ── Фото ────────────────────────────────────────────────────────────────
  async function shrink(file, maxSide = 1280, quality = 0.72) {
    const bitmap = await createImageBitmap(file).catch(() => null);
    if (!bitmap) throw new Error('Не удалось прочитать фото');
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    return canvas.toDataURL('image/jpeg', quality);
  }

  async function addPhotos(files) {
    for (const file of files.slice(0, 12 - state.photos.length)) {
      try {
        const dataUrl = await shrink(file);
        state.photos.push({ name: file.name || 'photo.jpg', dataUrl });
      } catch (error) {
        toast(`Фото пропущено: ${error.message}`, 'bad');
      }
    }
    viewCart();
  }

  // ── Отправка ────────────────────────────────────────────────────────────
  async function sendOrder() {
    if (state.sending || !state.cart.length) return;
    // Перед отправкой подтягиваем подписи опций — в письме они должны читаться,
    // а не приходить в виде кодов вида «ЦветДляОпций: 715»
    for (const item of state.cart) {
      const labels = optionLabels(item);
      if (labels.length) item.optionsText = labels.join(', ');
    }
    state.sending = true;
    const button = $('#btn-send');
    if (button) {
      button.disabled = true;
      button.textContent = 'Отправляю…';
    }

    const payload = {
      client: state.client,
      items: state.cart.map((item) => ({
        modelId: item.modelId,
        materialId: item.materialId,
        sizes: item.sizes,
        quantity: item.quantity,
        options: item.options || [],
        optionsValues: item.optionsValues || {},
        // На цену не влияет — Amigo таких полей не знает. Нужно офису,
        // чтобы правильно раскроить ткань.
        measure: item.measure || { by: '', from: '' },
        // Тип управления для вертикальных: в каталоге Amigo его нет,
        // офис берёт его из письма.
        control: item.control || { type: '' },
        // Тип крепления для рулонных: в каталоге Amigo его почти нет,
        // монтажник берёт его из письма.
        mount: item.mount || { type: '' },
        // Электропривод и комплект электрики для моделей без них в каталоге
        electric: item.electric || { motor: '', kit: '' },
        // Монтаж в рублях, вручную. В сумму изделий не входит — прибавляется отдельно
        install: Number(item.install) || 0,
        // Amigo не смог посчитать это изделие. Сервер попробует ещё раз,
        // но ошибку не откличёт — посчитает офис.
        allowNoPrice: Boolean(item.noPrice),
      })),
      // Фото проёмов и реквизиты едут одним списком, но помечены:
      // офис должен отличать документ от снимка окна
      photos: [
        ...state.photos.map((photo) => ({ name: photo.name, dataUrl: photo.dataUrl, kind: 'opening' })),
        ...(state.requisitesPhoto
          ? [{ name: state.requisitesPhoto.name, dataUrl: state.requisitesPhoto.dataUrl, kind: 'requisites' }]
          : []),
      ],
    };

    try {
      const result = await api('/api/orders', { body: payload });
      afterSend(result);
    } catch (error) {
      if (error.status === 400) {
        toast(error.message, 'bad');
        state.sending = false;
        if (button) {
          button.disabled = false;
          button.textContent = 'Отправить заявку на почту';
        }
        return;
      }
      // Сети нет или сервер не отвечает — не теряем заявку
      await outboxPut({ id: `out-${Date.now()}`, payload, createdAt: new Date().toISOString() });
      toast('Нет связи. Заявка сохранена на телефоне и уйдёт, как только появится интернет.', 'bad');
      afterSend({ id: 'сохранена на телефоне', offline: true });
    }
  }

  function afterSend(result) {
    state.sending = false;
    state.cart = [];
    state.photos = [];
    state.requisitesPhoto = null;
    state.client = {};
    persistCart();
    persistClient();
    state.stack = [];

    view().innerHTML = `
      <div class="card">
        <div class="empty">
          <div class="empty__icon">${result.offline ? '📥' : result.emailed === false ? '⚠️' : '✅'}</div>
          <div style="font-weight:700;font-size:18px;color:var(--ink)">
            ${result.offline ? 'Заявка сохранена' : result.emailed === false ? 'Заявка сохранена' : 'Заявка отправлена'}
          </div>
          <div style="margin-top:6px">
            ${
              result.offline
                ? 'Как появится интернет, она уйдёт на почту сама.'
                : result.emailed === false
                  ? `Номер <b>${esc(result.id)}</b>. Заявка записана в системе, но письмо отправить не удалось — сообщите об этом в офис.`
                  : `Номер <b>${esc(result.id)}</b>. Письмо пришло на почту компании.`
            }
          </div>
          ${result.error ? `<div class="small" style="color:#b03a3a;margin-top:8px">${esc(result.error)}</div>` : ''}
        </div>
        <button class="btn btn--accent" data-nav="systems" type="button">К следующему замеру</button>
        <div style="height:8px"></div>
        <button class="btn btn--ghost" data-nav="history" type="button">Мои заявки</button>
      </div>`;
    paintBadge();
  }

  async function flushOutbox() {
    const pending = await outboxAll();
    if (!pending.length) return toast('Очередь пуста');
    let sent = 0;
    for (const entry of pending) {
      try {
        await api('/api/orders', { body: entry.payload });
        await outboxDelete(entry.id);
        sent += 1;
      } catch (error) {
        if (error.status === 400) {
          await outboxDelete(entry.id); // такая заявка и так не пройдёт — не копим мусор
        } else {
          break;
        }
      }
    }
    toast(sent ? `Отправлено заявок: ${sent}` : 'Пока не получается отправить', sent ? 'ok' : 'bad');
    if (state.view === 'history') viewHistory();
  }

  // ── Вход ────────────────────────────────────────────────────────────────
  async function doLogin() {
    if (!state.pin) return toast('Введите PIN', 'bad');
    const button = $('#btn-login');
    if (button) {
      button.disabled = true;
      button.textContent = 'Проверяю…';
    }
    try {
      // userId обязателен: так PIN проверяется у выбранного человека,
      // а не у первого, у кого он случайно совпал
      const result = await api('/api/login', {
        body: { pin: state.pin, userId: state.loginUser?.id },
      });
      state.token = result.token;
      state.user = result.user;
      localStorage.setItem('zam.token', result.token);
      state.pin = '';
      state.loginUser = null;
      state.stack = [];
      go('systems');
      toast(`Здравствуйте, ${result.user.name}`, 'ok');
    } catch (error) {
      state.pin = '';
      // Сервер не отвечает — это не «неверный PIN», и такому человеку
      // сообщение об ошибке сети ничего не объяснит
      const offline = error.status === undefined;
      toast(
        offline
          ? 'Нет связи с сервером. Проверьте, что он запущен, и попробуйте ещё раз.'
          : error.message,
        'bad',
      );
      renderLogin();
    }
  }

  function logout(silent) {
    if (!silent && state.token) api('/api/logout', { body: {} }).catch(() => {});
    state.token = '';
    state.user = null;
    state.pin = '';
    state.loginUser = null;
    state.loginUsers = null;
    localStorage.removeItem('zam.token');
    state.stack = [];
    if (!silent) toast('Вы вышли');
    renderLogin();
  }

  // ── Обработка нажатий ───────────────────────────────────────────────────
  document.addEventListener('click', async (event) => {
    const nav = event.target.closest('[data-nav]');
    if (nav) {
      const target = nav.dataset.nav;
      if (target === 'systems') go('systems');
      else if (target === 'cart') go('cart');
      else if (target === 'history') go('history');
      else if (target === 'account') go('account');
      else if (target === 'admin') {
        if (state.user?.role !== 'admin') return toast('Раздел только для администратора', 'bad');
        go('admin');
      }
      return;
    }

    const pinKey = event.target.closest('[data-pin]')?.dataset.pin;
    if (pinKey !== undefined) {
      if (pinKey === 'clear') state.pin = '';
      else if (pinKey === 'back') state.pin = state.pin.slice(0, -1);
      else if (state.pin.length < 8) state.pin += pinKey;
      renderLogin();
      return;
    }

    if (event.target.closest('#btn-login')) {
      doLogin();
      return;
    }

    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;
    const action = trigger.dataset.action;

    if (action === 'reload-catalog') {
      state.catalog = null;
      viewSystems();
      return;
    }
    if (action === 'reload-item') {
      viewItem();
      return;
    }
    if (action === 'open-system') {
      go('models', { systemId: Number(trigger.dataset.id) });
      return;
    }
    if (action === 'open-model') {
      state.draft = null;
      state.fabricSearch = '';
      state.subSearch = '';
      go('item', { systemId: Number(trigger.dataset.system), modelId: Number(trigger.dataset.id) });
      return;
    }
    if (action === 'pick-sub') {
      state.params = { ...state.params, subId: Number(trigger.dataset.id) };
      state.subSearch = '';
      state.draft = null;
      state.itemCache = null;
      await viewItem();
      // После выбора варианта сразу к ткани
      document.getElementById('card-fabric')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (action === 'toggle-fabric') {
      // Каталог на 400+ тканей занимает несколько экранов. Свернули — рядом
      // сразу размеры, развернули — поиск и вся сетка
      const open = state.fabricOpen === false;
      state.fabricOpen = open;
      await viewItem();
      if (open) {
        document.getElementById('card-fabric')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      return;
    }
    if (action === 'pick-material') {
      const id = Number(trigger.dataset.id);
      const material = trigger.querySelector('.fabric__name')?.textContent || '';
      const color = trigger.querySelector('.fabric__color')?.textContent || '';
      const swatch = trigger.querySelector('img')?.src || null;
      state.draft.materialId = id;
      state.draft.materialName = material;
      state.draft.materialColor = color;
      state.draft.swatch = swatch;
      // Каталог сворачивается в строку с выбранной тканью — размеры под рукой
      state.fabricOpen = false;
      state.fabricSearch = '';
      await viewItem();
      scrollToSizes();
      return;
    }
    if (action === 'pick-option') {
      const { code, value } = trigger.dataset;
      const card = trigger.closest('.field');
      if (card) card.querySelectorAll('.chip').forEach((chip) => chip.classList.remove('is-active'));
      trigger.classList.add('is-active');

      applyOptionChoice(
        { code, valueId: Number(value) },
        trigger.dataset.optionName,
        trigger.dataset.valueName,
      );
      return;
    }
    if (action === 'pick-measure') {
      const { kind, value } = trigger.dataset;
      if (!state.draft) return;
      state.draft.measure = state.draft.measure || { by: '', from: '' };
      // Повторное нажатие снимает отметку
      state.draft.measure[kind] = state.draft.measure[kind] === value ? '' : value;
      const field = trigger.closest('.field');
      if (field) field.querySelectorAll('.chip').forEach((chip) => chip.classList.toggle('is-active', chip === trigger));
      return;
    }
    // Электропривод выбирают только как «Нет / Да», комплект выбирать не нужно
    if (action === 'pick-electric') {
      const { value } = trigger.dataset;
      if (!state.draft) return;
      state.draft.electric = { motor: state.draft.electric?.motor === value ? '' : value, kit: '' };
      const field = trigger.closest('.field');
      if (field) field.querySelectorAll('.chip').forEach((chip) => chip.classList.toggle('is-active', chip === trigger));
      return;
    }
    if (action === 'pick-mount') {
      const { value } = trigger.dataset;
      if (!state.draft) return;
      state.draft.mount = state.draft.mount || { type: '' };
      state.draft.mount.type = state.draft.mount.type === value ? '' : value;
      const field = trigger.closest('.field');
      if (field) field.querySelectorAll('.chip').forEach((chip) => chip.classList.toggle('is-active', chip === trigger));
      return;
    }
    if (action === 'pick-control') {
      const { value } = trigger.dataset;
      if (!state.draft) return;
      state.draft.control = state.draft.control || { type: '' };
      // Повторное нажатие снимает отметку
      state.draft.control.type = state.draft.control.type === value ? '' : value;
      const field = trigger.closest('.field');
      if (field) field.querySelectorAll('.chip').forEach((chip) => chip.classList.toggle('is-active', chip === trigger));
      return;
    }
    if (action === 'add-to-cart') {
      const draft = state.draft;
      if (!draft?.materialId && !draft?.noMaterials) return toast('Выберите ткань', 'bad');
      if (!draft.sizes.width || !draft.sizes.height) return toast('Введите размеры', 'bad');
      // Кнопка «всё равно в заявку»: Amigo не смог посчитать, цену посчитает офис
      const withoutPrice = trigger.dataset.office === '1' || Boolean(draft.noMaterials);
      const calc = withoutPrice ? null : state.calc;
      syncOptionsValues();
      state.cart.push({
        ...draft,
        sizes: { width: Number(draft.sizes.width), height: Number(draft.sizes.height) },
        quantity: Math.max(1, Number(draft.quantity) || 1),
        price: calc?.priceRub || 0,
        priceSource: calc?.priceUsd || 0,
        sourceSymbol: calc?.priceSource || '$',
        rateText: calc?.rateInfo?.text || '',
        noPrice: withoutPrice,
        area: calc?.area || Math.round((draft.sizes.width * draft.sizes.height) / 1e6 * 100) / 100,
      });
      persistCart();
      toast(withoutPrice ? 'Добавлено в заявку, цену посчитает офис' : 'Добавлено в заявку', 'ok');
      go('cart');
      return;
    }
    if (action === 'remove-item') {
      const ok = await confirmBox('Убрать изделие?', 'Оно исчезнет из заявки.', 'Убрать');
      if (!ok) return;
      state.cart.splice(Number(trigger.dataset.index), 1);
      persistCart();
      viewCart();
      return;
    }
    if (action === 'add-more') {
      state.draft = null;
      go('systems');
      return;
    }
    if (action === 'clear-cart') {
      const ok = await confirmBox('Очистить заявку?', 'Все изделия будут удалены.', 'Очистить');
      if (!ok) return;
      state.cart = [];
      state.photos = [];
      persistCart();
      viewCart();
      return;
    }
    if (action === 'add-photo') {
      $('#photo-input')?.click();
      return;
    }
    if (action === 'add-requisites') {
      $('#req-input')?.click();
      return;
    }
    if (action === 'remove-requisites') {
      state.requisitesPhoto = null;
      viewCart();
      return;
    }
    if (action === 'remove-photo') {
      state.photos.splice(Number(trigger.dataset.index), 1);
      viewCart();
      return;
    }
    if (action === 'send-order') {
      sendOrder();
      return;
    }
    if (action === 'resend') {
      try {
        await api(`/api/orders/${encodeURIComponent(trigger.dataset.id)}/resend`, { body: {} });
        toast('Письмо отправлено', 'ok');
      } catch (error) {
        toast(error.message, 'bad');
      }
      viewHistory();
      return;
    }
    if (action === 'flush-outbox') {
      flushOutbox();
      return;
    }
    if (action === 'save-profile') {
      const button = $('#btn-save-profile');
      button.disabled = true;
      button.textContent = 'Сохраняю…';
      try {
        const result = await api('/api/profile', {
          method: 'PATCH',
          // Почту замерщик больше не редактирует — её задаёт администратор
          body: { name: $('#p-name').value },
        });
        state.user = result.user;
        toast('Данные сохранены', 'ok');
        viewAccount();
      } catch (error) {
        toast(error.message, 'bad');
        button.disabled = false;
        button.textContent = 'Сохранить';
      }
      return;
    }
    if (action === 'change-pin') {
      const currentPin = $('#p-pin-old').value;
      const newPin = $('#p-pin-new').value;
      if (!currentPin || !newPin) return toast('Заполните оба PIN', 'bad');
      try {
        await api('/api/profile/pin', { body: { currentPin, newPin } });
        // Сервер завершил сессию — возвращаем на вход с новым PIN
        state.token = '';
        state.user = null;
        localStorage.removeItem('zam.token');
        renderLogin();
        toast('PIN изменён. Войдите с новым PIN.', 'ok');
      } catch (error) {
        toast(error.message, 'bad');
      }
      return;
    }
    if (action === 'save-user') {
      const card = trigger.closest('.user-card');
      if (!card) return;
      const value = (field) => card.querySelector(`[data-field="${field}"]`)?.value ?? '';
      try {
        await api(`/api/admin/users/${encodeURIComponent(trigger.dataset.id)}`, {
          method: 'PATCH',
          body: { name: value('name'), email: value('email'), pin: value('pin'), role: value('role') },
        });
        toast('Сохранено', 'ok');
        viewAdmin();
      } catch (error) {
        toast(error.message, 'bad');
      }
      return;
    }
    if (action === 'save-settings') {
      const button = $('#btn-save-mail');
      button.disabled = true;
      button.textContent = 'Сохраняю…';
      try {
        const result = await api('/api/admin/settings', {
          method: 'PUT',
          body: {
            mailTo: $('#s-mailto').value,
            mailFrom: $('#s-mailfrom').value,
            subjectPrefix: $('#s-subject').value,
          },
        });
        toast(`Заявки теперь приходят на ${toList(result.mailTo).join(', ') || '—'}`, 'ok');
        state.mailTo = toList(result.mailTo);
        viewAdmin();
      } catch (error) {
        toast(error.message, 'bad');
        button.disabled = false;
        button.textContent = 'Сохранить';
      }
      return;
    }
    if (action === 'test-mail') {
      toast('Отправляю тестовое письмо…');
      try {
        const result = await api('/api/admin/test-mail', { body: {} });
        toast(`Письмо отправлено на ${toList(result.to).join(', ') || '—'}. Проверьте входящие.`, 'ok');
      } catch (error) {
        toast(error.message, 'bad');
      }
      return;
    }
    if (action === 'add-user') {
      const name = $('#u-name').value.trim();
      const pin = $('#u-pin').value.trim();
      const email = $('#u-email').value.trim();
      if (!name || !pin) return toast('Заполните имя и PIN', 'bad');
      try {
        const result = await api('/api/admin/users', { body: { name, pin, email } });
        toast(`Добавлен: ${result.user.name}`, 'ok');
        viewAdmin();
      } catch (error) {
        toast(error.message, 'bad');
      }
      return;
    }
    if (action === 'delete-user') {
      const ok = await confirmBox(
        `Удалить ${trigger.dataset.name}?`,
        'Сотрудник не сможет войти в приложение. Его прошлые заявки останутся в истории.',
        'Удалить',
      );
      if (!ok) return;
      try {
        await api(`/api/admin/users/${encodeURIComponent(trigger.dataset.id)}`, { method: 'DELETE' });
        toast('Замерщик удалён', 'ok');
        viewAdmin();
      } catch (error) {
        toast(error.message, 'bad');
      }
      return;
    }
    if (action === 'pick-login-user') {
      const user = (state.loginUsers || []).find((u) => u.id === trigger.dataset.id);
      if (!user) return;
      state.loginUser = user;
      state.pin = '';
      renderLogin();
      return;
    }
    if (action === 'change-login-user') {
      state.loginUser = null;
      state.pin = '';
      renderLogin();
      return;
    }
    if (action === 'reload-login-users') {
      state.loginUsers = null;
      renderLogin();
      return;
    }
    if (action === 'logout') {
      logout();
    }
  });

  document.addEventListener('input', (event) => {
    const code = event.target.dataset?.optionInput;
    if (code && state.draft) state.draft.numbers[code] = event.target.value;

    const installIndex = event.target.dataset?.installInput;
    if (installIndex !== undefined && state.cart[installIndex]) {
      const raw = event.target.value;
      state.cart[installIndex].install = raw === '' ? 0 : Math.max(0, Number(raw) || 0);
      persistCart();
      refreshTotals();
    }
  });

  // Длинные списки (вторая ткань, комплект электрики — по 400+ позиций)
  // показываем выпадающим списком, а не стеной кнопок
  document.addEventListener('change', (event) => {
    const code = event.target.dataset?.optionSelect;
    if (!code || !state.draft) return;
    const select = event.target;
    const option = (state.optionsCache || []).find((o) => o.code === code);
    const value = (option?.values || []).find((v) => String(v.id) === select.value);
    applyOptionChoice({ code, valueId: select.value ? Number(select.value) : null }, option?.name, value?.name);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && state.view === 'login' && state.pin) doLogin();
  });

  $('#btn-back').addEventListener('click', back);

  window.addEventListener('online', () => {
    toast('Интернет появился', 'ok');
    flushOutbox();
  });

  // ── Старт ───────────────────────────────────────────────────────────────
  async function start() {
    if (state.token) {
      try {
        const me = await api('/api/me');
        state.user = me.user;
        go('systems', {}, true);
        return;
      } catch {
        state.token = '';
        localStorage.removeItem('zam.token');
      }
    }
    renderLogin();
  }

  render();
  start();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
})();