# Доступность (Lighthouse 0.55 → цель 0.90+)

Доступность — не только требование WCAG, но и фактор ранжирования:
Google оценивает mobile-friendly и удобство, а Яндекс учитывает поведенческие
метрики. Плюс это обязательное требование по ФЗ-152 и доступности для
маломобильных групп населения.

Lighthouse выявил **9 типов ошибок** на главной странице.

---

## 1. `<html>` без `lang` — 41/41 страница

**Причина:** не задан атрибут.
**Эффект:** скринридер озвучивает русский текст с интонацией текущего языка
системы; часть поисковых систем не может определить язык страницы.

```html
<!-- как есть -->
<html>

<!-- нужно -->
<html lang="ru-RU">
```

Или динамически (если платформа не даёт править `<html>`):

```js
document.documentElement.setAttribute('lang', 'ru-RU');
```

Готово в `fixes/head-page-template.html`.

---

## 2. `meta-viewport` — запрещён масштаб

**Причина:** `user-scalable=1.0, maximum-scale=1.0` в viewport.

```html
<!-- как есть -->
<meta name="viewport" content="width=device-width,user-scalable=1.0,initial-scale=1.0,maximum-scale=1.0"/>

<!-- нужно -->
<meta name="viewport" content="width=device-width, initial-scale=1.0">
```

Пользователи с нарушениями зрения не могут увеличить текст.
Lighthouse: `meta-viewport` FAIL.

---

## 3. Кнопки без доступного имени

7 кнопок-заглушек не имеют ни текста, ни `aria-label`:

```html
<!-- как есть -->
<a class="wind-close"></a>
<a class="wind-btn-apply w10 no_sel">OK</a>

<!-- нужно -->
<a class="wind-close" role="button" aria-label="Закрыть" tabindex="0"></a>
<a class="wind-btn-apply" role="button" aria-label="Подтвердить">OK</a>
```

Затронуты классы: `.wind-close` (×6 на главной), `.wind-btn-apply`,
`.product-popup__back-link`, `.wind-header__mobile-text`.

---

## 4. Ссылки без распознаваемого имени — 14 элементов

Иконки соцсетей с пустым `alt` внутри кликабельных ссылок:

```html
<!-- как есть -->
<a class="social-media__item" href="https://vk.com/prozhaluzi63">
  <div class="social-media__logo"></div>
</a>

<!-- нужно -->
<a class="social-media__item" href="https://vk.com/prozhaluzi63"
   aria-label="PRO Жалюзи во ВКонтакте"
   title="PRO Жалюзи во ВКонтакте"
   rel="nofollow noopener">
  <div class="social-media__logo"></div>
</a>
```

Аналогично для Telegram, RUTUBE, MAX, Авито и логотипа Яндекс.Карт
(`<a class="ymaps-2-1-79-copyright__logo" href="" target="_blank">`).

---

## 5. `<iframe>` без `title` — 9 элементов

```html
<!-- как есть -->
<iframe src="https://smartcaptcha.yandexcloud.net/..."></iframe>

<!-- нужно -->
<iframe src="https://smartcaptcha.yandexcloud.net/..."
        title="Проверка на робота при отправке формы"
        loading="lazy"></iframe>
```

---

## 6. Недостаточный контраст текста

Найдены элементы с `opacity: 0.06` и полупрозрачные подписи:

```css
/* причина — в сгенерированных стилях блоков */
#da211e20b8ce4adf820fb1608b6c955c .ms-shape { opacity: 0.06; }
```

WCAG AA требует контраста **4.5:1** для обычного текста и **3:1** для крупного
(≥18px или ≥14px жирный).

Проверить конкретные элементы:

```js
// вставить в консоль браузера на главной
Array.from(document.querySelectorAll('body *'))
  .filter(e => e.children.length === 0 && e.textContent.trim().length > 3)
  .slice(0, 300)
  .forEach(e => {
    const cs = getComputedStyle(e);
    console.log(cs.color, '|', cs.fontSize, '|', e.textContent.trim().slice(0, 40));
  });
```

Типовые правки:
- подписи с `rgba(255,255,255,0.5)` → `rgba(255,255,255,0.75)`
- `opacity: 0.06` на текстовых блоках → `opacity: 1` с явным цветом
- `#999` на белом → `#595959`

---

## 7. Ссылки, различимые только цветом

Ссылки внутри текстовых блоков выделены исключительно цветом без подчёркивания.

```html
<!-- как есть -->
<p>Замер делает <a href="/kaksdelatzamer">мастер</a>.</p>

<!-- нужно — визуальное отличие не только цветом -->
<style>
.blk_section_inner a {
  text-decoration: underline;
  text-underline-offset: 2px;
}
</style>
```

Или добавьте `border-bottom: 1px solid currentColor`.

---

## 8. `<select>` без связанного `<label>`

```html
<!-- как есть -->
<select name="city"><option>Самара</option></select>

<!-- нужно -->
<label for="city-select">Ваш город</label>
<select id="city-select" name="city">
  <option>Самара</option>
</select>
```

Либо, если поле визуально скрыто:

```html
<select name="city" aria-label="Ваш город">...</select>
```

---

## 9. Ссылки, которые нельзя обойти (crawlable-anchors)

```html
<a class="ymaps-2-1-79-copyright__logo" href="" target="_blank"></a>  <!-- пустой href -->
```

Пустой `href` = ссылка «в никуда». Поисковик не может её перейти.

**Варианты:**
- задать реальный адрес Яндекс.Карт
- заменить на `<span>` (кнопка не нужна)
- добавить `aria-hidden="true"` если это декоративный логотип

---

## Бонус: добавить lang и фокус

```html
<!-- Пропуск по блокам (skip link) — первым элементом в body -->
<a href="#main" class="skip-link">Перейти к содержанию</a>

<style>
.skip-link {
  position: absolute; left: -9999px;
  background: #fff; color: #000; padding: 12px 20px; z-index: 999;
}
.skip-link:focus { left: 0; top: 0; }
</style>
```

```css
/* Видимый фокус — сейчас, вероятно, отсутствует */
:focus-visible {
  outline: 3px solid #237ced;
  outline-offset: 2px;
}
```

---

## Порядок

| # | Правка | Сложность | Влияние |
|---|---|---|---|
| 1 | `lang` на `<html>` | 1 строка | нарастает со всех страниц |
| 2 | viewport без `maximum-scale` | 1 строка | мобильный UX |
| 3 | `aria-label` на иконки соцсетей | 15 мин | снимает 2 ошибки |
| 4 | `role="button"` на заглушках | 10 мин | снимает 1 ошибку |
| 5 | `title` на 9 iframe | 10 мин | снимает 1 ошибку |
| 6 | `label` на select | 15 мин | снимает 1 ошибку |
| 7 | Подчёркивание ссылок | 30 мин | снимает 1 ошибку |
| 8 | Контраст | 1–2 ч | снимает 1 ошибку, влияет на всех |

Пункты 1–7 суммарно ~1.5 часа работы и закрывают **6 из 9** ошибок.
После этого Lighthouse Accessibility поднимется примерно до 0.80,
после правки контраста — до 0.90+.