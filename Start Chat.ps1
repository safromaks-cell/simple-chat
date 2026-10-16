$ErrorActionPreference = 'Stop'
$chatDir = $PSScriptRoot
$chatUrl = 'http://127.0.0.1:8791'
$chatSupervisorNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
function Start-ChatSupervisor {
    Start-Process -FilePath $chatSupervisorNode -ArgumentList ('"' + (Join-Path $chatDir 'run-chat.cjs') + '"') -WindowStyle Hidden
}
try {
    Invoke-RestMethod "$chatUrl/api/status" -TimeoutSec 2 | Out-Null
    Start-ChatSupervisor
    Start-Process $chatUrl
    exit
} catch {}
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
if (!(Test-Path -LiteralPath $nodePath)) { throw 'Node.js not found.' }
try { Invoke-RestMethod 'http://127.0.0.1:11434/api/version' -TimeoutSec 2 | Out-Null } catch {
    Start-Process -FilePath 'ollama' -ArgumentList 'serve' -WindowStyle Hidden
    Start-Sleep -Seconds 3
}
Start-ChatSupervisor
for ($chatAttempt=0; $chatAttempt -lt 20; $chatAttempt++) {
    Start-Sleep -Milliseconds 500
    try { Invoke-RestMethod "$chatUrl/api/status" -TimeoutSec 1 | Out-Null; Start-Process $chatUrl; exit } catch {}
}
throw 'Chat server did not start. See server-error.log.'
