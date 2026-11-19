# Shows who opened the reports for one location, newest first. Admin secret is read locally, never printed.
# Usage: .\scripts\access.ps1 -BaseUrl https://payments-ledger.<your-subdomain>.workers.dev -LocationId <location id> [-Last 20] [-TimeZone 'Central Standard Time']
param(
  [Parameter(Mandatory = $true)][string]$BaseUrl,
  [Parameter(Mandatory = $true)][string]$LocationId,
  [int]$Last = 20,
  [string]$TimeZone = 'Central Standard Time'
)
$ErrorActionPreference = 'Stop'
Import-Module Microsoft.PowerShell.Security
$s = Get-Content (Join-Path $HOME '.ledger-secure\admin-secret.dat') | ConvertTo-SecureString
$secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
$r = Invoke-RestMethod -Uri "$($BaseUrl.TrimEnd('/'))/admin/access?locationId=$LocationId" -Headers @{ 'X-Admin-Secret' = $secret }
Remove-Variable secret
$tz = [TimeZoneInfo]::FindSystemTimeZoneById($TimeZone)
if (-not $r.access) { 'No visits recorded yet.'; return }
$r.access | Select-Object -First $Last | ForEach-Object {
  $u = [DateTimeOffset]::FromUnixTimeSeconds($_.at).UtcDateTime
  [pscustomobject]@{
    When   = [TimeZoneInfo]::ConvertTimeFromUtc($u, $tz).ToString('ddd MMM d h:mm tt')
    Who    = $_.email
    What   = $_.event
    Detail = $_.detail
    Where  = (@($_.city, $_.region, $_.country) | Where-Object { $_ }) -join ', '
  }
} | Format-Table -AutoSize | Out-String -Width 200
