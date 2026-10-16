# Run as administrator once to allow chat access from the local subnet.
$ErrorActionPreference='Stop'
$ruleName='Qwen Simple Chat LAN 8791'
if (!(Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
 New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8791 -RemoteAddress LocalSubnet -Profile Any | Out-Null
}
Write-Host 'Qwen Chat: local-subnet access enabled on TCP 8791.'
