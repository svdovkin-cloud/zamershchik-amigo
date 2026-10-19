# Макет бэкенда для локальной проверки фронтенда БЕЗ Node.
# Отдаёт статику и проксирует каталог и расчёт в настоящий Amigo Customizer.
# Заявки по почте здесь НЕ отправляются — только проверка интерфейса.
#   powershell -ExecutionPolicy Bypass -File tools\mock-backend.ps1 -Port 8787
param(
  [int]$Port = 8787,
  [string]$Bind = '127.0.0.1',
  [string]$Amigo = 'https://1c87433dfbfcece8e76a55b998f72ec9.customizer.amigo.ru'
)

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\public'))

$MIME = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'application/javascript; charset=utf-8'
  '.mjs' = 'application/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'; '.webmanifest' = 'application/manifest+json; charset=utf-8'
  '.png' = 'image/png'; '.svg' = 'image/svg+xml'
}

$script:usdRate = $null
$script:mockOrders = @()
$script:mailTo = 'zamery@company.ru'
# Доплата за электропривод: Amigo её не считает, сумма задаётся в файле
$script:motorSurchargeRub = 5000.0
try {
  $kits = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot '..\data\electric-kits.json') | ConvertFrom-Json
  if ($null -ne $kits.motorSurchargeRub) { $script:motorSurchargeRub = [double]$kits.motorSurchargeRub }
} catch { }
# Макет не умеет отправлять письма — честно говорим об этом, а не притворяемся
$script:mailConfigured = $false
$script:mockPins = @{ u1 = '1234'; u2 = '2222'; u3 = '3333' }
$script:mockToken = ''   # кто сейчас вошёл
$script:mockUsers = @(
  [pscustomobject]@{ id = 'u1'; name = 'Иван Петров'; email = 'ivan@company.ru'; role = 'admin'; createdAt = '' }
  [pscustomobject]@{ id = 'u2'; name = 'Сергей Кузнецов'; email = ''; role = 'measurer'; createdAt = '' }
  [pscustomobject]@{ id = 'u3'; name = 'Анна Соколова'; email = 'anna@company.ru'; role = 'measurer'; createdAt = '' }
)

# ── Профиль замерщика ──────────────────────────────────────────────────────
function Get-Me($context) {
  $script:mockUsers | Where-Object { $_.id -eq 'u1' } | Select-Object -First 1
}

function Send-Json($context, $status, $object) {
  $json = $object | ConvertTo-Json -Depth 12 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $context.Response.StatusCode = $status
  $context.Response.ContentType = 'application/json; charset=utf-8'
  $context.Response.ContentLength64 = $bytes.Length
  $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $context.Response.Close()
}

function Invoke-Amigo($path, $body) {
  $params = @{ Uri = "$Amigo$path"; Headers = @{ Accept = 'application/json' }; TimeoutSec = 30; UseBasicParsing = $true }
  if ($null -ne $body) {
    $params.Method = 'POST'
    $params.ContentType = 'application/json; charset=utf-8'
    $params.Body = [System.Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 12 -Compress))
  }
  try {
    $response = Invoke-WebRequest @params
    # PowerShell 5 угадывает кодировку по ANSI — читаем UTF-8 вручную
    return ([System.Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray())) | ConvertFrom-Json
  } catch {
    Write-Host "  ! Amigo $path : $($_.Exception.Message)"
    throw
  }
}

# Курс ЦБ РФ. Прайс Amigo в долларах — на экране показываем рубли.
function Get-UsdRate {
  if ($script:usdRate) { return $script:usdRate }
  try {
    $r = Invoke-WebRequest 'https://www.cbr-xml-daily.ru/daily_json.js' -UseBasicParsing -TimeoutSec 20
    $j = ([System.Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())) | ConvertFrom-Json
    $rate = [double]$j.Valute.USD.Value / [double]$j.Valute.USD.Nominal
    if (-not $rate -or $rate -le 0) { throw 'пустой курс' }
    $script:usdRate = [pscustomobject]@{ Rate = $rate; Date = ([string]$j.Date).Substring(0, 10) }
  } catch {
    Write-Host "  ! ЦБ РФ недоступен, запасной курс: $($_.Exception.Message)"
    $script:usdRate = [pscustomobject]@{ Rate = 83.9153; Date = 'запасной' }
  }
  return $script:usdRate
}

function Get-Query($context) {
  $result = @{}
  $queryString = $context.Request.Url.Query.TrimStart('?')
  if ($queryString) {
    foreach ($pair in $queryString -split '&') {
      $kv = $pair -split '=', 2
      $result[[System.Uri]::UnescapeDataString($kv[0])] =
        $(if ($kv.Count -gt 1) { [System.Uri]::UnescapeDataString($kv[1]) } else { '' })
    }
  }
  return $result
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://${Bind}:$Port/")
$listener.Start()
Write-Host "Макет бэкенда: http://${Bind}:$Port/  ->  $Amigo"
Write-Host "Статика из: $root"

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $path = $context.Request.Url.AbsolutePath
    $method = $context.Request.HttpMethod
    $query = Get-Query $context

    $raw = ''
    if ($method -in @('POST', 'PUT', 'PATCH', 'DELETE')) {
      $reader = New-Object System.IO.StreamReader($context.Request.InputStream, [System.Text.Encoding]::UTF8)
      $raw = $reader.ReadToEnd()
      $reader.Close()
    }

    try {
      # ── Вход ────────────────────────────────────────────────────────────
      if ($path -eq '/api/login/users') {
        Send-Json $context 200 @{ users = @($script:mockUsers | ForEach-Object {
          [pscustomobject]@{ id = $_.id; name = $_.name; role = $_.role }
        }) }
        continue
      }
      if ($path -eq '/api/login') {
        $pin = ''
        $userId = ''
        if ($raw) { $body = $raw | ConvertFrom-Json; $pin = $body.pin; $userId = $body.userId }
        $u = $script:mockUsers | Where-Object { $_.id -eq $userId } | Select-Object -First 1
        # PIN проверяется у выбранного человека
        if ($u -and $pin -eq $script:mockPins[$u.id]) {
          # У каждого свой токен — иначе все видели бы одного и того же человека
          $script:mockToken = $u.id
          Send-Json $context 200 @{ token = 'test-token'; user = @{ id = $u.id; name = $u.name; email = $u.email; role = $u.role } }
        } else {
          Send-Json $context 401 @{ error = 'Неверный PIN' }
        }
        continue
      }

      if ($path -like '/api/*') {
        $auth = $context.Request.Headers['Authorization']
        if ($auth -ne 'Bearer test-token') { Send-Json $context 401 @{ error = 'Нужен вход' }; continue }

        if ($path -eq '/api/me') {
          $me = $script:mockUsers | Where-Object { $_.id -eq $script:mockToken } | Select-Object -First 1
          if (-not $me) { Send-Json $context 401 @{ error = 'Нужен вход' }; continue }
          Send-Json $context 200 @{
            user = $me
            mailConfigured = $script:mailConfigured
            isAdmin = ($me.role -eq 'admin')
            mailTo = @($script:mailTo)
          }
          continue
        }

        # ── Профиль ────────────────────────────────────────────────────────
        if ($path -eq '/api/profile' -and $method -eq 'PATCH') {
          $in = $raw | ConvertFrom-Json
          $me = $script:mockUsers | Where-Object { $_.id -eq $script:mockToken } | Select-Object -First 1
          if ($in.name) { $me.name = $in.name }
          $me.email = [string]$in.email
          Send-Json $context 200 @{ user = $me }
          continue
        }
        if ($path -eq '/api/profile/pin' -and $method -eq 'POST') {
          $in = $raw | ConvertFrom-Json
          $me = $script:mockUsers | Where-Object { $_.id -eq $script:mockToken } | Select-Object -First 1
          if ($in.currentPin -ne $script:mockPins[$me.id]) { Send-Json $context 400 @{ error = 'Текущий PIN указан неверно' }; continue }
          $script:mockPins[$me.id] = [string]$in.newPin
          $script:mockToken = ''   # настоящий сервер закрывает сессию после смены PIN
          Send-Json $context 200 @{ ok = $true; user = $me }
          continue
        }

        # ── Администрирование ───────────────────────────────────────────────
        if ($path -eq '/api/admin/overview') {
          Send-Json $context 200 @{
            users = @($script:mockUsers)
            settings = [pscustomobject]@{
              mailTo = $script:mailTo; mailFrom = 'Замеры <zamery@company.ru>'; subjectPrefix = 'Заявка с замера'
            }
            mailConfigured = $script:mailConfigured
            mailTo = @($script:mailTo)
          }
          continue
        }
        if ($path -eq '/api/admin/settings' -and $method -eq 'PUT') {
          $in = $raw | ConvertFrom-Json
          if ($in.mailTo) { $script:mailTo = $in.mailTo }
          Send-Json $context 200 @{ settings = $in; mailTo = @($script:mailTo) }
          continue
        }
        if ($path -eq '/api/admin/test-mail' -and $method -eq 'POST') {
          Send-Json $context 200 @{ ok = $true; to = @($script:mailTo) }
          continue
        }
        if ($path -eq '/api/admin/users' -and $method -eq 'POST') {
          $in = $raw | ConvertFrom-Json
          if ($script:mockUsers | Where-Object { $_.name -eq $in.name }) {
            Send-Json $context 400 @{ error = "Пользователь «$($in.name)» уже есть" }
            continue
          }
          $new = [pscustomobject]@{
            id = 'u' + (Get-Random -Minimum 100 -Maximum 9999)
            name = $in.name
            email = [string]$in.email
            role = 'measurer'
            createdAt = (Get-Date).ToString('o')
          }
          # Настоящий сервер пишет замерщика в data/users.json — здесь то же самое в памяти
          $script:mockUsers = @($script:mockUsers) + $new
          $script:mockPins[$new.id] = [string]$in.pin
          Send-Json $context 201 @{ user = $new }
          continue
        }
        if ($path -like '/api/admin/users/*' -and $method -eq 'DELETE') {
          $id = $path.Split('/')[-1]
          if ($id -eq 'u1') { Send-Json $context 400 @{ error = 'Нельзя удалить самого себя' }; continue }
          $script:mockUsers = @($script:mockUsers | Where-Object { $_.id -ne $id })
          Send-Json $context 200 @{ ok = $true }
          continue
        }
        if ($path -like '/api/admin/users/*' -and $method -eq 'PATCH') {
          $id = $path.Split('/')[-1]
          $in = $raw | ConvertFrom-Json
          $u = $script:mockUsers | Where-Object { $_.id -eq $id } | Select-Object -First 1
          if (-not $u) { Send-Json $context 404 @{ error = 'Замерщик не найден' }; continue }
          if ($in.name) { $u.name = $in.name }
          if ($null -ne $in.email) { $u.email = [string]$in.email }
          if ($in.role) { $u.role = $in.role }
          Send-Json $context 200 @{ user = $u }
          continue
        }

        if ($path -eq '/api/catalog') {
          $models = Invoke-Amigo '/api/models'
          $result = foreach ($system in $models) {
            [pscustomobject]@{
              id = [int]$system.id
              name = $system.name
              vendorCode = $system.vendor_code
              image = $(if ($system.image) { "$Amigo$($system.image)" } else { $null })
              models = @($system.models | ForEach-Object {
                # Двухуровневые модели (плиссе, гофре) несут варианты:
                # у семейства «Модели MIDI» их 81, и ткани живут у варианта
                $model = $_
                [pscustomobject]@{
                  id = [int]$model.id; name = $model.name; code1c = $model.code_1c
                  image = $null; priceType = $model.price_type
                  subModels = @($model.sub_models | ForEach-Object {
                    [pscustomobject]@{
                      id = [int]$_.id; name = $_.name; code1c = $_.code_1c
                      description = $_.description
                      image = $(if ($_.image_scheme) { "$Amigo$($_.image_scheme)" } else { $null })
                    }
                  })
                }
              })
            }
          }
          Send-Json $context 200 @{ systems = @($result) }
          continue
        }

        if ($path -eq '/api/catalog/materials') {
          $rows = Invoke-Amigo "/api/models/$($query['model'])/materials"
          $items = foreach ($row in $rows) {
            $m = if ($row.material) { $row.material } else { $row }
            [pscustomobject]@{
              id = [int]$m.id; name = $m.name; vendorCode = $m.vendor_code
              collection = $(if ($m.material_collection) { $m.material_collection.name } else { $null })
              priceCategory = $m.price_category_name; availability = $m.availability; minPrice = $m.min_price
              colorName = $(if ($m.color) { $m.color.name } else { $null })
              colorHex = $(if ($m.color) { $m.color.rgb_code } else { $null })
              swatch = $(if ($m.preview) { "$Amigo$($m.preview)" } elseif ($m.image) { "$Amigo$($m.image)" } else { $null })
              thumb = $(if ($m.image) { "$Amigo$($m.image)" } else { $null })
            }
          }
          Send-Json $context 200 @{ items = @($items) }
          continue
        }

        if ($path -eq '/api/catalog/options') {
          $rows = Invoke-Amigo "/api/models/$($query['model'])/options"
          $items = foreach ($o in $rows) {
            [pscustomobject]@{
              id = [int]$o.id; name = $o.name; code = $(if ($o.code_1c) { $o.code_1c } else { [string]$o.id })
              type = $o.type; fieldType = $o.field_type; required = [bool]$o.is_required
              auto = (@($o.options_values).Count -eq 0)
              defaultValue = $o.option_default
              values = @($o.options_values | ForEach-Object {
                [pscustomobject]@{ id = [int]$_.id; name = $_.name; value = $_.value
                  colorHex = $(if ($_.color) { $_.color.rgb_code } else { $null })
                  swatch = $(if ($_.image) { "$Amigo$($_.image)" } else { $null }); isDefault = [bool]$_.is_default }
              })
            }
          }
          Send-Json $context 200 @{ items = @($items) }
          continue
        }

        if ($path -eq '/api/calculate') {
          $in = $raw | ConvertFrom-Json
          $payload = @{
            uuid = ''
            model_id = [int]$in.modelId
            material_id = [int]$in.materialId
            sizes = @{ width = [double]$in.sizes.width; height = [double]$in.sizes.height }
            options_values = $in.optionsValues
          }
          $d = Invoke-Amigo '/api/calculate' $payload
          $rate = Get-UsdRate
          # Доплата за электропривод: Amigo её не считает, сумму задаём сами
          $сурчарж = 0.0
          if ($in.electric.motor -eq 'da') { $сурчарж = $script:motorSurchargeRub }
          $baseUsd = [double]$d.total_price
          $priceUsd = [Math]::Round($baseUsd + ($сурчарж / $rate.Rate), 4)
          $messages = @()
          if ($d.messages) {
            foreach ($m in $d.messages) { $messages += [pscustomobject]@{ type = $m.type; text = $m.text } }
          }
          Send-Json $context 200 @{
            # total_price — полная сумма вместе с платными опциями;
            # price — база без доплаты за цвет фурнитуры, привод, комплект
            priceRub = [Math]::Round([double]$d.total_price * $rate.Rate, 2)
            priceUsd = $priceUsd
            optionsPriceRub = [Math]::Round([double]$d.options_price * $rate.Rate + $сурчарж, 2)
            optionsPriceUsd = [Math]::Round([double]$d.options_price + ($сурчарж / $rate.Rate), 4)
            motorSurchargeRub = $сурчарж
            priceSource = '$'
            currency = '₽'
            rate = $rate.Rate
            area = [double]$d.area
            rateInfo = @{
              rate = $rate.Rate; date = $rate.Date; source = 'ЦБ РФ'; from = 'USD'; to = 'RUB'
              fromSymbol = '$'; toSymbol = '₽'
              text = ("{0} ₽ за 1 $ · ЦБ РФ, {1}" -f $rate.Rate, $rate.Date)
            }
            messages = $messages
          }
          continue
        }

        if ($path -eq '/api/orders' -and $method -eq 'POST') {
          $in = $raw | ConvertFrom-Json
          $rate = Get-UsdRate
          $items = @(@($in.items) | ForEach-Object {
            $qty = [int]$_.quantity
            if ($qty -lt 1) { $qty = 1 }
            $usd = 36.02
            $rub = [Math]::Round($usd * $rate.Rate, 2)
            [pscustomobject]@{
              systemName = 'Рулонные шторы'; modelName = 'MINI'; materialName = 'ЛИНА BLACK-OUT 2259 магнолия, 220 см'
              materialColor = 'бежевый'; materialColorHex = '#fae5aa'
              sizes = $_.sizes; quantity = $qty; area = 1.8
              # Сумма позиции = цена одной штуки × количество
              price = $rub
              totalPrice = [Math]::Round($rub * $qty, 2)
              priceSource = $usd; sourceSymbol = '$'; currency = '₽'
              options = @($_.options); optionsText = 'Цвет фурнитуры: Дуб'
              measure = [pscustomobject]@{ by = [string]$_.measure.by; from = [string]$_.measure.from }
              control = [pscustomobject]@{ type = [string]$_.control.type }
              mount = [pscustomobject]@{ type = [string]$_.mount.type }
              electric = [pscustomobject]@{ motor = [string]$_.electric.motor; kit = '' }
              install = [double]$_.install
              surcharge = $сурчарж
              motorSurcharge = $сурчарж
            }
          })
          $entry = [pscustomobject]@{
            id = ('AM-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
            createdAt = (Get-Date).ToString('o')
            measurer = [pscustomobject]@{ id = 'u1'; name = 'Иван Петров' }
            client = [pscustomobject]@{
              name = $in.client.name; phone = $in.client.phone; address = $in.client.address
              desiredDate = $in.client.desiredDate; comment = $in.client.comment
              isCompany = [bool]$in.client.isCompany
            }
            items = $items
            totals = [pscustomobject]@{
              totalPrice = [Math]::Round((@($items | ForEach-Object { $_.totalPrice }) | Measure-Object -Sum).Sum, 2)
              installTotal = [Math]::Round((@($items | ForEach-Object { $_.install }) | Measure-Object -Sum).Sum, 2)
              motorTotal = [Math]::Round((@($items | ForEach-Object { $_.motorSurcharge }) | Measure-Object -Sum).Sum, 2)
              grandTotal = [Math]::Round((@($items | ForEach-Object { $_.totalPrice + $_.install + $_.motorSurcharge }) | Measure-Object -Sum).Sum, 2)
              quantity = (@($items | ForEach-Object { $_.quantity }) | Measure-Object -Sum).Sum
              area = 1.8
            }
            rate = [pscustomobject]@{ text = ("{0} ₽ за 1 $ · ЦБ РФ, {1}" -f $rate.Rate, $rate.Date) }
            photos = @(@($in.photos) | ForEach-Object {
              $kind = $(if ($_.kind -eq 'requisites') { 'requisites' } else { 'opening' })
              [pscustomobject]@{ name = $_.name; kind = $kind; cid = 'p' }
            })
            mail = [pscustomobject]@{ status = 'sent'; sentAt = (Get-Date).ToString('o') }
          }
          $script:mockOrders = @(@($script:mockOrders) + $entry | Select-Object -Last 20)
          Write-Host "  -> заявка: $(@($in.items).Count) поз."
          Send-Json $context 201 @{
            id = $entry.id
            emailed = $false
            error = 'Это макет без почты: заявка сохранена, но письмо не отправлялось. Запустите настоящий сервер и заполните .env.'
            totals = $entry.totals; items = @($in.items).Count
          }
          continue
        }

        if ($path -eq '/api/orders' -and $method -eq 'GET') {
          Send-Json $context 200 @{ items = @($script:mockOrders) }
          continue
        }

        Send-Json $context 200 @{ ok = $true }
        continue
      }

      # ── Статика ────────────────────────────────────────────────────────
      $relative = [System.Uri]::UnescapeDataString($path.TrimStart('/'))
      if (-not $relative) { $relative = 'index.html' }
      $file = [System.IO.Path]::GetFullPath((Join-Path $root $relative))
      if (-not $file.StartsWith($root) -or -not (Test-Path -LiteralPath $file -PathType Leaf)) {
        $context.Response.StatusCode = 404
        $context.Response.Close()
        continue
      }
      $ext = [System.IO.Path]::GetExtension($file).ToLower()
      $bytes = [System.IO.File]::ReadAllBytes($file)
      $context.Response.ContentType = $MIME[$ext]
      $context.Response.ContentLength64 = $bytes.Length
      $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
      $context.Response.Close()
    } catch {
      Write-Host "  ! ошибка обработки $path : $($_.Exception.Message)"
      try { Send-Json $context 500 @{ error = $_.Exception.Message } } catch { }
    }
  }
} finally {
  $listener.Stop()
}