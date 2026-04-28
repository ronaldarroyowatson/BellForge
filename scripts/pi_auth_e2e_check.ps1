param(
  [string]$BaseUrl = 'http://192.168.2.180:8000',
  [string]$Email = 'rarroyo-watson@tulsaacademy.org',
  [string]$Password = 'Buckm!n!ster1',
  [string]$Name = 'admin'
)

$ErrorActionPreference = 'Stop'

$base = $BaseUrl
$email = $Email
$password = $Password
$name = $Name

function Invoke-Json {
  param(
    [string]$Method,
    [string]$Url,
    [object]$Body = $null,
    [hashtable]$Headers = @{}
  )

  $params = @{
    Method      = $Method
    Uri         = $Url
    Headers     = $Headers
    ContentType = 'application/json'
  }

  if ($null -ne $Body) {
    $params.Body = ($Body | ConvertTo-Json -Depth 10 -Compress)
  }

  try {
    return Invoke-RestMethod @params
  }
  catch {
    $resp = $_.Exception.Response
    if ($resp) {
      $status = [int]$resp.StatusCode
      $raw = ''
      try {
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $raw = $reader.ReadToEnd()
      }
      catch {
        $raw = ''
      }

      $ex = New-Object System.Exception("HTTP $status $Method $Url :: $raw")
      $ex.Data['StatusCode'] = $status
      $ex.Data['RawBody'] = $raw
      throw $ex
    }

    throw
  }
}

Write-Host '--- Live Pi Auth E2E Start ---'

$loginPayload = $null
try {
  $registerPayload = Invoke-Json -Method 'POST' -Url "$base/api/auth/local/register" -Body @{
    email       = $email
    password    = $password
    name        = $name
    client_type = 'web'
  }
  $loginPayload = $registerPayload
  Write-Host 'Register result: success'
}
catch {
  $status = $_.Exception.Data['StatusCode']
  if ($status -eq 409) {
    Write-Host 'Register result: already exists; using login path'
    $loginPayload = Invoke-Json -Method 'POST' -Url "$base/api/auth/local/login" -Body @{
      email       = $email
      password    = $password
      client_type = 'web'
    }
  }
  else {
    throw
  }
}

$access = [string]$loginPayload.access_token
if (-not $access) {
  throw 'No access_token returned from register/login flow.'
}
$authHeaders = @{ Authorization = "Bearer $access" }

$verify = Invoke-Json -Method 'POST' -Url "$base/api/auth/verify" -Headers $authHeaders -Body @{ token = $access }
Write-Host "Verify: role=$($verify.role) user_id=$($verify.user_id)"

$permBefore = Invoke-Json -Method 'GET' -Url "$base/api/control/permissions/layout-edit" -Headers $authHeaders
Write-Host "Permission before promote: permitted=$($permBefore.permitted) role=$($permBefore.role) reason=$($permBefore.reason)"

$promote = Invoke-Json -Method 'POST' -Url "$base/api/control/promote" -Headers $authHeaders -Body @{ device_name = 'BellForge Device' }
Write-Host "Promote: role=$($promote.role) device_name=$($promote.device_name)"

$permAfter = Invoke-Json -Method 'GET' -Url "$base/api/control/permissions/layout-edit" -Headers $authHeaders
Write-Host "Permission after promote: permitted=$($permAfter.permitted) role=$($permAfter.role) reason=$($permAfter.reason)"

$returningLogin = Invoke-Json -Method 'POST' -Url "$base/api/auth/local/login" -Body @{
  email       = $email
  password    = $password
  client_type = 'web'
}
$returningAccess = [string]$returningLogin.access_token
if (-not $returningAccess) {
  throw 'Returning login did not return access_token.'
}
$returningHeaders = @{ Authorization = "Bearer $returningAccess" }

$returningVerify = Invoke-Json -Method 'POST' -Url "$base/api/auth/verify" -Headers $returningHeaders -Body @{ token = $returningAccess }
Write-Host "Returning verify: role=$($returningVerify.role) user_id=$($returningVerify.user_id)"

$users = Invoke-Json -Method 'GET' -Url "$base/api/auth/users" -Headers $returningHeaders
$target = $users.users | Where-Object { $_.email -eq $email } | Select-Object -First 1
if (-not $target) {
  throw "Unable to find user record for $email prior to delete."
}

$deleted = Invoke-Json -Method 'POST' -Url "$base/api/auth/users/delete" -Headers $returningHeaders -Body @{ user_id = $target.id }
Write-Host "Delete: ok=$($deleted.ok) deleted_user_id=$($deleted.deleted_user_id) remaining_active_users=$($deleted.remaining_active_users)"

$usersAfter = Invoke-Json -Method 'GET' -Url "$base/api/auth/users" -Headers $returningHeaders
$stillExists = @($usersAfter.users | Where-Object { $_.email -eq $email }).Count -gt 0
Write-Host "User exists after delete: $stillExists"
if ($stillExists) {
  throw 'User still present after delete.'
}

$postDeleteLoginFailed = $false
try {
  $null = Invoke-Json -Method 'POST' -Url "$base/api/auth/local/login" -Body @{
    email       = $email
    password    = $password
    client_type = 'web'
  }
}
catch {
  $status = $_.Exception.Data['StatusCode']
  if ($status -eq 401) {
    $postDeleteLoginFailed = $true
    Write-Host 'Post-delete login correctly failed with 401.'
  }
  else {
    throw
  }
}

if (-not $postDeleteLoginFailed) {
  throw 'Post-delete login unexpectedly succeeded.'
}

Write-Host '--- Live Pi Auth E2E Complete: SUCCESS ---'
