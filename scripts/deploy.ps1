# Deploys the Worker and makes sure its generated secrets exist.
# Secret values are generated here and piped straight to Cloudflare; they are never printed.
# The admin secret is kept locally as a PowerShell SecureString; the server only gets its SHA-256.
$ErrorActionPreference = 'Stop'
Import-Module Microsoft.PowerShell.Security
Set-Location (Split-Path $PSScriptRoot -Parent)

# Cloudflare API token held locally as a SecureString (no interactive wrangler login needed).
$cfFile = Join-Path $HOME '.ledger-secure\cloudflare-token.dat'
if (Test-Path $cfFile) {
  $s = Get-Content $cfFile | ConvertTo-SecureString
  $env:CLOUDFLARE_API_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
}
# The account id comes from wrangler.toml (account_id) or from CLOUDFLARE_ACCOUNT_ID if you set it before running this.

function New-Secret([int]$bytes) {
  $b = New-Object byte[] $bytes
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  [Convert]::ToBase64String($b)
}

npx wrangler d1 migrations apply ledger --remote
if ($LASTEXITCODE -ne 0) { throw 'migrations failed' }
npx wrangler deploy
if ($LASTEXITCODE -ne 0) { throw 'deploy failed' }

$existing = (npx wrangler secret list --format json | ConvertFrom-Json).name
foreach ($name in 'SESSION_SECRET', 'ENC_KEY') {
  if ($existing -notcontains $name) {
    (New-Secret 32) | npx wrangler secret put $name | Out-Null
    Write-Host "set $name"
  }
}

$adminFile = Join-Path $HOME '.ledger-secure\admin-secret.dat'
if (-not (Test-Path $adminFile)) {
  New-Item -ItemType Directory -Force (Split-Path $adminFile) | Out-Null
  $plain = New-Secret 32
  ConvertTo-SecureString $plain -AsPlainText -Force | ConvertFrom-SecureString | Set-Content $adminFile
  $hash = -join ([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($plain)) | ForEach-Object { $_.ToString('x2') })
  $hash | npx wrangler secret put ADMIN_SECRET_SHA256 | Out-Null
  Remove-Variable plain
  Write-Host 'admin secret created and stored locally'
}
Write-Host 'deployed'
